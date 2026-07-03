import type {ContentKind, LlmExpressionAnnotation, LlmExpressionBatchInput} from './types'

/**
 * The pluggable original→replacement "arrow".
 *
 * A mapper turns mined expressions into replacement candidates; swapping the
 * implementation changes WHAT the reader sees in place of the source — a
 * target-language translation, a plainer same-language explanation, a
 * definition, a gloss, etc. The analyzer (which words), the executor (when /
 * how densely), and the mapper (into what) are independent: each can change
 * without touching the others.
 */
export type MapperKind = 'translate' | 'simplify'

export interface ReplacementMapper {
  readonly kind: MapperKind
  /** Annotate one batch of candidates into replacement candidates. */
  annotate(input: LlmExpressionBatchInput): Promise<LlmExpressionAnnotation[]>
}

/**
 * Default mapper for a content kind:
 *  - narrative (novel / transcript) → translate into the target language
 *    (the classic immersion swap),
 *  - expository (book / paper / report) → simplify in the same language
 *    (replace dense or obscure wording with a plainer phrase).
 * A book-specific strategy may later override this.
 */
export function mapperKindForContent(kind: ContentKind): MapperKind {
  return kind === 'novel' || kind === 'transcript' ? 'translate' : 'simplify'
}
