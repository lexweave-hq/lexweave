import {
  createDocumentFromPlainText,
  BOOK_BUNDLE_FORMAT,
  BOOK_BUNDLE_VERSION,
  type BookBundle,
  type ContentDocument,
  type ContentKind,
} from '@lexweave/core'
import {addLlmUsage, normalizeLlmUsage, type LexweaveLlm, type LlmUsage} from './ports'
import {
  hashRunKey,
  LEXWEAVE_EXTRACT_PROMPT_VERSION,
  translateDocumentSegments,
  type BookTranslationContext,
  type CompileRunStore,
  type TranslationQualityReport,
} from './translate'
import {
  buildChunkPayload,
  chunkDocument,
  mapReadingUnitsToAssets,
  type ReadingUnit,
  type ReadingUnitsResult,
} from './units'

export const DEFAULT_PRODUCER = 'lexweave-compile@1'
// Large-book compile measurements: a model returns ~25 units per extraction
// call REGARDLESS of chunk size, so smaller chunks = more calls = a bigger
// unit pool for the same book (18k→8k roughly doubled words+phrases at ~equal
// token cost). 8k balances yield against per-call overhead and serial latency.
const DEFAULT_CHUNK_CHARS = 8000

export type CompileProgress = {
  chunkIndex: number
  chunkCount: number
  sectionStart: number
  sectionEnd: number
  units: number
  usage: LlmUsage
  elapsedMs: number
}

export type CompileOptions = {
  llm: LexweaveLlm
  /** Idempotency tag stamped on the bundle + annotations. Bump on prompt changes. */
  producer?: string
  /** Max characters of book text per LLM call. */
  chunkChars?: number
  onProgress?: (progress: CompileProgress) => void
  /**
   * Full-translation substrate: additionally translate EVERY segment
   * (glossary-consistent, batched) and carry each one as a sentence-tier unit,
   * so density 1.0 with all tiers unlocked renders the whole book in the
   * target language. Costs O(book) LLM tokens — the extraction passes alone
   * are output-bound and much cheaper.
   */
  fullTranslation?: boolean
  /** Concurrent in-flight extraction chunk calls (default 4). */
  extractionConcurrency?: number
  /** Concurrent in-flight calls for the full-translation pass (default 4). */
  translationConcurrency?: number
  /**
   * Checkpoint store for the whole compile: extraction chunks, translation
   * batches, and the book brief all persist as they finish, so an interrupted
   * run resumes instead of restarting. Each pass is keyed by a fingerprint of
   * its own inputs (chunk texts + producer / segments + glossary + salt), so a
   * changed prompt or glossary can never serve stale cached results — and a
   * resumed run reuses the SAME extraction, keeping the downstream glossary
   * (and therefore the translation fingerprint) stable across re-runs.
   */
  runStore?: CompileRunStore
  /** Extra fingerprint discriminator for the store (e.g. "anthropic:claude-sonnet-5"). */
  runSalt?: string
  /**
   * Separate discriminator for the extraction pass (defaults to runSalt).
   * Lets the two passes run different models — switching the translation
   * model re-keys only the batches, keeping the extraction chunks cached.
   */
  extractionSalt?: string
  /** Pause before each single per-call retry (default 2500ms; 0 in tests). */
  retryDelayMs?: number
  onTranslateProgress?: (done: number, total: number) => void
}

export type CompileResult = {
  bundle: BookBundle
  usage: LlmUsage
  /** Units whose verbatim span never matched the book text (model drift). */
  droppedUnlocatable: number
  chunkCount: number
  /** Full-translation pass only: segments the model failed to echo back. */
  translationMissing?: number
  /** Full-translation pass only: post-pass quality gate over every segment. */
  translationReport?: TranslationQualityReport
  /** Full-translation pass only: batches served from the checkpoint store. */
  translationCachedBatches?: number
  /** Full-translation pass only: the book brief injected into every batch. */
  translationContext?: BookTranslationContext
}

/**
 * Compile ONE document into its portable Learning Edition bundle:
 * chunk → extract reading units per chunk (the only required LLM job) →
 * verbatim-scan the whole book for real frequencies → map to bundle assets.
 * Compile once; render for every reader at read time with zero LLM calls.
 */
export async function compileDocument(
  document: ContentDocument,
  options: CompileOptions
): Promise<CompileResult> {
  const producer = options.producer ?? DEFAULT_PRODUCER
  const chunkChars = options.chunkChars ?? DEFAULT_CHUNK_CHARS
  const chunks = chunkDocument(document, chunkChars)
  const store = options.runStore

  // Extraction checkpoint: cached chunks make re-runs deterministic, which is
  // what keeps the downstream glossary — and therefore the translation
  // fingerprint — stable, so translation batches survive an interrupt too.
  const extractionFingerprint = hashRunKey({
    v: 1,
    kind: 'extract',
    prompt: LEXWEAVE_EXTRACT_PROMPT_VERSION,
    salt: options.extractionSalt ?? options.runSalt ?? '',
    producer,
    chunkChars,
    source: document.sourceLanguage,
    target: document.defaultTargetLanguage,
    texts: chunks.map((chunk) => chunk.chapters.map((chapter) => chapter.text)),
  })
  let cachedChunks: Map<number, {units: unknown[]; baseDensity?: number | null; note?: string | null}>
  try {
    cachedChunks = (await store?.loadChunks?.(extractionFingerprint)) ?? new Map()
  } catch {
    cachedChunks = new Map()
  }

  const units: ReadingUnit[] = []
  let densityTotal = 0
  let densityCount = 0
  let noteSample: string | null | undefined
  let usage = normalizeLlmUsage(null)

  // Extraction worker pool: chunks run concurrently (a 千万字 book is ~1000
  // chunks — serial extraction alone would take hours), then aggregate IN
  // CHUNK ORDER so the unit inventory stays deterministic.
  const chunkResults: (ReadingUnitsResult | undefined)[] = new Array(chunks.length)
  let chunkCursor = 0
  const runChunk = async (index: number): Promise<void> => {
    const chunk = chunks[index]
    const startedAt = Date.now()
    const cached = cachedChunks.get(index)
    let result: ReadingUnitsResult
    if (cached && Array.isArray(cached.units)) {
      result = {
        units: cached.units as ReadingUnit[],
        baseDensity: cached.baseDensity ?? undefined,
        note: cached.note ?? undefined,
      }
    } else {
      const payload = buildChunkPayload(document, chunk.chapters)
      result = await callWithRetry(
        () => options.llm.extractReadingUnits(payload),
        options.retryDelayMs
      )
      if (store?.saveChunk && Array.isArray(result.units)) {
        try {
          await store.saveChunk(extractionFingerprint, index, {
            units: result.units,
            baseDensity: result.baseDensity ?? null,
            note: result.note ?? null,
          })
        } catch {
          // Persistence is best-effort; the run itself must not fail on it.
        }
      }
    }
    chunkResults[index] = result
    usage = addLlmUsage(usage, result.usage)
    options.onProgress?.({
      chunkIndex: index,
      chunkCount: chunks.length,
      sectionStart: chunk.sectionStart,
      sectionEnd: chunk.sectionEnd,
      units: result.units?.length ?? 0,
      usage: normalizeLlmUsage(result.usage),
      elapsedMs: Date.now() - startedAt,
    })
  }
  const extractionWorker = async () => {
    while (chunkCursor < chunks.length) {
      const index = chunkCursor
      chunkCursor += 1
      await runChunk(index)
    }
  }
  const extractionConcurrency = Math.max(
    1,
    Math.min(options.extractionConcurrency ?? 4, Math.max(1, chunks.length))
  )
  await Promise.all(Array.from({length: extractionConcurrency}, extractionWorker))

  for (const result of chunkResults) {
    if (!result) {
      continue
    }
    if (Array.isArray(result.units)) {
      units.push(...result.units)
    }
    if (typeof result.baseDensity === 'number') {
      densityTotal += result.baseDensity
      densityCount += 1
    }
    noteSample = noteSample ?? result.note
  }

  // Full-translation substrate: every segment becomes a sentence-tier unit at
  // salience 'common', translated with the extracted signature vocabulary as a
  // consistency glossary. Signature units stay the FRONT of the weave; the
  // substrate is its ceiling (density 1.0 + unlocked tiers = whole book in the
  // target language).
  let translationMissing: number | undefined
  let translationReport: TranslationQualityReport | undefined
  let translationCachedBatches: number | undefined
  let translationContext: BookTranslationContext | undefined
  if (options.fullTranslation) {
    const glossary = buildConsistencyGlossary(units)
    const translated = await translateDocumentSegments(document, {
      llm: options.llm,
      glossary,
      store: options.runStore,
      salt: options.runSalt,
      retryDelayMs: options.retryDelayMs,
      concurrency: options.translationConcurrency,
      onProgress: (done, total) => options.onTranslateProgress?.(done, total),
    })
    usage = addLlmUsage(usage, translated.usage)
    translationMissing = translated.missing
    translationReport = translated.report
    translationCachedBatches = translated.cachedBatches
    translationContext = translated.bookContext
    for (const segment of translated.segments) {
      units.push({
        span: segment.sourceText,
        evidence: segment.sourceText,
        translation: segment.translation,
        tier: 'sentence',
        keepSource: false,
        risk: 'low',
        plotCriticality: 'low',
        reason: 'full-translation substrate',
        salience: 'common',
      })
    }
  }

  // Cross-chunk repeats of one span collapse in the map step (dedup by verbatim
  // span + real full-book frequency from the scan).
  const assets = await mapReadingUnitsToAssets(
    document,
    {
      units,
      baseDensity: densityCount > 0 ? densityTotal / densityCount : 0.5,
      note:
        noteSample ??
        (chunks.length > 1
          ? `Full-book reading-unit analysis merged from ${chunks.length} chunks.`
          : undefined),
    },
    {producer}
  )

  let segmentCount = 0
  let sourceCharCount = 0
  for (const section of document.sections) {
    for (const segment of section.segments) {
      segmentCount += 1
      sourceCharCount += segment.sourceText.length
    }
  }

  const bundle: BookBundle = {
    format: BOOK_BUNDLE_FORMAT,
    version: BOOK_BUNDLE_VERSION,
    producer,
    book: {
      contentHash: document.id || undefined,
      title: document.title,
      kind: document.kind,
      sourceLanguage: document.sourceLanguage,
      targetLanguage: document.defaultTargetLanguage,
      sourceCharCount,
      sectionCount: document.sections.length,
      segmentCount,
    },
    strategy: assets.strategy,
    candidates: assets.candidates,
    occurrences: assets.occurrences,
    annotations: assets.annotations,
  }

  return {
    bundle,
    usage,
    droppedUnlocatable: assets.droppedUnlocatable,
    chunkCount: chunks.length,
    translationMissing,
    translationReport,
    translationCachedBatches,
    translationContext,
  }
}

// The extracted units double as the translation pass's consistency glossary:
// names keep their canonical rendering, signature vocabulary its canonical
// translation, so 灵石 is "spirit stone" in every translated sentence too.
function buildConsistencyGlossary(units: ReadingUnit[]): {source: string; target: string}[] {
  const seen = new Set<string>()
  const glossary: {source: string; target: string}[] = []
  for (const unit of units) {
    const source = unit.span?.trim()
    const target = unit.translation?.trim()
    if (!source || !target || unit.tier === 'sentence' || seen.has(source)) {
      continue
    }
    seen.add(source)
    glossary.push({source, target})
    if (glossary.length >= 120) {
      break
    }
  }
  return glossary
}

// Exponential backoff, 6 attempts, capped at 60s: a TPM rate-limit wave lasts
// a full minute, so the retry ladder must be able to WAIT OUT a whole window
// (2.5s→7.5s→22.5s→60s→60s ≈ 2.5min of patience) rather than fail a healthy
// run over throughput. A hard extraction failure aborts the compile
// (completed chunks are checkpointed, so an aborted run still resumes).
async function callWithRetry<T>(call: () => Promise<T>, baseDelayMs = 2500): Promise<T> {
  const attempts = 6
  let lastError: unknown
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await call()
    } catch (error) {
      lastError = error
      if (attempt < attempts - 1) {
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(60_000, baseDelayMs * 3 ** attempt))
        )
      }
    }
  }
  throw lastError
}

export type CompileTextInput = {
  id?: string
  rawText: string
  title?: string
  kind?: ContentKind
  sourceLanguage: string
  targetLanguage: string
}

/** Convenience wrapper: plain text in (chapters auto-detected), bundle out. */
export async function compileText(
  input: CompileTextInput,
  options: CompileOptions
): Promise<CompileResult> {
  const document = createDocumentFromPlainText({
    id: input.id ?? 'book',
    rawText: input.rawText,
    title: input.title,
    kind: input.kind ?? 'novel',
    sourceLanguage: input.sourceLanguage,
    defaultTargetLanguage: input.targetLanguage,
  })
  return compileDocument(document, options)
}
