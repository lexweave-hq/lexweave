import type {
  BookStrategy,
  ContentDocument,
  ReplacementCandidate,
  UnitAnnotation,
  UnitCandidate,
  UnitOccurrence,
} from '@lexweave/core'
import type {LlmUsage} from './ports'

/**
 * One learnable unit at any tier. `span`/`evidence` are copied VERBATIM from the
 * book so the client can locate the unit by exact substring match — the same
 * mechanism works for a single word and for a whole sentence, which is why the
 * sentence tier needs no templates or span alignment.
 */
export type ReadingUnit = {
  span: string
  evidence: string
  translation: string
  tier: 'word' | 'phrase' | 'sentence'
  keepSource: boolean
  risk: 'low' | 'medium' | 'high'
  plotCriticality: 'low' | 'medium' | 'high'
  reason?: string | null
}

export type ReadingUnitsResult = {
  units?: ReadingUnit[]
  baseDensity?: number
  note?: string | null
  model?: string
  usage?: LlmUsage
}

export type PayloadChapter = {
  chapterId: string
  sectionIdx: number
  title?: string | null
  text: string
}

export type ReadingUnitsPayload = {
  book: {
    title?: string
    genre: string
    sourceLanguage: string
    targetLanguage: string
  }
  chapters: PayloadChapter[]
}

export type DocumentChunk = {
  chapters: PayloadChapter[]
  sectionStart: number
  sectionEnd: number
}

export function buildChunkPayload(
  document: ContentDocument,
  chapters: PayloadChapter[]
): ReadingUnitsPayload {
  return {
    book: {
      title: document.title,
      genre: document.kind,
      sourceLanguage: document.sourceLanguage,
      targetLanguage: document.defaultTargetLanguage,
    },
    chapters,
  }
}

/** Pack a document's sections into ≤maxChars text chunks for per-chunk LLM calls. */
export function chunkDocument(document: ContentDocument, maxChars: number): DocumentChunk[] {
  const chunks: DocumentChunk[] = []
  let text = ''
  let sectionStart: number | null = null
  let sectionEnd: number | null = null

  const flush = () => {
    const trimmed = text.trim()
    if (!trimmed || sectionStart === null || sectionEnd === null) {
      return
    }
    chunks.push({
      sectionStart,
      sectionEnd,
      chapters: [
        {
          chapterId: `${document.id}:book-world-chunk:${chunks.length + 1}`,
          sectionIdx: sectionStart,
          title: `Sections ${sectionStart}-${sectionEnd}`,
          text: trimmed,
        },
      ],
    })
    text = ''
    sectionStart = null
    sectionEnd = null
  }

  for (const section of document.sections) {
    for (const segment of section.segments) {
      const segmentText = segment.sourceText.trim()
      if (!segmentText) {
        continue
      }
      const nextText = text ? `${text}\n\n${segmentText}` : segmentText
      if (text && nextText.length > maxChars) {
        flush()
      }
      text = text ? `${text}\n\n${segmentText}` : segmentText
      sectionStart = sectionStart ?? section.order
      sectionEnd = section.order
    }
  }
  flush()
  return chunks
}

export type UnitOccurrenceStat = {
  /** Non-overlapping occurrences across the whole book (0 ⇒ span not found verbatim). */
  frequency: number
  /** Share of sections containing the span (0..1). */
  dispersion: number
  /** First occurrence — the representative row stored in `occurrences`. */
  first: null | {
    sectionIdx: number
    segmentIdx: number
    start: number
    end: number
    before: string
    after: string
  }
}

// Cooperative-yield cadence for the scanner: hand the JS loop back every N
// segments so a huge scan never freezes a single-threaded host (RN Hermes).
const SCAN_YIELD_EVERY_SEGMENTS = 400

/**
 * Count frequency + dispersion + first occurrence for EVERY unit span in ONE
 * pass over the book: O(book chars), not O(units × book). Each character
 * position consults a first-char bucket (CJK spreads spans across thousands of
 * buckets, so buckets stay tiny), counts each matching span
 * non-overlapping-per-span, and yields to the event loop periodically.
 */
export async function scanUnitStats(
  document: ContentDocument,
  spans: Iterable<string>
): Promise<Map<string, UnitOccurrenceStat>> {
  const stats = new Map<string, UnitOccurrenceStat>()
  const buckets = new Map<string, string[]>()
  for (const raw of spans) {
    const span = raw?.trim()
    if (!span || stats.has(span)) {
      continue
    }
    stats.set(span, {frequency: 0, dispersion: 0, first: null})
    const bucket = buckets.get(span[0])
    if (bucket) {
      bucket.push(span)
    } else {
      buckets.set(span[0], [span])
    }
  }
  if (stats.size === 0) {
    return stats
  }

  const totalSections = Math.max(1, document.sections.length)
  const sectionsWith = new Map<string, number>()
  let segmentsScanned = 0

  for (const section of document.sections) {
    const seenInSection = new Set<string>()
    for (const segment of section.segments) {
      const text = segment.sourceText
      // Per-span non-overlap cursor within this segment, allocated only when a
      // segment actually matches something (most segments match nothing).
      let nextAllowed: Map<string, number> | null = null
      for (let i = 0; i < text.length; i += 1) {
        const bucket = buckets.get(text[i])
        if (!bucket) {
          continue
        }
        for (const span of bucket) {
          if (nextAllowed && (nextAllowed.get(span) ?? 0) > i) {
            continue
          }
          if (!text.startsWith(span, i)) {
            continue
          }
          const stat = stats.get(span)!
          stat.frequency += 1
          if (!seenInSection.has(span)) {
            seenInSection.add(span)
            sectionsWith.set(span, (sectionsWith.get(span) ?? 0) + 1)
          }
          if (!stat.first) {
            const end = i + span.length
            stat.first = {
              sectionIdx: section.order,
              segmentIdx: segment.order,
              start: i,
              end,
              before: text.slice(Math.max(0, i - 24), i),
              after: text.slice(end, Math.min(text.length, end + 24)),
            }
          }
          if (!nextAllowed) {
            nextAllowed = new Map()
          }
          nextAllowed.set(span, i + span.length)
        }
      }
      segmentsScanned += 1
      if (segmentsScanned % SCAN_YIELD_EVERY_SEGMENTS === 0) {
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
    }
  }

  for (const [span, count] of sectionsWith) {
    stats.get(span)!.dispersion = count / totalSections
  }
  return stats
}

/**
 * tier → the engine's ExpressionKind. `expressionTier` maps these back onto the
 * macro tiers (term/name → word, phrase → phrase, sentence_pattern → sentence),
 * so the reader unlocks them progressively. Proper nouns become 'name' (kept in
 * source); every other word-tier unit is a 'term'.
 */
export function tierToKind(tier: ReadingUnit['tier'], keepSource: boolean): string {
  if (tier === 'sentence') return 'sentence_pattern'
  if (tier === 'phrase') return 'phrase'
  return keepSource ? 'name' : 'term'
}

/**
 * A concept's stable, language-consistent identity: its target text, lowercased
 * and space-collapsed. All surface variants that mean the same thing map to one
 * key, so they share a mastery row and graduate as a family.
 */
export function normalizeConceptKey(target: string): string {
  return target.trim().toLowerCase().replace(/\s+/g, ' ')
}

export type MappedAssets = {
  candidates: UnitCandidate[]
  occurrences: UnitOccurrence[]
  annotations: UnitAnnotation[]
  strategy: BookStrategy
  /** Units whose verbatim span never matched the book text (model drift). */
  droppedUnlocatable: number
}

/**
 * Map the flat units[] inventory into candidate / occurrence / annotation rows.
 * Each unit's VERBATIM span is the per-surface candidate row (for string match
 * on the page); mastery pools by the normalized translation (conceptCanonical),
 * so every occurrence of one meaning graduates as a family. Frequency,
 * dispersion and the representative occurrence all come from ONE
 * `scanUnitStats` pass over the book; a unit whose span never matches verbatim
 * scans to frequency 0 and is dropped — the verbatim scan is the correctness
 * guard, and the drop count is returned so silent vocabulary loss stays visible.
 */
export async function mapReadingUnitsToAssets(
  document: ContentDocument,
  result: ReadingUnitsResult,
  options: {producer: string}
): Promise<MappedAssets> {
  const units = result.units ?? []
  const stats = await scanUnitStats(
    document,
    units.map((unit) => unit.span ?? '')
  )
  const candidates: UnitCandidate[] = []
  const occurrences: UnitOccurrence[] = []
  const annotations: UnitAnnotation[] = []
  const seenSurface = new Set<string>()
  const annotatedConcepts = new Set<string>()
  let droppedUnlocatable = 0

  for (const unit of units) {
    const sourceText = unit.span?.trim()
    const targetText = unit.translation?.trim()
    if (!sourceText || !targetText || seenSurface.has(sourceText)) {
      continue
    }
    const stat = stats.get(sourceText)
    const occurrence = stat?.first
    if (!stat || !occurrence) {
      droppedUnlocatable += 1
      continue
    }
    seenSurface.add(sourceText)

    const keepSource = unit.keepSource === true
    const conceptCanonical = normalizeConceptKey(targetText)
    const {frequency, dispersion} = stat

    candidates.push({
      canonicalSource: sourceText,
      sourceText,
      kind: tierToKind(unit.tier, keepSource),
      frequency: Math.max(1, frequency),
      dispersion: dispersion || 1 / Math.max(1, document.sections.length),
      // Names stay in source (salience 'name' → not replaced by default); every
      // other extracted unit is first-class signature vocabulary.
      salience: keepSource ? 'name' : 'signature',
      conceptCanonical,
    })
    occurrences.push({
      canonicalSource: sourceText,
      sectionIdx: occurrence.sectionIdx,
      segmentIdx: occurrence.segmentIdx,
      start: occurrence.start,
      end: occurrence.end,
      before: occurrence.before,
      text: sourceText,
      after: occurrence.after,
    })

    // One annotation per concept family (keyed by conceptCanonical), so every
    // surface variant inherits its translation/risk. First representative wins.
    if (!annotatedConcepts.has(conceptCanonical)) {
      annotatedConcepts.add(conceptCanonical)
      annotations.push({
        canonicalSource: conceptCanonical,
        producer: options.producer,
        translations: keepSource
          ? []
          : [toReplacementCandidate(document.defaultTargetLanguage, targetText)],
        risk: unit.risk ?? 'medium',
        replacementStage: 1,
        shouldKeepSource: keepSource,
        reason: unit.reason ?? undefined,
        mapperKind: 'translate',
        plotCriticality: unit.plotCriticality ?? 'low',
      })
    }
  }

  return {
    candidates,
    occurrences,
    annotations,
    strategy: {
      baseDensity: clamp(
        typeof result.baseDensity === 'number' ? result.baseDensity : 0.5,
        0.2,
        0.8
      ),
      promoteNotable: false,
      note: result.note ?? 'Reading units mined as a single tier-stratified pass.',
    },
    droppedUnlocatable,
  }
}

function toReplacementCandidate(targetLanguage: string, targetText: string): ReplacementCandidate {
  return {
    targetLanguage,
    targetText,
    register: 'plain',
    confidence: 0.95,
    notes: 'Reading-unit replacement',
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
