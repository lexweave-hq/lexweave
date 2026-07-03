/** One book-wide replacement rule: every occurrence of `from` may render as `to`. */
export type ReplacementRule = {
  from: string
  to: string
  /** Optional hard cap on how many occurrences replace (per usage-reset window). */
  maxCount?: number
  /**
   * Action level (scaffolding amount): 1=source+gloss, 2=target+gloss,
   * 3=target with tap-to-reveal, 4=bare target. Defaults to 3 when absent.
   */
  level?: number
}

/**
 * Spatial density controls consumed by the replacement transform:
 *   coverage — max fraction of a section's visible chars that may be replaced
 *              (1 = uncapped); scales the overall amount of target-language text.
 *   minGap   — minimum visible-char distance between two replacements, so a
 *              beginner's page is not lit up on every sentence.
 */
export type DensityOptions = {
  coverage?: number
  minGap?: number
}

export type ReplacementMatch = {
  from: string
  to: string
  level: number
  /** The level-shaped inline text (e.g. `灵石（spirit stone）` at level 1). */
  display: string
}

/** Renders one matched replacement into output markup/text. */
export type MatchRenderer = (match: ReplacementMatch) => string

export type TransformResult = {
  output: string
  /** Distinct source texts actually swapped in this transform (for telemetry). */
  appliedSources: string[]
}
