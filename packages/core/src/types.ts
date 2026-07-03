export type ContentKind = 'novel' | 'book' | 'paper' | 'report' | 'transcript'

export type ExpressionKind = 'word' | 'phrase' | 'term' | 'name' | 'sentence_pattern'

/**
 * How characteristic a candidate is of THIS specific book (a keyness judgment,
 * not raw frequency). Drives selection + staging so the book's signature vocab
 * replaces first and generic everyday words are deferred.
 *  - signature: coined/world/genre terms that define the book (序列, 非凡者, 灰雾)
 *  - notable: meaningful, somewhat-distinctive learnable word (仪式, 馆长)
 *  - common: generic everyday content word (东西, 看见, 问题) — deferred
 *  - name: proper noun (character/place/org) — kept in source by default
 *  - none: function word / cross-boundary fragment (这是, 一) — never replaced
 */
export type ExpressionSalience = 'signature' | 'notable' | 'common' | 'name' | 'none'

export type ReplacementRisk = 'low' | 'medium' | 'high'

export type ReplacementRegister = 'plain' | 'literary' | 'technical'

/**
 * AES progressive-exposure action space: how much scaffolding a surfaced word
 * carries, from "mostly source" to "fully immersed". The flow budget decides
 * WHICH words surface (density); the action level decides HOW MUCH help each one
 * carries, advancing per-unit as the reader's mastery of that word grows.
 *  - A0: source only (not replaced)
 *  - A1: source primary + target gloss      灵石（spirit stone）
 *  - A2: target primary + source gloss       spirit stone（灵石）
 *  - A3: target only, tap reveals source      spirit stone  (dotted affordance)
 *  - A4: target only, no affordance           spirit stone  (fully immersed)
 *  - A5: whole-sentence target (reserved; sentence-level sweep, not word-level)
 */
export type ActionLevel = 0 | 1 | 2 | 3 | 4 | 5

/**
 * How much surfacing a word in a sentence would cost plot comprehension — a
 * SECOND risk axis distinct from `risk` (which is "will the translation be
 * wrong/ambiguous"). A plot-critical word (a clue, a turn, a reveal) is capped
 * to a low action level so the reader never loses the thread, even when the word
 * itself is perfectly safe to translate. Absent → treated as 'low'.
 */
export type PlotCriticality = ReplacementRisk

export type ContentDocument = {
  id: string
  title?: string
  kind: ContentKind
  sourceLanguage: string
  defaultTargetLanguage: string
  sections: Section[]
}

export type Section = {
  id: string
  title?: string
  order: number
  segments: Segment[]
}

export type Segment = {
  id: string
  sectionId: string
  order: number
  sourceText: string
  spans: TextSpan[]
  difficultyHint?: number
}

export type TextSpan = {
  start: number
  end: number
  text: string
  expressionId?: string
}

export type ExpressionOccurrence = {
  segmentId: string
  sectionId: string
  start: number
  end: number
  before: string
  text: string
  after: string
}

export type ReplacementCandidate = {
  targetLanguage: string
  targetText: string
  register: ReplacementRegister
  confidence: number
  notes?: string
}

export type Expression = {
  id: string
  sourceText: string
  canonicalSource: string
  kind: ExpressionKind
  frequency: number
  dispersion: number
  occurrences: ExpressionOccurrence[]
  risk: ReplacementRisk
  replacementStage: number
  candidates: ReplacementCandidate[]
  shouldKeepSource?: boolean
  annotationReason?: string
  /** Per-book distinctiveness from Pass-1 triage; absent on legacy data. */
  salience?: ExpressionSalience
  /**
   * Plot-comprehension cost of surfacing this word (caps its AES action level).
   * Absent on legacy data → treated as 'low' (no cap beyond the normal `risk`
   * gate).
   */
  plotCriticality?: PlotCriticality
}

export type DeterministicAnalysisOptions = {
  minFrequency?: number
  maxCandidates?: number
  maxExamplesPerExpression?: number
  minPhraseLength?: number
  maxPhraseLength?: number
  candidateScanCharacterLimit?: number
  occurrenceScanCharacterLimit?: number
  maxOccurrencesPerExpression?: number
}

export type DeterministicAnalysisResult = {
  document: ContentDocument
  expressions: Expression[]
  stats: {
    sectionCount: number
    segmentCount: number
    sourceCharacterCount: number
    candidateCount: number
  }
}

export type BookProfile = {
  title?: string
  genre: string
  sourceLanguage: string
  targetLanguage: string
  styleGuide: string
}

export type GlossaryItem = {
  source: string
  target: string
  kind: 'name' | 'term' | 'place' | 'technique' | 'object'
}

export type LlmExpressionBatchInput = {
  bookProfile: BookProfile
  existingGlossary: GlossaryItem[]
  candidates: {
    sourceText: string
    frequency: number
    dispersion: number
    examples: {
      segmentId: string
      before: string
      text: string
      after: string
    }[]
  }[]
  policy: {
    protectReadingFlow: true
    preferNoReplacementWhenUnsure: true
    noInlineTeachingHints: true
  }
}

export type LlmExpressionAnnotation = {
  sourceText: string
  kind: ExpressionKind
  /** False for function words / fragments not worth learning or replacing. */
  isContentWord: boolean
  targetCandidates: ReplacementCandidate[]
  replacementRisk: ReplacementRisk
  /**
   * Plot-comprehension cost of surfacing this word in its sentence — a separate
   * axis from `replacementRisk`. High → the executor caps it to a low action
   * level so a clue/turn/reveal is never obscured. Absent → 'low'.
   */
  plotCriticality?: PlotCriticality
  suggestedStage: number
  shouldKeepSource?: boolean
  reason?: string
  /**
   * Longer plain-language gloss, produced by the `simplify` mapper for an
   * explain panel. Absent for the `translate` mapper.
   */
  explanation?: string
}

/**
 * Pass-1 "vocabulary pack" triage input: strings + stats only (no examples, no
 * translations) so it can cheaply cover the whole candidate pool in a few calls.
 */
export type ExpressionSalienceInput = {
  book: {
    title?: string
    genre: string
    sourceLanguage: string
    targetLanguage: string
  }
  candidates: {
    sourceText: string
    frequency: number
    dispersion: number
    kind: string
  }[]
}

export type ExpressionSalienceRating = {
  sourceText: string
  salience: ExpressionSalience
}

/**
 * Book-intelligence rating: per-candidate salience PLUS the canonical surface
 * form of its concept (variants/synonyms/fragments share one canonical), so the
 * executor learns + dedupes by concept rather than by raw surface form.
 */
export type ExpressionConceptRating = {
  sourceText: string
  salience: ExpressionSalience
  canonical: string
}

export type ChapterRiskInput = {
  chapterId: string
  localSegments: {
    segmentId: string
    sourceText: string
    candidateExpressionIds: string[]
  }[]
  glossary: Record<string, string>
  previousChapterSummary?: string
  nextChapterSummary?: string
}

export type ChapterRiskOutput = {
  unsafeReplacements: {
    segmentId: string
    expressionId: string
    reason: 'plot_critical' | 'ambiguous' | 'style_sensitive' | 'too_dense'
  }[]
  phraseBoundaryFixes: {
    segmentId: string
    start: number
    end: number
    expressionText: string
  }[]
}

export type ReadingMemory = {
  userId: string
  contentId: string
  expressionStats: Record<
    string,
    {
      seenCount: number
      replacedCount: number
      explainCount: number
      frictionScore: number
      masteryScore: number
    }
  >
}

export type ReadingSessionState = {
  userId: string
  contentId: string
  targetLanguage: string
  readingProgress: number
  currentStage: number
  memory: ReadingMemory
}

/**
 * Aggregate reading-flow signals (from `reading_metrics`) that float the
 * replacement density. `charsPerMinute` is null until enough has been read.
 */
export type ReadingMetricsSummary = {
  charsPerMinute: number | null
  backtrackRate: number
  sampleMs: number
}

/**
 * The flow-first replacement budget: how aggressively to replace right now,
 * derived continuously from reading memory + metrics — NOT a fixed 25%/50% stage
 * ladder. `density` (0..1) governs how many DISTINCT words surface (each then
 * replaces at every occurrence, so it repeats enough to be learned). "Read the
 * whole book, only ~10% replaced" is the natural outcome of a small set, not a
 * hard quota.
 */
export type FeedbackBudget = {
  density: number
}

/**
 * A cheap, document-free snapshot of a book (built from mined candidates + meta,
 * no full-text load) handed to the LLM so it can design a per-book replacement
 * strategy.
 */
export type CorpusDigest = {
  book: {title?: string; genre: string; sourceLanguage: string; targetLanguage: string}
  stats: {
    sourceCharCount: number
    sectionCount: number
    segmentCount: number
    candidateCount: number
  }
  topCandidates: {sourceText: string; frequency: number; dispersion: number; kind: string}[]
}

/**
 * The LLM-designed, per-book replacement strategy — the engine decides HOW to
 * replace from the book's own character instead of a fixed rule. Feeds the
 * executor's budget (anchor density + whether to surface notable vocab early).
 * Deliberately NOT a fixed percentage or per-chapter quota. Concept grouping is
 * owned by the book-intelligence pass (a canonical per candidate), not here.
 */
export type BookStrategy = {
  baseDensity: number
  promoteNotable: boolean
  note?: string
}

export type RenderSegmentResult = {
  segmentId: string
  runs: (
    | {type: 'source'; text: string}
    | {
        type: 'replacement'
        expressionId: string
        sourceText: string
        displayText: string
        explainable: boolean
        /** AES action level this word is surfaced at (scaffolding amount). */
        level: ActionLevel
      }
  )[]
}

export type ReadingInteractionEvent = {
  type: 'seen' | 'replaced' | 'explain_opened' | 'backtrack' | 'long_dwell'
  userId: string
  contentId: string
  expressionId: string
  weight?: number
}
