import {z} from 'zod'

export const expressionKindSchema = z.enum(['word', 'phrase', 'term', 'name', 'sentence_pattern'])

export const replacementRiskSchema = z.enum(['low', 'medium', 'high'])

export const replacementRegisterSchema = z.enum(['plain', 'literary', 'technical'])

export const replacementCandidateSchema = z.object({
  targetLanguage: z.string().min(1),
  targetText: z.string().min(1),
  register: replacementRegisterSchema,
  confidence: z.number().min(0).max(1),
  notes: z.string().optional(),
})

export const glossaryItemSchema = z.object({
  source: z.string().min(1),
  target: z.string().min(1),
  kind: z.enum(['name', 'term', 'place', 'technique', 'object']),
})

export const llmExpressionBatchInputSchema = z.object({
  bookProfile: z.object({
    title: z.string().optional(),
    genre: z.string().min(1),
    sourceLanguage: z.string().min(1),
    targetLanguage: z.string().min(1),
    styleGuide: z.string().min(1),
  }),
  existingGlossary: z.array(glossaryItemSchema),
  candidates: z.array(
    z.object({
      sourceText: z.string().min(1),
      frequency: z.number().nonnegative(),
      dispersion: z.number().min(0).max(1),
      examples: z.array(
        z.object({
          segmentId: z.string().min(1),
          before: z.string(),
          text: z.string().min(1),
          after: z.string(),
        })
      ),
    })
  ),
  policy: z.object({
    protectReadingFlow: z.literal(true),
    preferNoReplacementWhenUnsure: z.literal(true),
    noInlineTeachingHints: z.literal(true),
  }),
})

export const llmExpressionAnnotationSchema = z.object({
  sourceText: z.string().min(1),
  kind: expressionKindSchema,
  isContentWord: z.boolean(),
  targetCandidates: z.array(replacementCandidateSchema),
  replacementRisk: replacementRiskSchema,
  plotCriticality: replacementRiskSchema.optional(),
  suggestedStage: z.number().int().min(1),
  shouldKeepSource: z.boolean().optional(),
  reason: z.string().optional(),
})

export const expressionSalienceSchema = z.enum(['signature', 'notable', 'common', 'name', 'none'])

export const expressionSalienceRatingSchema = z.object({
  sourceText: z.string().min(1),
  salience: expressionSalienceSchema,
})

export const expressionConceptRatingSchema = z.object({
  sourceText: z.string().min(1),
  salience: expressionSalienceSchema,
  canonical: z.string().min(1),
})

export const chapterRiskInputSchema = z.object({
  chapterId: z.string().min(1),
  localSegments: z.array(
    z.object({
      segmentId: z.string().min(1),
      sourceText: z.string(),
      candidateExpressionIds: z.array(z.string().min(1)),
    })
  ),
  glossary: z.record(z.string(), z.string()),
  previousChapterSummary: z.string().optional(),
  nextChapterSummary: z.string().optional(),
})

export const chapterRiskOutputSchema = z.object({
  unsafeReplacements: z.array(
    z.object({
      segmentId: z.string().min(1),
      expressionId: z.string().min(1),
      reason: z.enum(['plot_critical', 'ambiguous', 'style_sensitive', 'too_dense']),
    })
  ),
  phraseBoundaryFixes: z.array(
    z.object({
      segmentId: z.string().min(1),
      start: z.number().int().nonnegative(),
      end: z.number().int().nonnegative(),
      expressionText: z.string().min(1),
    })
  ),
})

export function parseLlmExpressionAnnotations(value: unknown) {
  return z.array(llmExpressionAnnotationSchema).parse(value)
}

export function parseExpressionSalienceRatings(value: unknown) {
  return z.array(expressionSalienceRatingSchema).parse(value)
}

export function parseExpressionConceptRatings(value: unknown) {
  return z.array(expressionConceptRatingSchema).parse(value)
}

export function parseChapterRiskOutput(value: unknown) {
  return chapterRiskOutputSchema.parse(value)
}
