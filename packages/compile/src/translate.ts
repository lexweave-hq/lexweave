import type {ContentDocument} from '@lexweave/core'
import {addLlmUsage, normalizeLlmUsage, type LexweaveLlm, type LlmUsage} from './ports'

/**
 * Full-translation substrate: translate EVERY segment of the book, batch by
 * batch, so the bundle carries a complete sentence-aligned bilingual layer.
 * This is the ceiling of the weave — with it, density 1.0 (all tiers unlocked)
 * renders the whole book in the target language; anything lower is the weave
 * selecting from a complete substrate instead of a sparse extraction.
 *
 * A full-book run is long and fallible, so the pass is checkpointable: give it
 * a TranslationRunStore and every COMPLETE batch is persisted as soon as it
 * finishes, keyed by a fingerprint of (segments, glossary, batching, salt).
 * A re-run with the same fingerprint resumes instead of restarting; a changed
 * glossary changes the fingerprint, so stale renderings can never leak in.
 */

/** One character's sheet for translation consistency (name rendering + voice). */
export type BookCharacterCard = {
  /** Name as it appears in the source text. */
  name: string
  /** How the name must be rendered in the target language. */
  rendering: string
  /** Role, gender if known, speech style — whatever keeps pronouns/voice right. */
  notes: string
}

/**
 * Book-level translation brief ("story bible"): computed once per book, then
 * injected into every batch so widely separated passages agree on who is who,
 * how names are rendered, and what register the book speaks in.
 */
export type BookTranslationContext = {
  synopsis: string
  characters: BookCharacterCard[]
  /** Short notes on setting, world rules, and terminology conventions. */
  world: string[]
}

export type BookContextPayload = {
  book: {title?: string; genre: string; sourceLanguage: string; targetLanguage: string}
  /** Opening of the book, enough to identify cast and register. */
  excerpt: string
  sectionTitles: string[]
  /** Canonical renderings for the book's signature terms/names. */
  glossary: {source: string; target: string}[]
}

export type BookContextResult = BookTranslationContext & {usage?: LlmUsage}

const CONTEXT_EXCERPT_CHARS = 6000
const CONTEXT_MAX_TITLES = 80
const CONTEXT_MAX_GLOSSARY = 60

export function buildBookContextPayload(
  document: ContentDocument,
  glossary: {source: string; target: string}[]
): BookContextPayload {
  let excerpt = ''
  outer: for (const section of document.sections) {
    for (const segment of section.segments) {
      const text = segment.sourceText.trim()
      if (!text) {
        continue
      }
      excerpt = excerpt ? `${excerpt}\n\n${text}` : text
      if (excerpt.length >= CONTEXT_EXCERPT_CHARS) {
        excerpt = excerpt.slice(0, CONTEXT_EXCERPT_CHARS)
        break outer
      }
    }
  }
  const sectionTitles: string[] = []
  for (const section of document.sections) {
    if (section.title && sectionTitles.length < CONTEXT_MAX_TITLES) {
      sectionTitles.push(section.title)
    }
  }
  return {
    book: {
      title: document.title,
      genre: document.kind,
      sourceLanguage: document.sourceLanguage,
      targetLanguage: document.defaultTargetLanguage,
    },
    excerpt,
    sectionTitles,
    glossary: glossary.slice(0, CONTEXT_MAX_GLOSSARY),
  }
}

export type TranslateSegmentsPayload = {
  book: {title?: string; genre: string; sourceLanguage: string; targetLanguage: string}
  /** Canonical renderings for the book's signature terms/names — keeps every batch consistent. */
  glossary: {source: string; target: string}[]
  /** Book-level brief: synopsis, character sheet, world notes (same for every batch). */
  bookContext?: BookTranslationContext
  /** Tail of the passage just before the first segment, for cross-batch continuity. */
  context?: string
  segments: {index: number; text: string}[]
}

/**
 * Raw LLM wire result. Since prompt v3 the wire keys are terse (`i`/`t`) to
 * cut per-segment output-token overhead; the long keys are still accepted so
 * offline mocks and older adapters keep working. `normalizeWireTranslations`
 * folds both shapes into the canonical `{index, translation}` form that the
 * rest of the pipeline (and the checkpoint store) uses.
 */
export type SegmentTranslationsResult = {
  translations?: {i?: number; t?: string; index?: number; translation?: string}[]
  usage?: LlmUsage
}

export function normalizeWireTranslations(
  raw: SegmentTranslationsResult['translations']
): {index: number; translation: string}[] {
  const normalized: {index: number; translation: string}[] = []
  for (const item of raw ?? []) {
    if (!item) continue
    const index = typeof item.i === 'number' ? item.i : item.index
    const translation = typeof item.t === 'string' ? item.t : item.translation
    if (typeof index === 'number' && typeof translation === 'string') {
      normalized.push({index, translation})
    }
  }
  return normalized
}

export type SegmentTranslation = {
  sectionIdx: number
  segmentIdx: number
  sourceText: string
  translation: string
}

/** Translations of one batch, by the batch's local segment index. */
export type StoredBatchTranslations = {index: number; translation: string}[]

/** One extraction chunk's result, as persisted by the checkpoint store. */
export type StoredChunkResult = {
  units: unknown[]
  baseDensity?: number | null
  note?: string | null
}

/**
 * Persistence seam for resumable compile runs. Implement with the filesystem
 * (CLI), AsyncStorage, or a table. Batches (translation) and chunks
 * (extraction) are keyed by DIFFERENT fingerprints — each pass hashes its own
 * inputs — and only ever written on success, so whatever loads back can be
 * trusted verbatim. All methods are best-effort: a throwing store degrades to
 * a fresh run, it never fails the compile itself.
 */
export interface CompileRunStore {
  loadBatches(fingerprint: string): Promise<Map<number, StoredBatchTranslations>>
  saveBatch(
    fingerprint: string,
    batchIndex: number,
    translations: StoredBatchTranslations
  ): Promise<void>
  loadContext?(fingerprint: string): Promise<BookTranslationContext | null>
  saveContext?(fingerprint: string, context: BookTranslationContext): Promise<void>
  /** Extraction-pass checkpoints (reading-unit chunks). */
  loadChunks?(fingerprint: string): Promise<Map<number, StoredChunkResult>>
  saveChunk?(fingerprint: string, chunkIndex: number, result: StoredChunkResult): Promise<void>
}

/** @deprecated renamed — the store now checkpoints extraction too. */
export type TranslationRunStore = CompileRunStore

export type TranslationQualityFlagKind =
  | 'missing'
  | 'batch-failed'
  | 'source-echo'
  | 'length-anomaly'
  | 'glossary-miss'
  | 'marker-loss'

export type TranslationQualityFlag = {
  sectionIdx: number
  segmentIdx: number
  kind: TranslationQualityFlagKind
  detail: string
}

/**
 * Post-pass quality gate: heuristic, language-neutral checks over every
 * translated segment. Flags are a review queue, not a verdict — nothing here
 * blocks the compile, but silent damage (dropped numbers, glossary drift,
 * untranslated echoes) becomes visible and countable.
 */
export type TranslationQualityReport = {
  totalSegments: number
  translated: number
  missing: number
  failedBatches: number
  /** Full per-kind counts, even when `flags` is truncated. */
  flagCounts: Record<TranslationQualityFlagKind, number>
  flags: TranslationQualityFlag[]
  /** How many flags were dropped from `flags` to bound the report size. */
  flagsTruncated: number
}

const MAX_REPORT_FLAGS = 2000

export type TranslateDocumentOptions = {
  llm: LexweaveLlm
  glossary?: {source: string; target: string}[]
  /** Book-level brief injected into every batch (see BookTranslationContext). */
  bookContext?: BookTranslationContext
  /** Max source characters per LLM call. */
  batchChars?: number
  /** Concurrent in-flight calls. */
  concurrency?: number
  /** Checkpoint store for resumable runs (complete batches only). */
  store?: CompileRunStore
  /**
   * Cache key for `store`. Compute with translationRunFingerprint so segments,
   * glossary, and batching all participate; defaults to that when omitted.
   */
  fingerprint?: string
  /** Extra fingerprint discriminator (e.g. provider:model). */
  salt?: string
  /** Pause before the single per-batch retry (default 2500ms; 0 in tests). */
  retryDelayMs?: number
  /** Fires after each live batch; `usage` is the cumulative run usage so far. */
  onProgress?: (done: number, total: number, usage: LlmUsage) => void
}

export type TranslateDocumentResult = {
  segments: SegmentTranslation[]
  usage: LlmUsage
  /** Segments with no translation (failed batches + unrecovered echo losses). */
  missing: number
  report: TranslationQualityReport
  /** Batches restored from the store instead of re-translated. */
  cachedBatches: number
  /** Batches that errored even after retries (their segments stay source-only). */
  failedBatches: number
  /** The cache key this run used (present whenever a store or salt was given). */
  fingerprint?: string
  /** The book brief that was injected into every batch (if one was resolved). */
  bookContext?: BookTranslationContext
}

const DEFAULT_BATCH_CHARS = 2400
const DEFAULT_CONCURRENCY = 4

/**
 * Versions of the compile prompts (jobs.ts), split per pass. Mixed into the
 * checkpoint fingerprints so editing a prompt re-keys the caches — cached
 * results made under old instructions must never resume into a run with new
 * ones. Split because the two caches have very different replacement costs:
 * bumping the translation version must not discard the extraction chunk
 * cache (a full LLM read of the book), and vice versa.
 * BUMP the matching constant whenever a prompt in jobs.ts materially changes.
 */
export const LEXWEAVE_EXTRACT_PROMPT_VERSION = 2
// v3: translation wire schema slimmed to {i, t} (was {index, translation}).
export const LEXWEAVE_TRANSLATE_PROMPT_VERSION = 3

/** @deprecated Use the per-pass constants; kept for import compatibility. */
export const LEXWEAVE_PROMPT_VERSION = LEXWEAVE_EXTRACT_PROMPT_VERSION

/**
 * Stable identity of one full-translation run: the exact segment texts, the
 * glossary (order-sensitive — it is prompt content), the batching parameter,
 * and a caller salt (provider/model). Any change re-keys the cache, so resumed
 * batches are guaranteed to have been produced under identical instructions.
 */
export function translationRunFingerprint(
  document: ContentDocument,
  options: {glossary?: {source: string; target: string}[]; batchChars?: number; salt?: string} = {}
): string {
  return hashRunKey({
    v: 1,
    kind: 'translate',
    prompt: LEXWEAVE_TRANSLATE_PROMPT_VERSION,
    salt: options.salt ?? '',
    batchChars: options.batchChars ?? DEFAULT_BATCH_CHARS,
    source: document.sourceLanguage,
    target: document.defaultTargetLanguage,
    glossary: (options.glossary ?? []).map((entry) => [entry.source, entry.target]),
    texts: flattenSegments(document).map((segment) => segment.text),
  })
}

/** Stable 64-bit cache key for any JSON-serializable run identity. */
export function hashRunKey(value: unknown): string {
  const payload = JSON.stringify(value)
  return fnv1a32(payload, 0x811c9dc5) + fnv1a32(payload, 0x811c9dc5 ^ 0x9e3779b9)
}

// FNV-1a, 32-bit, seedable; two seeds concatenated give a 64-bit cache key.
// Cache keying only — no adversarial inputs, so speed beats strength here.
function fnv1a32(text: string, seed: number): string {
  let hash = seed >>> 0
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

type FlatSegment = {sectionIdx: number; segmentIdx: number; text: string}

// The ONE definition of which units a full-translation run covers. The
// fingerprint hashes exactly this list, so cache keys can never diverge from
// what actually gets batched and translated.
//
// Document segments are PARAGRAPHS (plain-text ingestion splits on blank
// lines), but the substrate must replace by SENTENCE — a whole paragraph
// flipping language at once reads as a bug to the reader. So each segment is
// further split into sentences here; every sentence is a verbatim substring
// of its paragraph, so the renderer locates it by exact match as usual.
function flattenSegments(document: ContentDocument): FlatSegment[] {
  const flat: FlatSegment[] = []
  document.sections.forEach((section, sectionIdx) => {
    section.segments.forEach((segment, segmentIdx) => {
      for (const sentence of splitSentences(segment.sourceText)) {
        flat.push({sectionIdx, segmentIdx, text: sentence})
      }
    })
  })
  return flat
}

const CJK_TERMINATORS = '。！？!?…'
const SENTENCE_TAIL = '。！？!?….．”』」》〉）)】〕"\'’'

/**
 * Verbatim sentence splitter: every returned piece is a trimmed contiguous
 * slice of the input, so each one is locatable in the book by exact substring
 * match. CJK terminators split unconditionally (with any run of closing
 * quotes/brackets absorbed); a Latin "." splits only before whitespace +
 * capital/quote, which spares decimals and most abbreviations. Splitting too
 * little just means a coarser unit — never a broken one.
 */
export function splitSentences(text: string): string[] {
  const pieces: string[] = []
  let start = 0
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    const isCjkEnd = CJK_TERMINATORS.includes(ch)
    const isLatinEnd =
      ch === '.' &&
      i + 1 < text.length &&
      /\s/.test(text[i + 1]) &&
      /[A-Z"“‘'([]/.test(text.slice(i + 1).trimStart()[0] ?? '')
    if (!isCjkEnd && !isLatinEnd) {
      continue
    }
    let end = i + 1
    while (end < text.length && SENTENCE_TAIL.includes(text[end])) {
      end += 1
    }
    pieces.push(text.slice(start, end))
    start = end
    i = end - 1
  }
  if (start < text.length) {
    pieces.push(text.slice(start))
  }
  return pieces.map((piece) => piece.trim()).filter(Boolean)
}

export async function translateDocumentSegments(
  document: ContentDocument,
  options: TranslateDocumentOptions
): Promise<TranslateDocumentResult> {
  const translate = options.llm.translateSegments?.bind(options.llm)
  if (!translate) {
    throw new Error('this LLM adapter does not implement translateSegments')
  }

  const flat = flattenSegments(document)

  // Consecutive segments per batch so each call sees a coherent passage.
  const batchChars = options.batchChars ?? DEFAULT_BATCH_CHARS
  const batches: FlatSegment[][] = []
  const batchStart: number[] = [] // batch index → offset of its first segment in `flat`
  let current: FlatSegment[] = []
  let currentChars = 0
  flat.forEach((item, flatIdx) => {
    if (current.length > 0 && currentChars + item.text.length > batchChars) {
      batches.push(current)
      current = []
      currentChars = 0
    }
    if (current.length === 0) {
      batchStart.push(flatIdx)
    }
    current.push(item)
    currentChars += item.text.length
  })
  if (current.length > 0) {
    batches.push(current)
  }

  const book = {
    title: document.title,
    genre: document.kind,
    sourceLanguage: document.sourceLanguage,
    targetLanguage: document.defaultTargetLanguage,
  }
  const glossary = options.glossary ?? []

  const fingerprint =
    options.fingerprint ??
    (options.store || options.salt != null
      ? translationRunFingerprint(document, {glossary, batchChars, salt: options.salt})
      : undefined)

  // Tsukuyomi-style context engine, compile-time form: ONE brief per book
  // (synopsis + character sheet + world notes), injected into every batch. It
  // is cached under the run fingerprint so a resumed run reuses the SAME brief
  // its cached batches were translated with; it never blocks the run — a
  // failed design call just translates without a brief.
  let bookContext = options.bookContext
  let briefUsage = normalizeLlmUsage(null)
  if (!bookContext && options.llm.designTranslationContext) {
    if (options.store?.loadContext && fingerprint) {
      try {
        bookContext = (await options.store.loadContext(fingerprint)) ?? undefined
      } catch {
        bookContext = undefined
      }
    }
    if (!bookContext) {
      try {
        const brief = await options.llm.designTranslationContext(
          buildBookContextPayload(document, glossary)
        )
        briefUsage = normalizeLlmUsage(brief.usage)
        bookContext = {
          synopsis: brief.synopsis ?? '',
          characters: Array.isArray(brief.characters) ? brief.characters : [],
          world: Array.isArray(brief.world) ? brief.world : [],
        }
        if (options.store?.saveContext && fingerprint) {
          try {
            await options.store.saveContext(fingerprint, bookContext)
          } catch {
            // Persistence is best-effort only.
          }
        }
      } catch {
        bookContext = undefined
      }
    }
  }

  // Resume: restore previously completed batches. Only batches whose stored
  // translations cover EVERY local index are trusted; anything else re-runs.
  const results: ({translations: StoredBatchTranslations} | undefined)[] = new Array(
    batches.length
  )
  let cachedBatches = 0
  if (options.store && fingerprint) {
    let stored: Map<number, StoredBatchTranslations>
    try {
      stored = await options.store.loadBatches(fingerprint)
    } catch {
      stored = new Map()
    }
    for (const [batchIndex, translations] of stored) {
      const batch = batches[batchIndex]
      if (!batch || !Array.isArray(translations)) {
        continue
      }
      const byIndex = new Map<number, string>()
      for (const item of translations) {
        if (item && typeof item.index === 'number' && typeof item.translation === 'string') {
          byIndex.set(item.index, item.translation)
        }
      }
      const complete = batch.every((_, localIndex) => (byIndex.get(localIndex) ?? '').trim())
      if (complete) {
        results[batchIndex] = {translations}
        cachedBatches += 1
      }
    }
  }

  let usage = briefUsage
  let done = cachedBatches
  let cursor = 0
  const failed = new Set<number>()
  let lastError: unknown

  // Source tail immediately before flat[flatIdx], for cross-batch/retry continuity.
  const tailBefore = (flatIdx: number): string | undefined => {
    if (flatIdx <= 0) {
      return undefined
    }
    return flat
      .slice(Math.max(0, flatIdx - 2), flatIdx)
      .map((segment) => segment.text)
      .join('')
      .slice(-300)
  }

  const callBatch = async (
    segments: {index: number; text: string}[],
    context: string | undefined
  ): Promise<{translations: StoredBatchTranslations; usage?: LlmUsage} | null> => {
    const payload: TranslateSegmentsPayload = {
      book,
      glossary,
      bookContext,
      context,
      segments,
    }
    // Exponential backoff, 6 attempts, capped at 60s: a TPM rate-limit wave
    // lasts a full minute, so the ladder must be able to wait out a whole
    // window rather than fail healthy batches into the report over throughput.
    const attempts = 6
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const result = await translate(payload)
        usage = addLlmUsage(usage, result.usage)
        return {translations: normalizeWireTranslations(result.translations), usage: result.usage}
      } catch (error) {
        lastError = error
        if (attempt < attempts - 1) {
          await new Promise((resolve) =>
            setTimeout(resolve, Math.min(60_000, (options.retryDelayMs ?? 2500) * 3 ** attempt))
          )
        }
      }
    }
    return null
  }

  const runBatch = async (index: number): Promise<void> => {
    const batch = batches[index]
    const result = await callBatch(
      batch.map((segment, localIndex) => ({index: localIndex, text: segment.text})),
      tailBefore(batchStart[index])
    )
    if (!result) {
      failed.add(index)
      return
    }

    const byIndex = new Map<number, string>()
    for (const item of result.translations ?? []) {
      const translation = item?.translation?.trim()
      if (translation && typeof item.index === 'number') {
        byIndex.set(item.index, translation)
      }
    }

    // Echo-loss recovery: re-ask ONLY for the segments the model skipped, as a
    // small standalone batch, before recording the result. Failed retries are
    // fine — those segments just stay missing and get flagged.
    const missingLocals: number[] = []
    batch.forEach((_, localIndex) => {
      if (!byIndex.has(localIndex)) {
        missingLocals.push(localIndex)
      }
    })
    if (missingLocals.length > 0) {
      const retry = await callBatch(
        missingLocals.map((localIndex, retryIndex) => ({
          index: retryIndex,
          text: batch[localIndex].text,
        })),
        tailBefore(batchStart[index] + missingLocals[0])
      )
      for (const item of retry?.translations ?? []) {
        const translation = item?.translation?.trim()
        const localIndex = missingLocals[item?.index ?? -1]
        if (translation && localIndex != null) {
          byIndex.set(localIndex, translation)
        }
      }
    }

    const merged: StoredBatchTranslations = []
    byIndex.forEach((translation, localIndex) => {
      merged.push({index: localIndex, translation})
    })
    results[index] = {translations: merged}

    // Checkpoint COMPLETE batches only; a partial batch re-runs whole next time.
    const complete = batch.every((_, localIndex) => byIndex.has(localIndex))
    if (options.store && fingerprint && complete) {
      try {
        await options.store.saveBatch(fingerprint, index, merged)
      } catch {
        // Persistence is best-effort; the run itself must not fail on it.
      }
    }
  }

  const worker = async () => {
    while (cursor < batches.length) {
      const index = cursor
      cursor += 1
      if (results[index]) {
        continue // restored from the store
      }
      await runBatch(index)
      done += 1
      options.onProgress?.(done, batches.length, usage)
    }
  }
  // Surface restored progress immediately — a fully-cached resume would
  // otherwise complete without a single progress tick and look stalled.
  if (cachedBatches > 0) {
    options.onProgress?.(done, batches.length, usage)
  }
  const concurrency = Math.max(1, Math.min(options.concurrency ?? DEFAULT_CONCURRENCY, batches.length))
  await Promise.all(Array.from({length: concurrency}, worker))

  // Every batch failing is a configuration problem (bad key, dead endpoint),
  // not translation noise — surface it instead of emitting an empty substrate.
  if (batches.length > 0 && failed.size === batches.length) {
    const reason = lastError instanceof Error ? lastError.message : String(lastError ?? 'unknown error')
    throw new Error(`full translation failed: all ${batches.length} batches errored (${reason})`)
  }

  // Pre-lower the glossary once — the quality gate compares it against every
  // segment, and 100k segments × 120 entries must not re-lowercase each time.
  const glossaryChecks = glossary
    .filter((entry) => entry.source && entry.target)
    .map((entry) => ({
      source: entry.source,
      target: entry.target,
      loweredTarget: entry.target.toLowerCase(),
    }))

  const segments: SegmentTranslation[] = []
  const flagCounts: Record<TranslationQualityFlagKind, number> = {
    missing: 0,
    'batch-failed': 0,
    'source-echo': 0,
    'length-anomaly': 0,
    'glossary-miss': 0,
    'marker-loss': 0,
  }
  const flags: TranslationQualityFlag[] = []
  let flagsTruncated = 0
  const addFlag = (flag: TranslationQualityFlag) => {
    flagCounts[flag.kind] += 1
    if (flags.length < MAX_REPORT_FLAGS) {
      flags.push(flag)
    } else {
      flagsTruncated += 1
    }
  }

  let missing = 0
  batches.forEach((batch, index) => {
    if (failed.has(index)) {
      missing += batch.length
      for (const segment of batch) {
        addFlag({
          sectionIdx: segment.sectionIdx,
          segmentIdx: segment.segmentIdx,
          kind: 'batch-failed',
          detail: `batch ${index} errored after retries`,
        })
      }
      return
    }
    const byIndex = new Map(
      (results[index]?.translations ?? []).map((item) => [item.index, item.translation])
    )
    batch.forEach((segment, localIndex) => {
      const translation = byIndex.get(localIndex)?.trim()
      if (!translation) {
        missing += 1
        addFlag({
          sectionIdx: segment.sectionIdx,
          segmentIdx: segment.segmentIdx,
          kind: 'missing',
          detail: 'model never echoed this segment back',
        })
        return
      }
      segments.push({
        sectionIdx: segment.sectionIdx,
        segmentIdx: segment.segmentIdx,
        sourceText: segment.text,
        translation,
      })
      for (const issue of segmentQualityIssues(segment.text, translation, glossaryChecks)) {
        addFlag({
          sectionIdx: segment.sectionIdx,
          segmentIdx: segment.segmentIdx,
          kind: issue.kind,
          detail: issue.detail,
        })
      }
    })
  })

  const report: TranslationQualityReport = {
    totalSegments: flat.length,
    translated: segments.length,
    missing,
    failedBatches: failed.size,
    flagCounts,
    flags,
    flagsTruncated,
  }

  return {
    segments,
    usage,
    missing,
    report,
    cachedBatches,
    failedBatches: failed.size,
    fingerprint,
    bookContext,
  }
}

// Loose on purpose: every check here tolerates legitimate translation freedom
// (inflection, reordering, short segments) and only fires on strong signals.
function segmentQualityIssues(
  source: string,
  translation: string,
  glossary: {source: string; target: string; loweredTarget: string}[]
): {kind: TranslationQualityFlagKind; detail: string}[] {
  const issues: {kind: TranslationQualityFlagKind; detail: string}[] = []

  if (translation.trim() === source.trim()) {
    issues.push({kind: 'source-echo', detail: 'translation is identical to the source'})
  }

  if (source.length >= 20) {
    const ratio = translation.length / source.length
    if (ratio < 0.15 || ratio > 10) {
      issues.push({kind: 'length-anomaly', detail: `translation/source length ratio ${ratio.toFixed(2)}`})
    }
  }

  let loweredTranslation: string | null = null
  for (const entry of glossary) {
    if (!source.includes(entry.source)) {
      continue
    }
    loweredTranslation = loweredTranslation ?? translation.toLowerCase()
    if (!loweredTranslation.includes(entry.loweredTarget)) {
      issues.push({
        kind: 'glossary-miss',
        detail: `"${entry.source}" not rendered with glossary form "${entry.target}"`,
      })
    }
  }

  for (const marker of extractMarkers(source)) {
    if (!translation.includes(marker)) {
      issues.push({kind: 'marker-loss', detail: `"${marker}" from the source is absent`})
    }
  }

  return issues
}

// Content that must survive translation verbatim: multi-digit ASCII numbers
// (years, sums) and template/markup tokens. Single digits and native-language
// numerals are excluded — those legitimately become words.
function extractMarkers(text: string): string[] {
  const markers = new Set<string>()
  for (const match of text.matchAll(/\d{2,}/g)) {
    markers.add(match[0])
  }
  for (const match of text.matchAll(/\{[^{}]{1,40}\}|<[^<>]{1,40}>/g)) {
    markers.add(match[0])
  }
  return [...markers]
}
