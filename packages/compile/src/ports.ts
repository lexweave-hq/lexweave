import type {
  BookStrategy,
  CorpusDigest,
  ExpressionConceptRating,
  ExpressionSalienceInput,
  LlmExpressionAnnotation,
  LlmExpressionBatchInput,
} from '@lexweave/core'
import type {
  BookContextPayload,
  BookContextResult,
  SegmentTranslationsResult,
  TranslateSegmentsPayload,
} from './translate'
import type {ReadingUnitsPayload, ReadingUnitsResult} from './units'

/** Token accounting reported by an LLM adapter (all zeros when unknown). */
export type LlmUsage = {
  inputTokens: number
  outputTokens: number
  totalTokens: number
}

/**
 * The single seam between the compiler and any LLM. Implement it with a direct
 * provider call (see @lexweave/cli's Anthropic/OpenAI adapters), an edge
 * function, a queue, or a deterministic mock — the pipeline never knows.
 * Only `extractReadingUnits` is required; the rest enable optional passes.
 */
export interface LexweaveLlm {
  /** Pass 1 — single-pass, tier-stratified reading-unit extraction per chunk. */
  extractReadingUnits(payload: ReadingUnitsPayload): Promise<ReadingUnitsResult>
  /** Optional — keyness triage + concept grouping over the mined candidate pool. */
  rateBookIntelligence?(payload: ExpressionSalienceInput): Promise<ExpressionConceptRating[]>
  /** Optional — per-book replacement strategy from a cheap corpus digest. */
  designBookStrategy?(digest: CorpusDigest): Promise<Partial<BookStrategy>>
  /** Optional — translate-mapper enrichment for un-annotated candidates. */
  annotateExpressions?(payload: LlmExpressionBatchInput): Promise<LlmExpressionAnnotation[]>
  /** Optional — simplify-mapper enrichment (same-language plainer phrase). */
  simplifyExpressions?(payload: LlmExpressionBatchInput): Promise<LlmExpressionAnnotation[]>
  /** Optional — full-translation substrate: translate one batch of consecutive segments. */
  translateSegments?(payload: TranslateSegmentsPayload): Promise<SegmentTranslationsResult>
  /** Optional — one-shot book brief (synopsis, character sheet, world notes) for translation consistency. */
  designTranslationContext?(payload: BookContextPayload): Promise<BookContextResult>
}

export function normalizeLlmUsage(usage?: Partial<LlmUsage> | null): LlmUsage {
  return {
    inputTokens: Number(usage?.inputTokens ?? 0),
    outputTokens: Number(usage?.outputTokens ?? 0),
    totalTokens: Number(usage?.totalTokens ?? 0),
  }
}

export function addLlmUsage(left: LlmUsage, right?: Partial<LlmUsage> | null): LlmUsage {
  const other = normalizeLlmUsage(right)
  return {
    inputTokens: left.inputTokens + other.inputTokens,
    outputTokens: left.outputTokens + other.outputTokens,
    totalTokens: left.totalTokens + other.totalTokens,
  }
}
