import {analyzeDocument} from './deterministic-analysis'
import {createDocumentFromPlainText} from './document'
import {buildBookBibleInput, buildExpressionBatchInputs} from './llm-context'
import type {
  BookProfile,
  DeterministicAnalysisOptions,
  DeterministicAnalysisResult,
  GlossaryItem,
  LlmExpressionBatchInput,
} from './types'

export type PrepareLongFormTextInput = {
  id: string
  rawText: string
  title?: string
  sourceLanguage: string
  targetLanguage: string
  genre?: string
  styleGuide?: string
  analysisOptions?: DeterministicAnalysisOptions
  existingGlossary?: GlossaryItem[]
}

export type PreparedLongFormText = {
  analysis: DeterministicAnalysisResult
  llm: {
    bookBibleInput: ReturnType<typeof buildBookBibleInput>
    expressionBatchInputs: LlmExpressionBatchInput[]
  }
}

export function prepareLongFormTextForBackgroundAnalysis(
  input: PrepareLongFormTextInput
): PreparedLongFormText {
  const document = createDocumentFromPlainText({
    id: input.id,
    rawText: input.rawText,
    title: input.title,
    sourceLanguage: input.sourceLanguage,
    defaultTargetLanguage: input.targetLanguage,
  })

  const analysis = analyzeDocument(document, input.analysisOptions)
  const bookProfile: BookProfile = {
    title: input.title,
    genre: input.genre ?? 'novel',
    sourceLanguage: input.sourceLanguage,
    targetLanguage: input.targetLanguage,
    styleGuide:
      input.styleGuide ??
      'Protect reading flow. Keep literary tone stable. Prefer no replacement when unsure.',
  }

  return {
    analysis,
    llm: {
      bookBibleInput: buildBookBibleInput(analysis.document, analysis.expressions, bookProfile),
      expressionBatchInputs: buildExpressionBatchInputs(analysis.expressions, bookProfile, {
        existingGlossary: input.existingGlossary,
      }),
    },
  }
}
