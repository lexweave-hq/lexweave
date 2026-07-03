import type {ContentDocument} from '@lexweave/core'
import {addLlmUsage, normalizeLlmUsage, type LexweaveLlm, type LlmUsage} from './ports'

/**
 * Full-translation substrate: translate EVERY segment of the book, batch by
 * batch, so the bundle carries a complete sentence-aligned bilingual layer.
 * This is the ceiling of the weave — with it, density 1.0 (all tiers unlocked)
 * renders the whole book in the target language; anything lower is the weave
 * selecting from a complete substrate instead of a sparse extraction.
 */

export type TranslateSegmentsPayload = {
  book: {title?: string; genre: string; sourceLanguage: string; targetLanguage: string}
  /** Canonical renderings for the book's signature terms/names — keeps every batch consistent. */
  glossary: {source: string; target: string}[]
  /** Tail of the passage just before the first segment, for cross-batch continuity. */
  context?: string
  segments: {index: number; text: string}[]
}

export type SegmentTranslationsResult = {
  translations?: {index: number; translation: string}[]
  usage?: LlmUsage
}

export type SegmentTranslation = {
  sectionIdx: number
  segmentIdx: number
  sourceText: string
  translation: string
}

export type TranslateDocumentOptions = {
  llm: LexweaveLlm
  glossary?: {source: string; target: string}[]
  /** Max source characters per LLM call. */
  batchChars?: number
  /** Concurrent in-flight calls. */
  concurrency?: number
  onProgress?: (done: number, total: number, usage: LlmUsage) => void
}

export type TranslateDocumentResult = {
  segments: SegmentTranslation[]
  usage: LlmUsage
  /** Segments the model failed to echo back (they stay source-only). */
  missing: number
}

const DEFAULT_BATCH_CHARS = 2400
const DEFAULT_CONCURRENCY = 4

export async function translateDocumentSegments(
  document: ContentDocument,
  options: TranslateDocumentOptions
): Promise<TranslateDocumentResult> {
  const translate = options.llm.translateSegments?.bind(options.llm)
  if (!translate) {
    throw new Error('this LLM adapter does not implement translateSegments')
  }

  type FlatSegment = {sectionIdx: number; segmentIdx: number; text: string}
  const flat: FlatSegment[] = []
  document.sections.forEach((section, sectionIdx) => {
    section.segments.forEach((segment, segmentIdx) => {
      if (segment.sourceText.trim()) {
        flat.push({sectionIdx, segmentIdx, text: segment.sourceText})
      }
    })
  })

  // Consecutive segments per batch so each call sees a coherent passage.
  const batchChars = options.batchChars ?? DEFAULT_BATCH_CHARS
  const batches: FlatSegment[][] = []
  let current: FlatSegment[] = []
  let currentChars = 0
  for (const item of flat) {
    if (current.length > 0 && currentChars + item.text.length > batchChars) {
      batches.push(current)
      current = []
      currentChars = 0
    }
    current.push(item)
    currentChars += item.text.length
  }
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

  const results: (SegmentTranslationsResult | undefined)[] = new Array(batches.length)
  let usage = normalizeLlmUsage(null)
  let done = 0
  let cursor = 0

  const runBatch = async (index: number): Promise<SegmentTranslationsResult> => {
    const batch = batches[index]
    const previous = index > 0 ? batches[index - 1] : null
    const payload: TranslateSegmentsPayload = {
      book,
      glossary,
      context: previous
        ? previous
            .slice(-2)
            .map((segment) => segment.text)
            .join('')
            .slice(-300)
        : undefined,
      segments: batch.map((segment, localIndex) => ({index: localIndex, text: segment.text})),
    }
    try {
      return await translate(payload)
    } catch {
      // One retry with a short breather: full-book runs hit transient 429/5xx.
      await new Promise((resolve) => setTimeout(resolve, 2500))
      return translate(payload)
    }
  }

  const worker = async () => {
    while (cursor < batches.length) {
      const index = cursor
      cursor += 1
      const result = await runBatch(index)
      results[index] = result
      usage = addLlmUsage(usage, result.usage)
      done += 1
      options.onProgress?.(done, batches.length, normalizeLlmUsage(result.usage))
    }
  }
  const concurrency = Math.max(1, Math.min(options.concurrency ?? DEFAULT_CONCURRENCY, batches.length))
  await Promise.all(Array.from({length: concurrency}, worker))

  const segments: SegmentTranslation[] = []
  let missing = 0
  batches.forEach((batch, index) => {
    const byIndex = new Map(
      (results[index]?.translations ?? []).map((item) => [item.index, item.translation])
    )
    batch.forEach((segment, localIndex) => {
      const translation = byIndex.get(localIndex)?.trim()
      if (translation) {
        segments.push({
          sectionIdx: segment.sectionIdx,
          segmentIdx: segment.segmentIdx,
          sourceText: segment.text,
          translation,
        })
      } else {
        missing += 1
      }
    })
  })

  return {segments, usage, missing}
}
