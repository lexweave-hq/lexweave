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
  /**
   * Graduated rule: the reader has mastered this word, so it always replaces
   * (at its level, normally bare target) and is transparent to the spatial
   * budget — it consumes no coverage and no min-gap, because a known word
   * costs no attention and must never crowd out words still being learned.
   */
  retired?: boolean
}

/**
 * Spatial density controls consumed by the replacement transform:
 *   coverage — max fraction of a section's visible width (CJK glyph ≈ 2, Latin
 *              glyph ≈ 1) that replacement DISPLAY text may occupy (1 =
 *              uncapped). Counted on what the reader sees — an A1 gloss like
 *              灵石（spirit stone） costs its full rendered width, not just the
 *              two source characters it covers.
 *   minGap   — minimum visible-char distance between two replacements, so a
 *              beginner's page is not lit up on every sentence.
 * Retired (mastered) rules are exempt from both — see ReplacementRule.retired.
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
  /** True when the matched rule is a graduated (mastered) word. */
  retired?: boolean
}

/** Renders one matched replacement into output markup/text. */
export type MatchRenderer = (match: ReplacementMatch) => string

export type TransformResult = {
  output: string
  /** Distinct source texts actually swapped in this transform (for telemetry). */
  appliedSources: string[]
}
