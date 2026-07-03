import type {
  BookProfile,
  ChapterRiskInput,
  ChapterRiskOutput,
  ContentDocument,
  Expression,
  GlossaryItem,
  LlmExpressionAnnotation,
  LlmExpressionBatchInput,
} from './types'

export type BuildExpressionBatchOptions = {
  batchSize?: number
  existingGlossary?: GlossaryItem[]
  minFrequency?: number
}

export type BookBibleInput = {
  bookProfile: BookProfile
  samples: {
    sectionId: string
    segmentId: string
    position: 'opening' | 'middle' | 'ending'
    sourceText: string
  }[]
  highFrequencyExpressions: {
    sourceText: string
    frequency: number
    dispersion: number
  }[]
  policy: LlmExpressionBatchInput['policy']
}

export type LlmGateway = {
  createBookBible(input: BookBibleInput): Promise<{
    styleGuide: string
    glossary: GlossaryItem[]
    keepSourceExpressions: string[]
  }>
  annotateExpressions(input: LlmExpressionBatchInput): Promise<LlmExpressionAnnotation[]>
  annotateChapterRisk(input: ChapterRiskInput): Promise<ChapterRiskOutput>
}

const defaultPolicy = {
  protectReadingFlow: true,
  preferNoReplacementWhenUnsure: true,
  noInlineTeachingHints: true,
} as const

export function buildBookBibleInput(
  document: ContentDocument,
  expressions: Expression[],
  bookProfile: BookProfile
): BookBibleInput {
  return {
    bookProfile,
    samples: selectDocumentSamples(document),
    highFrequencyExpressions: expressions.slice(0, 80).map((expression) => ({
      sourceText: expression.sourceText,
      frequency: expression.frequency,
      dispersion: expression.dispersion,
    })),
    policy: defaultPolicy,
  }
}

export function buildExpressionBatchInputs(
  expressions: Expression[],
  bookProfile: BookProfile,
  options: BuildExpressionBatchOptions = {}
): LlmExpressionBatchInput[] {
  const batchSize = options.batchSize ?? 40
  const existingGlossary = options.existingGlossary ?? []
  const minFrequency = options.minFrequency ?? 3

  const candidates = expressions
    .filter((expression) => expression.frequency >= minFrequency)
    .filter((expression) => !expression.shouldKeepSource)
    .map((expression) => ({
      sourceText: expression.sourceText,
      frequency: expression.frequency,
      dispersion: expression.dispersion,
      examples: expression.occurrences.map((occurrence) => ({
        segmentId: occurrence.segmentId,
        before: occurrence.before,
        text: occurrence.text,
        after: occurrence.after,
      })),
    }))

  const batches: LlmExpressionBatchInput[] = []
  for (let start = 0; start < candidates.length; start += batchSize) {
    batches.push({
      bookProfile,
      existingGlossary,
      candidates: candidates.slice(start, start + batchSize),
      policy: defaultPolicy,
    })
  }

  return batches
}

export function buildChapterRiskInput(
  document: ContentDocument,
  chapterId: string,
  expressions: Expression[],
  glossary: Record<string, string>,
  summaries: {previousChapterSummary?: string; nextChapterSummary?: string} = {}
): ChapterRiskInput {
  const section = document.sections.find((candidate) => candidate.id === chapterId)
  if (!section) {
    return {
      chapterId,
      localSegments: [],
      glossary,
      ...summaries,
    }
  }

  const expressionsBySegment = new Map<string, string[]>()
  for (const expression of expressions) {
    for (const occurrence of expression.occurrences) {
      const segmentExpressions = expressionsBySegment.get(occurrence.segmentId) ?? []
      segmentExpressions.push(expression.id)
      expressionsBySegment.set(occurrence.segmentId, segmentExpressions)
    }
  }

  return {
    chapterId,
    localSegments: section.segments.map((segment) => ({
      segmentId: segment.id,
      sourceText: segment.sourceText,
      candidateExpressionIds: [...new Set(expressionsBySegment.get(segment.id) ?? [])],
    })),
    glossary,
    ...summaries,
  }
}

export function applyExpressionAnnotations(
  expressions: Expression[],
  annotations: LlmExpressionAnnotation[]
): Expression[] {
  const annotationsBySource = new Map(
    annotations.map((annotation) => [annotation.sourceText, annotation])
  )

  return expressions.map((expression) => {
    const annotation =
      annotationsBySource.get(expression.sourceText) ??
      annotationsBySource.get(expression.canonicalSource)

    if (!annotation) {
      return expression
    }

    return {
      ...expression,
      kind: annotation.kind,
      risk: annotation.replacementRisk,
      replacementStage: annotation.suggestedStage,
      candidates: annotation.targetCandidates,
      shouldKeepSource: annotation.shouldKeepSource,
      annotationReason: annotation.reason,
    }
  })
}

function selectDocumentSamples(document: ContentDocument): BookBibleInput['samples'] {
  const allSegments = document.sections.flatMap((section) =>
    section.segments.map((segment) => ({section, segment}))
  )

  if (allSegments.length === 0) {
    return []
  }

  const sampleIndexes = [
    {index: 0, position: 'opening' as const},
    {index: Math.floor(allSegments.length / 2), position: 'middle' as const},
    {index: allSegments.length - 1, position: 'ending' as const},
  ]

  return sampleIndexes.map(({index, position}) => {
    const item = allSegments[index]
    return {
      sectionId: item.section.id,
      segmentId: item.segment.id,
      position,
      sourceText: item.segment.sourceText.slice(0, 1200),
    }
  })
}
