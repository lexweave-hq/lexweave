import {
  computeActionLevel,
  DEFAULT_DENSITY,
  expressionTier,
  FRICTION_DROP,
  MASTERY_RETIRE,
  tierQuotas,
  type UnitTier,
} from './flow-budget'
import {isFunctionWord} from './stopwords'
import {SubstringIndex} from './substring-index'
import type {
  ActionLevel,
  Expression,
  ExpressionSalience,
  FeedbackBudget,
  ReadingSessionState,
} from './types'

export type ReplacementPlannerOptions = {
  minCandidateConfidence?: number
  /** Skip source spans shorter than this (in characters). */
  minSourceLength?: number
  /** Replace proper nouns (salience='name', e.g. 克莱恩→Klein). Off by default. */
  replaceNamedEntities?: boolean
  /**
   * Flow-first budget: density caps how many distinct words are being LEARNED
   * at once. When absent the planner anchors at DEFAULT_DENSITY. Spatial
   * thinning (coverage/min-gap) is the renderer's job, not the planner's.
   */
  budget?: FeedbackBudget
  /** Debug-only additive mastery bonus for action-level display (default 0). */
  masteryBonus?: number
}

// Everything except `budget` is resolved against defaults; budget stays optional.
type ResolvedPlannerOptions = Required<Omit<ReplacementPlannerOptions, 'budget'>>

const defaultPlannerOptions = {
  // Quality over quantity: only confident, multi-character content words make
  // the book-wide rule set.
  minCandidateConfidence: 0.72,
  minSourceLength: 2,
  replaceNamedEntities: false,
  masteryBonus: 0,
}

// Additive priority bands so the book's signature vocabulary always wins a
// contested segment slot over generic words, with frequency×dispersion as the
// in-band tiebreak.
const salienceBoost: Record<ExpressionSalience, number> = {
  signature: 1000,
  notable: 100,
  common: 0,
  name: 0,
  none: 0,
}

/**
 * Map a candidate's salience (+ the LLM difficulty stage) to the reader stage at
 * which it becomes eligible. Signature vocab surfaces from the very first stage
 * (it is the point of the immersion); notable joins one stage later; generic
 * `common` words are deferred to the late stages (the future whole-sentence
 * sweep); `none` is effectively never. `promoteNotable` pulls notable into stage
 * 1 as a safety net when a book has too few signature terms to fill early pages.
 */
export function salienceStageBand(
  salience: ExpressionSalience | undefined,
  llmStage: number,
  promoteNotable = false
): number {
  switch (salience) {
    case 'signature':
    case 'name':
      return 1
    case 'notable':
      return promoteNotable ? 1 : 2
    case 'common':
      return Math.max(llmStage, 4)
    case 'none':
      return 6
    default:
      // legacy / undefined salience behaves like notable
      return promoteNotable ? 1 : 2
  }
}

export type RuntimeReplacement = {
  from: string
  to: string
  maxCount?: number
  /**
   * AES action level (scaffolding amount) this word surfaces at, from the
   * reader's per-unit mastery. The WebView renders the level: A1 source-primary
   * with target gloss → A4 bare target. Defaults to A3 (target + tap-to-reveal)
   * when absent, preserving the original binary-swap behavior.
   */
  level?: ActionLevel
  /**
   * Graduated: the reader has mastered this word (masteryScore ≥
   * MASTERY_RETIRE). It keeps rendering as bare target text — a mastered word
   * NEVER reverts to source — but is exempt from every learning budget
   * (planner density slots, renderer coverage/min-gap), so it costs no
   * attention and cannot crowd out words still being learned.
   */
  retired?: boolean
  /** Macro tier this rule replaces at (word / phrase / sentence). */
  tier?: UnitTier
}

/**
 * Build the book-wide replacement map without scanning segments. The WebView
 * applies replacements by global string match, so all it needs is the set of
 * eligible source→target pairs — deriving that straight from the expression
 * list is O(expressions) instead of O(segments × spans), which matters on
 * device (a novel has 100k+ segments but only a few hundred expressions).
 */
export function planReplacements(
  expressions: Expression[],
  sessionState: ReadingSessionState,
  options: ReplacementPlannerOptions = {}
): RuntimeReplacement[] {
  const {budget, ...rest} = options
  const resolvedOptions: ResolvedPlannerOptions = {...defaultPlannerOptions, ...rest}
  const density = budget?.density ?? DEFAULT_DENSITY

  // Names are kept in source, but the n-gram miner also emits *fragments* of
  // names (尔奇⊂韦尔奇, 密斯⊂史密斯) and cross-boundary syllables (恩一) that the
  // triage can mislabel as signature/notable. Suppress anything overlapping a
  // known name, or whose translation is a bare proper noun, so character names
  // are never transliterated into the page.
  const nameSources = expressions
    .filter((expression) => expression.salience === 'name')
    .map((expression) => expression.sourceText)
    .filter((source) => source.length >= 2)

  const eligible: {
    from: string
    to: string
    frequency: number
    priority: number
    level: ActionLevel
    retired: boolean
    tier: UnitTier
    readiness: number
  }[] = []
  for (const expression of expressions) {
    const tier = expressionTier(expression.kind)
    if (!isFlowEligible(expression, sessionState, resolvedOptions)) {
      continue
    }
    // Word/phrase guards against n-gram scanner artifacts. Whole sentences are
    // exempt: a full-translation substrate segment legitimately starts anywhere
    // and CONTAINS character names (its translation renders them per glossary).
    if (tier !== 'sentence') {
      // Cross-word-boundary n-gram glued to a structural particle (的非凡者, 灰雾之).
      if (isBoundaryFragment(expression.sourceText)) {
        continue
      }
      if (
        !resolvedOptions.replaceNamedEntities &&
        overlapsName(expression.sourceText, nameSources)
      ) {
        continue
      }
    }
    const candidate = expression.candidates
      .filter((item) => item.targetLanguage === sessionState.targetLanguage)
      .sort((left, right) => right.confidence - left.confidence)[0]
    if (!candidate || candidate.confidence < resolvedOptions.minCandidateConfidence) {
      continue
    }
    // pickPrimaryTarget strips synonym lists ("divination / fortune-telling")
    // from word/phrase translations — but a whole-sentence translation contains
    // commas and slashes legitimately, so it passes through verbatim.
    const to =
      tier === 'sentence' ? candidate.targetText.trim() : pickPrimaryTarget(candidate.targetText)
    if (!to || to === expression.sourceText) {
      continue
    }
    if (!resolvedOptions.replaceNamedEntities && isProperNounTranslation(to)) {
      continue
    }
    const stats = sessionState.memory.expressionStats[expression.id]
    eligible.push({
      from: expression.sourceText,
      to,
      frequency: expression.frequency,
      priority: expressionFlowPriority(expression),
      level: computeActionLevel(expression, stats, resolvedOptions.masteryBonus),
      retired: (stats?.masteryScore ?? 0) >= MASTERY_RETIRE,
      tier,
      readiness: 0,
    })
  }

  // Drop n-gram fragments: a shorter source that almost always occurs *inside* a
  // longer selected source (秘学⊂神秘学, 卜家⊂占卜家) is a slice of that word, not
  // a word of its own. A frequent standalone (占卜, which appears far more often
  // than 占卜家) survives because the longer word accounts for only part of it.
  //
  // Indexed (Aho–Corasick) instead of pairwise includes(): with a full-book
  // substrate this list is ~90k units and O(n²) took minutes on-device. Only
  // word/phrase units can BE fragments — a whole sentence is never an n-gram
  // slice — while any longer unit (including a substrate sentence) dominates.
  const fragmentPairs = eligible.filter((pair) => pair.tier !== 'sentence')
  const fragmentIndex = new SubstringIndex(fragmentPairs.map((pair) => pair.from))
  const dominated = new Set<(typeof eligible)[number]>()
  for (const longer of eligible) {
    for (const patternId of fragmentIndex.matchedPatternIds(longer.from)) {
      const pair = fragmentPairs[patternId]
      if (
        !dominated.has(pair) &&
        longer.from.length > pair.from.length &&
        longer.frequency >= pair.frequency * SUBSTRING_DOMINANCE
      ) {
        dominated.add(pair)
      }
    }
  }
  let kept = eligible.filter((pair) => !dominated.has(pair))

  // Flow-first, per tier. Density governs how many DISTINCT units are being
  // LEARNED at once; each then replaces at every occurrence so it repeats
  // enough to be learned. Retired (mastered) units of ANY tier ride along
  // OUTSIDE the caps: mastery grows the target language on the page, it never
  // shrinks it back to source.
  //
  // Words lead (signature vocabulary first). Phrases and sentences are
  // admitted through two continuous mechanisms so the ladder has no cliff:
  //  - QUOTA (how many): mastery of the tier below EARNS slots (tierQuotas),
  //    so larger units trickle in as smaller ones graduate.
  //  - READINESS (which ones): a unit whose text is already largely covered by
  //    surfaces the reader reads in the target language (retired, or shown
  //    target-primary at A3+) flips first — the reader has pre-paid most of
  //    its cognitive cost (comprehensible input, i+1). This also scatters
  //    flips to wherever mastered vocabulary clusters, instead of marching
  //    through the book in document order.
  const retiredPairs = kept.filter((pair) => pair.retired)
  const learningPairs = kept.filter((pair) => !pair.retired)

  const knownSources = kept
    .filter((pair) => pair.tier !== 'sentence' && (pair.retired || pair.level >= 3))
    .map((pair) => pair.from)
  // Indexed for the same reason as the fragment filter: this runs for every
  // learning phrase/sentence, and a mostly-mastered reader has thousands of
  // known sources. Per pattern we keep non-overlapping matches (greedy in text
  // order), matching the previous indexOf walk exactly.
  const readinessIndex = knownSources.length ? new SubstringIndex(knownSources) : null
  const readinessOf = (text: string): number => {
    if (!readinessIndex || text.length === 0) {
      return 0
    }
    let covered = 0
    const lastEnd = new Map<number, number>()
    for (const {patternId, end} of readinessIndex.matches(text)) {
      const length = readinessIndex.patterns[patternId].length
      if (end - length >= (lastEnd.get(patternId) ?? 0)) {
        covered += length
        lastEnd.set(patternId, end)
      }
    }
    return Math.min(1, covered / text.length)
  }
  for (const pair of learningPairs) {
    if (pair.tier !== 'word') {
      pair.readiness = readinessOf(pair.from)
    }
  }

  const byPriority = (left: (typeof kept)[number], right: (typeof kept)[number]) =>
    right.priority - left.priority
  const byReadiness = (left: (typeof kept)[number], right: (typeof kept)[number]) =>
    right.readiness - left.readiness || right.priority - left.priority

  const quotas = tierQuotas(expressions, sessionState.memory, resolvedOptions.masteryBonus)
  const words = learningPairs.filter((pair) => pair.tier === 'word').sort(byPriority)
  const phrases = learningPairs.filter((pair) => pair.tier === 'phrase').sort(byReadiness)
  const sentences = learningPairs.filter((pair) => pair.tier === 'sentence').sort(byReadiness)

  kept = [
    ...retiredPairs,
    ...words.slice(0, Math.max(MIN_FLOW_WORDS, Math.round(density * words.length))),
    ...phrases.slice(0, Math.round(density * Math.min(quotas.phrases, phrases.length))),
    ...sentences.slice(0, Math.round(density * Math.min(quotas.sentences, sentences.length))),
  ]

  // NOTE: local page density (spacing / "not every sentence") is enforced at
  // render time by the WebView's per-section spatial budget (min-gap + coverage),
  // NOT by a per-word maxCount here — the runtime's occurrence counter is
  // per-SESSION, so a maxCount would make a signature word stop surfacing in the
  // target language after N total hits and revert to source for the rest of the
  // book, which is the opposite of immersion. A word instead keeps surfacing for
  // the whole book: mastery only strips its scaffolding (computeActionLevel) and
  // finally frees its learning slot (`retired`) — it never reverts to source.

  // Longest source first so a longer phrase/sentence wins over its own substrings.
  return kept
    .map(({from, to, level, retired, tier}) => ({from, to, level, retired, tier}))
    .sort((left, right) => right.from.length - left.from.length)
}

// Minimum distinct words to surface in flow mode even at a very low budget, so a
// struggling reader still gets a thin signature layer rather than a blank page.
const MIN_FLOW_WORDS = 8

// Same ranking the per-segment renderer uses: signature vocab dominates, with
// frequency×dispersion as the in-band tiebreak.
function expressionFlowPriority(expression: Expression): number {
  return (
    salienceBoost[expression.salience ?? 'notable'] + expression.frequency * expression.dispersion
  )
}

// How much of a shorter source's occurrences a longer containing source must
// account for before we treat the shorter as a mere fragment of it.
const SUBSTRING_DOMINANCE = 0.8

// A span starting/ending with a structural particle is a scanner artifact cut
// across a word boundary (的X, 了X, 之X, X之), never a word worth replacing.
function isBoundaryFragment(source: string): boolean {
  const chars = [...source]
  if (chars.length < 2) {
    return false
  }
  const first = chars[0]
  const last = chars[chars.length - 1]
  return first === '的' || first === '了' || first === '之' || last === '之'
}

// A bare proper-noun translation — a single capitalized token like "Welch",
// "Hermes", "Klein" — is a transliterated name, which we keep in source.
// Multi-word ("Hanged Man") and lowercase ("ritual", "gray mist") content-word
// translations pass through.
function isProperNounTranslation(target: string): boolean {
  return /^[A-Z][A-Za-z'’.-]*$/.test(target.trim())
}

// True when the source is a fragment of, or contains, a known character/place
// name — so name pieces never get replaced even when mislabeled as content.
function overlapsName(source: string, names: string[]): boolean {
  return names.some((name) => name !== source && (name.includes(source) || source.includes(name)))
}

// Flow-mode eligibility: gates on what actually matters — risk, name/glue
// suppression, a usable translation, and per-word reading memory. Mastery never
// disqualifies a word: a graduated word keeps rendering as bare target (marked
// `retired` downstream) so the page's English only ever grows. Density/spacing
// is applied afterwards by the budget and the renderer.
function isFlowEligible(
  expression: Expression,
  sessionState: ReadingSessionState,
  options: ResolvedPlannerOptions
): boolean {
  // High *translation* risk no longer drops a word — that silently hid the
  // book's most characteristic (and most-flagged) signature vocabulary. With a
  // confident translation it is surfaced at A1 instead (capped in
  // computeActionLevel), so it is taught with both languages always visible.
  // Words the model says to keep in source (no usable translation) still drop.
  if (expression.shouldKeepSource) {
    return false
  }
  if (expression.salience === 'none') {
    return false
  }
  if (expression.salience === 'name' && !options.replaceNamedEntities) {
    return false
  }
  if ([...expression.sourceText.trim()].length < options.minSourceLength) {
    return false
  }
  if (isFunctionWord(expression.sourceText)) {
    return false
  }
  if (
    expression.candidates.every(
      (candidate) => candidate.confidence < options.minCandidateConfidence
    )
  ) {
    return false
  }
  // Friction only drops a word the reader is still LEARNING: they keep tapping
  // it open, so ease off and stop replacing it. A tap on a MASTERED word is a
  // recall check (peeking at a gloss they forgot — the whole point of
  // tap-to-reveal), never grounds to pull the word back to source.
  const stats = sessionState.memory.expressionStats[expression.id]
  if (stats && stats.masteryScore < MASTERY_RETIRE && stats.frictionScore >= FRICTION_DROP) {
    return false
  }
  return true
}

// LLM target candidates sometimes pack several synonyms into one string
// ("divination / fortune-telling"). A replacement must show a single
// expression, so keep only the first option and drop separator noise.
function pickPrimaryTarget(targetText: string): string {
  const [primary] = targetText.split(/\s*[/|｜、，,;；]\s*/)
  return (primary ?? '').trim()
}

