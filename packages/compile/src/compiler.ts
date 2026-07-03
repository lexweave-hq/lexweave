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
}

export type CompileResult = {
  bundle: BookBundle
  usage: LlmUsage
  /** Units whose verbatim span never matched the book text (model drift). */
  droppedUnlocatable: number
  chunkCount: number
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
  }
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
