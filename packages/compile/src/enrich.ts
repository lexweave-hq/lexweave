import {
  isFunctionWord,
  type ContentKind,
  type LlmExpressionAnnotation,
  type LlmExpressionBatchInput,
  type MapperKind,
  type ReplacementCandidate,
  type ReplacementMapper,
  type UnitAnnotation,
  type UnitCandidate,
  type UnitOccurrence,
} from '@lexweave/core'

/**
 * Enrichment pass: translate (or simplify) the concept REPRESENTATIVES that
 * still lack an annotation, salience-first, in resumable batches. I/O-free —
 * the host persists per-batch through `onBatch` so one failed batch never
 * loses the ones that already saved.
 */

const DEFAULT_MAX_EXPRESSIONS = 150
const DEFAULT_BATCH_SIZE = 30
const MAX_EXAMPLES_PER_EXPRESSION = 6

export type EnrichAnnotationsInput = {
  book: {
    title?: string
    kind: ContentKind
    sourceLanguage: string
    targetLanguage: string
  }
  candidates: UnitCandidate[]
  occurrences: UnitOccurrence[]
  /** The pluggable original→replacement "arrow" (translate / simplify / …). */
  mapper: ReplacementMapper
  /** Producer tag stamped on every produced annotation (idempotency key). */
  producer: string
  /** Concept canonicals already annotated under the current producer. */
  alreadyAnnotated?: Iterable<string>
  maxExpressions?: number
  batchSize?: number
  styleGuide?: string
  /** Persist one completed batch; called as soon as each batch finishes. */
  onBatch?: (annotations: UnitAnnotation[]) => void | Promise<void>
  /** Observe a failed batch (rate limit, timeout); the pass continues. */
  onBatchError?: (error: unknown, batchStart: number, batchSize: number) => void
}

export type EnrichAnnotationsResult = {
  requestedCount: number
  savedCount: number
  skippedCount: number
  failedBatches: number
  annotations: UnitAnnotation[]
}

export async function enrichAnnotations(
  input: EnrichAnnotationsInput
): Promise<EnrichAnnotationsResult> {
  const maxExpressions = input.maxExpressions ?? DEFAULT_MAX_EXPRESSIONS
  const batchSize = input.batchSize ?? DEFAULT_BATCH_SIZE
  const annotated = new Set(input.alreadyAnnotated ?? [])

  const selectedCandidates = input.candidates
    // Only enrich concept REPRESENTATIVES (own canonical); variants inherit the
    // representative's translation, so we translate each concept exactly once.
    .filter((candidate) => candidate.canonicalSource === candidate.conceptCanonical)
    .filter((candidate) => !annotated.has(candidate.canonicalSource))
    // Drop obvious function words before spending LLM budget; the model still
    // backstops fragments via isContentWord.
    .filter((candidate) => !isFunctionWord(candidate.sourceText))
    // Salience-first: only enrich the book's characteristic vocabulary. Generic
    // `common` words are deferred, proper nouns (`name`) are kept in source, and
    // `none` is glue — none are enriched.
    .filter((candidate) => candidate.salience === 'signature' || candidate.salience === 'notable')
    .sort((left, right) => candidatePriority(right) - candidatePriority(left))
    .slice(0, maxExpressions)

  if (selectedCandidates.length === 0) {
    return {requestedCount: 0, savedCount: 0, skippedCount: 0, failedBatches: 0, annotations: []}
  }

  const occurrencesByCandidate = groupOccurrencesByCandidate(input.occurrences)

  const allAnnotations: UnitAnnotation[] = []
  let savedCount = 0
  let skippedCount = 0
  let failedBatches = 0
  for (let start = 0; start < selectedCandidates.length; start += batchSize) {
    const batchCandidates = selectedCandidates.slice(start, start + batchSize)
    try {
      const payload = buildExpressionBatchInput(
        input.book,
        batchCandidates,
        occurrencesByCandidate,
        input.styleGuide
      )
      const annotations = await input.mapper.annotate(payload)
      const mapped = mapAnnotationsToAssets(
        annotations,
        batchCandidates,
        input.mapper.kind,
        input.producer
      )

      skippedCount += annotations.length - mapped.length
      if (mapped.length === 0) {
        continue
      }

      await input.onBatch?.(mapped)
      allAnnotations.push(...mapped)
      savedCount += mapped.length
    } catch (error) {
      // One batch failing (rate limit, timeout, transient network) must not lose
      // the batches that already saved; callers resume the rest on a later run.
      failedBatches += 1
      input.onBatchError?.(error, start, batchCandidates.length)
    }
  }

  return {
    requestedCount: selectedCandidates.length,
    savedCount,
    skippedCount: Math.max(0, skippedCount),
    failedBatches,
    annotations: allAnnotations,
  }
}

const DEFAULT_STYLE_GUIDE =
  "Protect reading flow. Keep literary tone stable. Surface the book's characteristic vocabulary early; do not force generic common words into the first layer."

function buildExpressionBatchInput(
  book: EnrichAnnotationsInput['book'],
  candidates: UnitCandidate[],
  occurrencesByCandidate: Map<string, UnitOccurrence[]>,
  styleGuide?: string
): LlmExpressionBatchInput {
  return {
    bookProfile: {
      title: book.title,
      genre: 'novel',
      sourceLanguage: book.sourceLanguage,
      targetLanguage: book.targetLanguage,
      styleGuide: styleGuide ?? DEFAULT_STYLE_GUIDE,
    },
    existingGlossary: [],
    candidates: candidates.map((candidate) => ({
      sourceText: candidate.sourceText,
      frequency: candidate.frequency,
      dispersion: candidate.dispersion,
      examples: (occurrencesByCandidate.get(candidate.canonicalSource) ?? [])
        .slice(0, MAX_EXAMPLES_PER_EXPRESSION)
        .map((occurrence) => ({
          segmentId: `${occurrence.sectionIdx}:${occurrence.segmentIdx}`,
          before: occurrence.before ?? '',
          text: occurrence.text ?? candidate.sourceText,
          after: occurrence.after ?? '',
        })),
    })),
    policy: {
      protectReadingFlow: true,
      preferNoReplacementWhenUnsure: true,
      noInlineTeachingHints: true,
    },
  }
}

export function mapAnnotationsToAssets(
  annotations: LlmExpressionAnnotation[],
  candidates: UnitCandidate[],
  mapperKind: MapperKind,
  producer: string
): UnitAnnotation[] {
  const candidateBySource = new Map<string, UnitCandidate>()
  for (const candidate of candidates) {
    candidateBySource.set(candidate.sourceText, candidate)
    candidateBySource.set(candidate.canonicalSource, candidate)
  }

  return annotations
    .map((annotation): UnitAnnotation | null => {
      const candidate =
        candidateBySource.get(annotation.sourceText) ??
        candidateBySource.get(annotation.sourceText.trim().toLocaleLowerCase())
      if (!candidate) {
        return null
      }

      const translations = normalizeReplacementCandidates(annotation.targetCandidates)
      // Trust the model's judgment: never replace function words / fragments,
      // anything it asked to keep, or anything without a usable translation.
      // Still store these (with keepSource) so re-enrichment skips them.
      const keepSource =
        annotation.isContentWord === false ||
        annotation.shouldKeepSource === true ||
        isFunctionWord(candidate.sourceText) ||
        translations.length === 0

      return {
        canonicalSource: candidate.canonicalSource,
        producer,
        translations,
        risk: annotation.replacementRisk,
        // Plot-comprehension cap (separate from translation risk). Absent →
        // 'low' (no extra cap beyond the risk gate).
        plotCriticality: annotation.plotCriticality ?? 'low',
        // Respect the model's difficulty ladder; do not force common words to
        // stage 1 — that is what floods the first layer with glue.
        replacementStage: Math.max(1, annotation.suggestedStage),
        shouldKeepSource: keepSource,
        reason: annotation.reason ?? undefined,
        mapperKind,
        explanation: annotation.explanation ?? undefined,
      }
    })
    .filter((annotation): annotation is UnitAnnotation => annotation !== null)
}

function normalizeReplacementCandidates(value: ReplacementCandidate[]): ReplacementCandidate[] {
  return value
    .filter(
      (candidate) =>
        typeof candidate.targetLanguage === 'string' &&
        typeof candidate.targetText === 'string' &&
        candidate.targetText.trim().length > 0 &&
        typeof candidate.confidence === 'number'
    )
    .map((candidate) => ({
      ...candidate,
      // The model occasionally packs synonyms into one field ("a / b"); keep
      // only the first option so the stored target is a single expression.
      targetText:
        candidate.targetText.split(/\s*[/|｜、，,;；]\s*/)[0]?.trim() ?? candidate.targetText,
    }))
    .filter((candidate) => candidate.targetText.length > 0)
}

function groupOccurrencesByCandidate(occurrences: UnitOccurrence[]) {
  const grouped = new Map<string, UnitOccurrence[]>()
  for (const occurrence of occurrences) {
    const list = grouped.get(occurrence.canonicalSource) ?? []
    list.push(occurrence)
    grouped.set(occurrence.canonicalSource, list)
  }
  return grouped
}

function candidatePriority(candidate: UnitCandidate) {
  // Enrich every signature term before any notable term when the cap binds;
  // frequency×dispersion orders within each tier.
  const salienceRank = candidate.salience === 'signature' ? 1_000_000 : 0
  return salienceRank + candidate.frequency * candidate.dispersion
}
