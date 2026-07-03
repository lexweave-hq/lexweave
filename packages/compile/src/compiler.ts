import {
  createDocumentFromPlainText,
  BOOK_BUNDLE_FORMAT,
  BOOK_BUNDLE_VERSION,
  type BookBundle,
  type ContentDocument,
  type ContentKind,
} from '@lexweave/core'
import {addLlmUsage, normalizeLlmUsage, type LexweaveLlm, type LlmUsage} from './ports'
import {translateDocumentSegments} from './translate'
import {
  buildChunkPayload,
  chunkDocument,
  mapReadingUnitsToAssets,
  type ReadingUnit,
} from './units'

export const DEFAULT_PRODUCER = 'lexweave-compile@1'
const DEFAULT_CHUNK_CHARS = 18000

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
  /** Concurrent in-flight calls for the full-translation pass (default 4). */
  translationConcurrency?: number
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
  const chunks = chunkDocument(document, options.chunkChars ?? DEFAULT_CHUNK_CHARS)

  const units: ReadingUnit[] = []
  let densityTotal = 0
  let densityCount = 0
  let noteSample: string | null | undefined
  let usage = normalizeLlmUsage(null)

  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index]
    const startedAt = Date.now()
    const result = await options.llm.extractReadingUnits(buildChunkPayload(document, chunk.chapters))
    if (Array.isArray(result.units)) {
      units.push(...result.units)
    }
    if (typeof result.baseDensity === 'number') {
      densityTotal += result.baseDensity
      densityCount += 1
    }
    noteSample = noteSample ?? result.note
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

  // Full-translation substrate: every segment becomes a sentence-tier unit at
  // salience 'common', translated with the extracted signature vocabulary as a
  // consistency glossary. Signature units stay the FRONT of the weave; the
  // substrate is its ceiling (density 1.0 + unlocked tiers = whole book in the
  // target language).
  let translationMissing: number | undefined
  if (options.fullTranslation) {
    const glossary = buildConsistencyGlossary(units)
    const translated = await translateDocumentSegments(document, {
      llm: options.llm,
      glossary,
      concurrency: options.translationConcurrency,
      onProgress: (done, total) => options.onTranslateProgress?.(done, total),
    })
    usage = addLlmUsage(usage, translated.usage)
    translationMissing = translated.missing
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
