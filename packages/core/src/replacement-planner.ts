import {
  computeActionLevel,
  expressionTier,
  FRICTION_DROP,
  MASTERY_RETIRE,
  unlockedTiers,
} from './flow-budget'
import {isFunctionWord} from './stopwords'
import type {
  ActionLevel,
  ChapterRiskOutput,
  Expression,
  ExpressionSalience,
  FeedbackBudget,
  ReadingSessionState,
  RenderSegmentResult,
  Segment,
} from './types'

export type ReplacementPlannerOptions = {
  /** Hard ceiling on the share of a segment's characters that may be replaced. */
  maxReplacementDensity?: number
  minCandidateConfidence?: number
  explainableReplacements?: boolean
  /** Target spacing: ~one replacement per N source characters. */
  charsPerReplacement?: number
  /** Minimum character distance between two replacements in a segment. */
  minReplacementGap?: number
  /** Skip source spans shorter than this (in characters). */
  minSourceLength?: number
  /** Replace proper nouns (salience='name', e.g. 克莱恩→Klein). Off by default. */
  replaceNamedEntities?: boolean
  /**
   * Flow-first budget. When present, `planReplacements` runs in opportunistic
   * mode: density caps how many distinct words surface, `maxCountPerWord` how
   * often each repeats, and mechanical stage gating is bypassed entirely.
   */
  budget?: FeedbackBudget
  /** Debug-only additive mastery bonus for action-level display (default 0). */
  masteryBonus?: number
}

// Everything except `budget` is resolved against defaults; budget stays optional.
type ResolvedPlannerOptions = Required<Omit<ReplacementPlannerOptions, 'budget'>>

type ReplacementPlan = {
  expression: Expression
  start: number
  end: number
  displayText: string
  level: ActionLevel
}

const defaultPlannerOptions = {
  // Quality over quantity: a sparse, well-spaced first layer reads far better
  // than a page peppered with swaps. These caps stack — whichever binds first
  // wins.
  maxReplacementDensity: 0.12,
  minCandidateConfidence: 0.72,
  explainableReplacements: true,
  charsPerReplacement: 35,
  minReplacementGap: 12,
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

  // Names are kept in source, but the n-gram miner also emits *fragments* of
  // names (尔奇⊂韦尔奇, 密斯⊂史密斯) and cross-boundary syllables (恩一) that the
  // triage can mislabel as signature/notable. Suppress anything overlapping a
  // known name, or whose translation is a bare proper noun, so character names
  // are never transliterated into the page.
  const nameSources = expressions
    .filter((expression) => expression.salience === 'name')
    .map((expression) => expression.sourceText)
    .filter((source) => source.length >= 2)

  // Macro-progression: only surface unit tiers the reader has unlocked (words
  // always; phrases once enough words are mastered; sentences once enough
  // phrases are). The unit grows with proficiency, not just its scaffolding.
  const tiers = unlockedTiers(expressions, sessionState.memory, resolvedOptions.masteryBonus)

  const eligible: {
    from: string
    to: string
    frequency: number
    priority: number
    level: ActionLevel
  }[] = []
  for (const expression of expressions) {
    if (!tiers.has(expressionTier(expression.kind))) {
      continue
    }
    // Flow mode gates on memory + risk; legacy mode keeps the stage ladder.
    const passes = budget
      ? isFlowEligible(expression, sessionState, resolvedOptions)
      : shouldReplaceExpression(expression, sessionState, resolvedOptions)
    if (!passes) {
      continue
    }
    // Cross-word-boundary n-gram glued to a structural particle (的非凡者, 灰雾之).
    if (isBoundaryFragment(expression.sourceText)) {
      continue
    }
    if (!resolvedOptions.replaceNamedEntities && overlapsName(expression.sourceText, nameSources)) {
      continue
    }
    const candidate = expression.candidates
      .filter((item) => item.targetLanguage === sessionState.targetLanguage)
      .sort((left, right) => right.confidence - left.confidence)[0]
    if (!candidate || candidate.confidence < resolvedOptions.minCandidateConfidence) {
      continue
    }
    const to = pickPrimaryTarget(candidate.targetText)
    if (!to || to === expression.sourceText) {
      continue
    }
    if (!resolvedOptions.replaceNamedEntities && isProperNounTranslation(to)) {
      continue
    }
    eligible.push({
      from: expression.sourceText,
      to,
      frequency: expression.frequency,
      priority: expressionFlowPriority(expression),
      level: computeActionLevel(
        expression,
        sessionState.memory.expressionStats[expression.id],
        resolvedOptions.masteryBonus
      ),
    })
  }

  // Drop n-gram fragments: a shorter source that almost always occurs *inside* a
  // longer selected source (秘学⊂神秘学, 卜家⊂占卜家) is a slice of that word, not
  // a word of its own. A frequent standalone (占卜, which appears far more often
  // than 占卜家) survives because the longer word accounts for only part of it.
  let kept = eligible.filter(
    (pair) =>
      !eligible.some(
        (longer) =>
          longer.from.length > pair.from.length &&
          longer.from.includes(pair.from) &&
          longer.frequency >= pair.frequency * SUBSTRING_DOMINANCE
      )
  )

  // Flow-first: density governs how many DISTINCT words surface (highest-priority
  // signature vocab first); each then replaces at every occurrence so it repeats
  // enough to be learned. There is no quota to fill — a low budget simply means a
  // smaller set, so a whole book may only ever replace a small slice.
  if (budget) {
    const maxDistinct = Math.max(MIN_FLOW_WORDS, Math.round(budget.density * kept.length))
    kept = [...kept].sort((left, right) => right.priority - left.priority).slice(0, maxDistinct)
  }

  // NOTE: local page density (spacing / "not every sentence") is enforced at
  // render time by the WebView's per-section spatial budget (min-gap + coverage),
  // NOT by a per-word maxCount here — the runtime's occurrence counter is
  // per-SESSION, so a maxCount would make a signature word stop surfacing in the
  // target language after N total hits and revert to source for the rest of the
  // book, which is the opposite of immersion. A word instead keeps surfacing
  // until per-unit mastery retires it (isFlowEligible / computeActionLevel).

  // Longest source first so a longer phrase/sentence wins over its own substrings.
  return kept
    .map(({from, to, level}) => ({from, to, level}))
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

export function renderSegment(
  segment: Segment,
  expressions: Expression[],
  sessionState: ReadingSessionState,
  chapterRisk?: ChapterRiskOutput,
  options: ReplacementPlannerOptions = {}
): RenderSegmentResult {
  const resolvedOptions = {...defaultPlannerOptions, ...options}
  const expressionMap = new Map(expressions.map((expression) => [expression.id, expression]))
  const unsafeKeys = new Set(
    chapterRisk?.unsafeReplacements.map((item) => `${item.segmentId}:${item.expressionId}`) ?? []
  )

  const plans = segment.spans
    .map((span): ReplacementPlan | null => {
      if (!span.expressionId || unsafeKeys.has(`${segment.id}:${span.expressionId}`)) {
        return null
      }

      const expression = expressionMap.get(span.expressionId)
      if (!expression || !shouldReplaceExpression(expression, sessionState, resolvedOptions)) {
        return null
      }

      const candidate = expression.candidates
        .filter((item) => item.targetLanguage === sessionState.targetLanguage)
        .sort((left, right) => right.confidence - left.confidence)[0]

      if (!candidate || candidate.confidence < resolvedOptions.minCandidateConfidence) {
        return null
      }

      const displayText = pickPrimaryTarget(candidate.targetText)
      if (!displayText) {
        return null
      }

      return {
        expression,
        start: span.start,
        end: span.end,
        displayText,
        level: computeActionLevel(
          expression,
          sessionState.memory.expressionStats[expression.id],
          resolvedOptions.masteryBonus
        ),
      }
    })
    .filter((plan): plan is ReplacementPlan => plan !== null)
    .sort((left, right) => replacementPriority(right) - replacementPriority(left))

  const selectedPlans = selectNonOverlappingPlans(plans, segment.sourceText.length, resolvedOptions)

  return {
    segmentId: segment.id,
    runs: buildRenderRuns(
      segment.sourceText,
      selectedPlans,
      resolvedOptions.explainableReplacements
    ),
  }
}

// Flow-mode eligibility: drops the mechanical stage/exposure ladder and gates on
// what actually matters — risk, name/glue suppression, a usable translation, and
// per-word reading memory (retire a word once mastered or once the reader keeps
// tapping it open). Density/spacing is applied afterwards by the budget.
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
  const stats = sessionState.memory.expressionStats[expression.id]
  if (stats) {
    if (stats.masteryScore >= MASTERY_RETIRE) {
      return false
    }
    if (stats.frictionScore >= FRICTION_DROP) {
      return false
    }
  }
  return true
}

function shouldReplaceExpression(
  expression: Expression,
  sessionState: ReadingSessionState,
  options: ResolvedPlannerOptions
): boolean {
  if (expression.shouldKeepSource || expression.risk === 'high') {
    return false
  }

  // Salience gates (Pass-1 vocabulary pack). `none` is never replaced; proper
  // nouns are kept in source unless the named-entity toggle is on. `common` is
  // NOT hard-blocked here — it is deferred via its late stage band, so a very
  // advanced reader can still eventually see it.
  if (expression.salience === 'none') {
    return false
  }
  if (expression.salience === 'name' && !options.replaceNamedEntities) {
    return false
  }

  // Render-time guard so legacy/cloud annotations that still contain glue or
  // single characters never reach the page, even without re-enrichment.
  if ([...expression.sourceText.trim()].length < options.minSourceLength) {
    return false
  }
  if (isFunctionWord(expression.sourceText)) {
    return false
  }

  const stats = sessionState.memory.expressionStats[expression.id]
  const seenCount = stats?.seenCount ?? 0
  const masteryScore = stats?.masteryScore ?? 0
  const frictionScore = stats?.frictionScore ?? 0
  const stageReady = sessionState.currentStage >= expression.replacementStage
  const exposureReady =
    expression.replacementStage <= 1 || seenCount + masteryScore >= expression.replacementStage * 2
  const lowFriction = frictionScore < 2.5 && (stats?.explainCount ?? 0) <= 2

  if (
    expression.candidates.every(
      (candidate) => candidate.confidence < options.minCandidateConfidence
    )
  ) {
    return false
  }

  return stageReady && exposureReady && lowFriction
}

// LLM target candidates sometimes pack several synonyms into one string
// ("divination / fortune-telling"). A replacement must show a single
// expression, so keep only the first option and drop separator noise.
function pickPrimaryTarget(targetText: string): string {
  const [primary] = targetText.split(/\s*[/|｜、，,;；]\s*/)
  return (primary ?? '').trim()
}

function replacementPriority(plan: ReplacementPlan): number {
  const boost = salienceBoost[plan.expression.salience ?? 'notable']
  const riskPenalty = plan.expression.risk === 'medium' ? 2 : 0
  return boost + plan.expression.frequency * plan.expression.dispersion - riskPenalty
}

function selectNonOverlappingPlans(
  plans: ReplacementPlan[],
  sourceLength: number,
  options: ResolvedPlannerOptions
): ReplacementPlan[] {
  const selected: ReplacementPlan[] = []
  let replacedCharacters = 0
  const maxCharacters = Math.max(1, Math.floor(sourceLength * options.maxReplacementDensity))
  const maxCount = Math.max(1, Math.floor(sourceLength / options.charsPerReplacement))

  // plans arrive sorted by priority (highest first), so we keep the strongest
  // replacements and drop the rest once any cap binds.
  for (const plan of plans) {
    if (selected.length >= maxCount) {
      break
    }

    // Reject overlaps and anything too close to an already-chosen replacement;
    // a negative gap means they overlap, which this also covers.
    const tooClose = selected.some(
      (selectedPlan) =>
        Math.max(plan.start - selectedPlan.end, selectedPlan.start - plan.end) <
        options.minReplacementGap
    )
    if (tooClose) {
      continue
    }

    // The count cap (maxCount ≥ 1) already guarantees at least one slot, so
    // always allow the strongest replacement; the density budget only thins out
    // the 2nd+ swaps. Otherwise short paragraphs (where floor(len*density) < a
    // word length) would get nothing at all.
    const planLength = plan.end - plan.start
    if (selected.length > 0 && replacedCharacters + planLength > maxCharacters) {
      continue
    }

    selected.push(plan)
    replacedCharacters += planLength
  }

  return selected.sort((left, right) => left.start - right.start)
}

function buildRenderRuns(
  sourceText: string,
  plans: ReplacementPlan[],
  explainable: boolean
): RenderSegmentResult['runs'] {
  const runs: RenderSegmentResult['runs'] = []
  let cursor = 0

  for (const plan of plans) {
    if (cursor < plan.start) {
      runs.push({type: 'source', text: sourceText.slice(cursor, plan.start)})
    }

    runs.push({
      type: 'replacement',
      expressionId: plan.expression.id,
      sourceText: sourceText.slice(plan.start, plan.end),
      displayText: plan.displayText,
      explainable,
      level: plan.level,
    })

    cursor = plan.end
  }

  if (cursor < sourceText.length) {
    runs.push({type: 'source', text: sourceText.slice(cursor)})
  }

  return runs
}
