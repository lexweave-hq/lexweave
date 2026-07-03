import type {
  ActionLevel,
  Expression,
  ExpressionKind,
  FeedbackBudget,
  PlotCriticality,
  ReadingMemory,
  ReadingMetricsSummary,
} from './types'

/**
 * Flow-first replacement budget.
 *
 * Replaces the old mechanical stage ladder (computeReaderStage +
 * salienceStageBand): instead of unlocking a fixed share of words per 25% read,
 * we derive a continuous `density` from how the reader is actually coping —
 * - tapping replaced words a lot (curiosity/friction) → ease off,
 * - reading briskly with few taps → push a little harder,
 * - reading very slowly or jumping backwards (confusion) → ease off.
 *
 * The budget never tries to "finish" a book: a calm reader sits around the
 * default, a struggling one is pulled toward the floor, so a full read-through
 * may only ever replace a small slice — which is the point.
 */

export const DEFAULT_DENSITY = 0.55
const MIN_DENSITY = 0.15
const MAX_DENSITY = 1

// A word whose mastery has accrued this far has graduated: it keeps rendering
// as bare target text (A4, tap still reveals the source) but stops occupying a
// learning slot in the density budget. Graduation must never send a word back
// to source — the page's target-language share only ever grows.
export const MASTERY_RETIRE = 3
// A word the reader keeps tapping open WHILE LEARNING is causing friction —
// stop replacing it. Never applied to mastered words: tapping those is a
// recall check, not friction.
export const FRICTION_DROP = 4

// CJK reading-speed reference points (characters per minute of active reading).
const SLOW_CPM = 200
const BRISK_CPM = 500

export function computeFeedbackBudget(
  memory: ReadingMemory,
  metrics: ReadingMetricsSummary,
  // Anchor from the LLM-designed book strategy; live feedback nudges around it.
  baseDensity: number = DEFAULT_DENSITY
): FeedbackBudget {
  let density = baseDensity

  // Friction ratio: how often the reader opens a replacement relative to how
  // much they've been exposed to. High ratio → the layer is too demanding.
  const stats = Object.values(memory.expressionStats)
  let friction = 0
  let exposure = 0
  for (const stat of stats) {
    friction += stat.frictionScore
    exposure += stat.seenCount + stat.replacedCount
  }
  const frictionRatio = exposure > 0 ? friction / exposure : 0
  if (frictionRatio > 0.15) {
    density -= 0.25
  } else if (exposure > 20 && frictionRatio < 0.03) {
    density += 0.15
  }

  // Reading speed: very slow suggests the reader is struggling; brisk suggests
  // headroom for a touch more.
  if (metrics.charsPerMinute != null) {
    if (metrics.charsPerMinute < SLOW_CPM) {
      density -= 0.15
    } else if (metrics.charsPerMinute > BRISK_CPM) {
      density += 0.1
    }
  }

  // Frequent backward jumps read as confusion.
  if (metrics.backtrackRate > 1) {
    density -= 0.15
  }

  density = clamp(density, MIN_DENSITY, MAX_DENSITY)
  return {density}
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

// ── AES progressive-exposure action policy ───────────────────────────────────
//
// The flow budget above decides WHICH words surface (density). This decides HOW
// MUCH scaffolding each surfaced word carries — its action level — and advances
// that level per-word as the reader's own mastery of THAT word grows. A brand
// new word arrives heavily glossed (A1: 灵石（spirit stone）); as exposure and
// mastery accrue it sheds scaffolding (A2 → A3 → A4) until it retires at
// MASTERY_RETIRE, by which point the reader reads the bare target without help.
//
// This is AES's π(S_t, u_i) — but driven by the engine's existing per-unit
// reading memory instead of fixed global mastery thresholds, so a word the
// reader already knows skips straight to a high level while a hard one lingers
// at A1.

// Exposure (seen + replaced) needed before a word sheds its A1 source-primary
// gloss and flips to target-primary (A2).
const A2_EXPOSURE = 3
// Per-unit mastery thresholds for shedding the remaining scaffolds.
const A3_MASTERY = 1
const A4_MASTERY = 2

/**
 * Highest action level a plot-criticality rating permits FOR A READER WHO DOES
 * NOT YET KNOW THE WORD. A plot-critical word starts source-primary (A1) so a
 * clue/turn is never obscured; a medium one starts at A2 (both languages
 * visible); low imposes no cap. This is a STARTING floor, not a permanent
 * ceiling — `computeActionLevel` loosens it as the reader proves mastery.
 */
export function actionLevelCap(plotCriticality: PlotCriticality | undefined): ActionLevel {
  switch (plotCriticality) {
    case 'high':
      return 1
    case 'medium':
      return 2
    default:
      return 4
  }
}

/**
 * Static scaffolding a word needs for a reader who does NOT yet know it, from
 * translation risk: a high-risk swap (often a plot-important signature term the
 * model flagged) starts fully glossed at A1 (封印物（Sealed Artifact）); medium
 * starts at A2; low is uncapped. Like the plot cap, this is a starting floor —
 * mastery earns past it.
 */
function riskCap(risk: Expression['risk']): ActionLevel {
  return risk === 'high' ? 1 : risk === 'medium' ? 2 : 4
}

// Each full point of demonstrated mastery earns back one capped level, so a word
// the reader has clearly internalized graduates past its static risk/plot cap
// (封印物（Sealed Artifact） → 封印物 → Sealed Artifact[tap]) instead of staying
// glossed for the whole book. A flagged-risky word still lags a low-risk one by
// its higher starting cap, so it tops out at tap-revealable (A3) before it
// retires rather than going fully bare — keeping a safety net to the very end.
const CAP_EARN_STEP = 1

/**
 * Choose the action level for a word about to be surfaced, from the reader's
 * per-unit memory and the word's risk/plot caps. Returns A1..A4 (A0 means "not
 * surfaced" and is handled by eligibility, not here; A5 is the reserved
 * sentence-level sweep).
 *
 * Two forces: the word's mastery sets the NATURAL level it wants to be at, while
 * the risk/plot caps hold it back UNTIL that same mastery earns the cap loose.
 * The cap is a floor for a stranger to the word, not a life sentence — so a
 * mastered word graduates regardless of how the model labelled its risk.
 */
export function computeActionLevel(
  expression: Pick<Expression, 'plotCriticality' | 'risk'>,
  stats: ReadingMemory['expressionStats'][string] | undefined,
  // Debug-only knob (default 0): ADDS assumed mastery to the LEVEL calculation so
  // a reader can preview how the page looks further along — including words with
  // zero real exposure (a multiplier can't move those: 0×N=0). Additive also lifts
  // the exposure gate so an unseen word can still shed its A1 gloss. Touches only
  // the displayed level — raw stats, eligibility, and retirement are unchanged and
  // nothing is persisted.
  masteryBonus = 0
): ActionLevel {
  const exposure = (stats?.seenCount ?? 0) + (stats?.replacedCount ?? 0) + masteryBonus
  const mastery = (stats?.masteryScore ?? 0) + masteryBonus
  const friction = stats?.frictionScore ?? 0

  let level: ActionLevel = 1
  if (mastery >= A4_MASTERY) {
    level = 4
  } else if (mastery >= A3_MASTERY) {
    level = 3
  } else if (exposure >= A2_EXPOSURE) {
    level = 2
  }

  // Proven mastery (with low friction on THIS word) loosens the static cap one
  // level per mastery point; a reader still struggling with the word (friction
  // at the drop threshold) earns nothing and keeps the full scaffold.
  const staticCap = Math.min(actionLevelCap(expression.plotCriticality), riskCap(expression.risk))
  const earned = friction >= FRICTION_DROP ? 0 : Math.floor(mastery / CAP_EARN_STEP)
  const cap = Math.min(4, staticCap + earned) as ActionLevel

  return Math.min(level, cap) as ActionLevel
}

// ── AES macro-progression: the replacement UNIT grows with proficiency ────────
//
// The action level above is the MICRO ladder — how bare a single unit gets
// (A1→A4). This is the MACRO ladder — how big the replaced unit is. AES grows it
// word → phrase → sentence as the reader proves they can handle the smaller unit:
//   word     世界观术语 / 动作词        灵石, 深吸
//   phrase   动作块 / 对话·叙事 pattern  深吸一口气, 还未等他反应过来
//   sentence 整句框架                    他拿出三块灵石，递给守门弟子。
// A tier only unlocks once the reader has mastered enough of the tier below, so a
// beginner sees single words swapped and an advanced reader sees whole phrases /
// sentences flip to the target language — the path to "the page is mostly English".

export type UnitTier = 'word' | 'phrase' | 'sentence'

/** Map a mined expression's kind onto its macro tier. */
export function expressionTier(kind: ExpressionKind): UnitTier {
  if (kind === 'sentence_pattern') return 'sentence'
  if (kind === 'phrase') return 'phrase'
  return 'word' // word | term | name
}

// Mastered smaller-unit counts needed to unlock the next tier.
const PHRASE_UNLOCK_WORDS = 15
const SENTENCE_UNLOCK_PHRASES = 8

/**
 * Which unit tiers the reader has unlocked, from how many units of each smaller
 * tier they have mastered. `masteryBonus` (debug) lifts the counts so the ladder
 * can be previewed. Always includes `word`.
 */
export function unlockedTiers(
  expressions: Pick<Expression, 'id' | 'kind'>[],
  memory: ReadingMemory,
  masteryBonus = 0
): Set<UnitTier> {
  let masteredWords = 0
  let masteredPhrases = 0
  for (const expression of expressions) {
    const mastery = (memory.expressionStats[expression.id]?.masteryScore ?? 0) + masteryBonus
    if (mastery < MASTERY_RETIRE) {
      continue
    }
    const tier = expressionTier(expression.kind)
    if (tier === 'word') {
      masteredWords += 1
    } else if (tier === 'phrase') {
      masteredPhrases += 1
    }
  }
  const tiers = new Set<UnitTier>(['word'])
  if (masteredWords >= PHRASE_UNLOCK_WORDS) {
    tiers.add('phrase')
  }
  if (masteredPhrases >= SENTENCE_UNLOCK_PHRASES) {
    tiers.add('sentence')
  }
  return tiers
}
