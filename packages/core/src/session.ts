import type {UnitAnnotation, UnitCandidate} from './assets'
import {createReadingMemory} from './memory'
import {salienceStageBand} from './replacement-planner'
import type {
  Expression,
  ReadingMemory,
  ReadingMetricsSummary,
  ReplacementCandidate,
} from './types'

/**
 * Runtime session assembly: turn stored compile assets (+ per-user learner
 * state rows) back into the in-memory shapes the planner consumes. Pure
 * functions — the host app owns where the rows actually live.
 */

/** Per-unit learner-state row (persist one per user × concept). */
export type ReadingMemoryRow = {
  canonicalSource: string
  seenCount: number
  replacedCount: number
  explainCount: number
  frictionScore: number
  masteryScore: number
}

/** Reading-flow telemetry for one reading session (most-recent first). */
export type ReadingMetricsSample = {
  /** Source characters advanced through during the session. */
  chars: number
  /** Active reading time (idle gaps capped out), milliseconds. */
  durationMs: number
  /** How many times the reader jumped backwards. */
  backtracks: number
}

/**
 * Below this many signature terms, also surface `notable` vocab in the first
 * stage so early pages aren't empty (genre fiction usually clears this easily).
 */
export const MIN_SIGNATURE_FOR_SPARSE = 20

export type AssembledExpressions = {
  expressions: Expression[]
  /** Sparse-signature safety net was engaged (few signature terms). */
  promoteNotable: boolean
  /** Some signature/notable concept still lacks an annotation → enrich needed. */
  pendingEnrichment: boolean
}

/**
 * Join candidates with their concept-family annotations into planner-ready
 * expressions. Variants inherit the concept representative's annotation and
 * share one mastery/friction memory row (keyed by conceptCanonical).
 */
export function expressionsFromAssets(
  candidates: UnitCandidate[],
  annotations: UnitAnnotation[],
  options: {minSignatureForSparse?: number} = {}
): AssembledExpressions {
  const minSignature = options.minSignatureForSparse ?? MIN_SIGNATURE_FOR_SPARSE
  const annotationByCanonical = new Map(annotations.map((a) => [a.canonicalSource, a]))
  const annotatedSet = new Set(annotations.map((a) => a.canonicalSource))

  const signatureCount = candidates.filter((c) => c.salience === 'signature').length
  const promoteNotable = signatureCount < minSignature

  const pendingEnrichment = candidates.some(
    (c) =>
      (c.salience === 'signature' || c.salience === 'notable') &&
      !annotatedSet.has(c.conceptCanonical)
  )

  const expressions: Expression[] = candidates.map((candidate) => {
    const annotation = annotationByCanonical.get(candidate.conceptCanonical)
    return {
      id: candidate.conceptCanonical,
      sourceText: candidate.sourceText,
      canonicalSource: candidate.canonicalSource,
      kind: candidate.kind as Expression['kind'],
      frequency: candidate.frequency,
      dispersion: candidate.dispersion,
      risk: annotation?.risk ?? 'medium',
      plotCriticality: annotation?.plotCriticality ?? 'low',
      // Salience is the primary staging axis; the LLM difficulty stage only
      // modulates the deferred `common` band.
      replacementStage: salienceStageBand(
        candidate.salience,
        annotation?.replacementStage ?? 6,
        promoteNotable
      ),
      shouldKeepSource: annotation?.shouldKeepSource ?? false,
      annotationReason: annotation?.reason,
      candidates: (annotation?.translations ?? []) as ReplacementCandidate[],
      occurrences: [],
      salience: candidate.salience,
    }
  })

  return {expressions, promoteNotable, pendingEnrichment}
}

/** Rebuild a ReadingMemory from persisted per-unit rows. */
export function memoryFromRows(
  userId: string,
  contentId: string,
  rows: ReadingMemoryRow[]
): ReadingMemory {
  const memory = createReadingMemory(userId, contentId)
  for (const row of rows) {
    memory.expressionStats[row.canonicalSource] = {
      seenCount: row.seenCount,
      replacedCount: row.replacedCount,
      explainCount: row.explainCount,
      frictionScore: row.frictionScore,
      masteryScore: row.masteryScore,
    }
  }
  return memory
}

// How many recent sessions feed the reading-speed estimate.
const METRICS_SESSION_WINDOW = 5
// Below this much observed active reading, a speed estimate is too noisy to use.
const MIN_SPEED_SAMPLE_MS = 30000

/** Aggregate recent session telemetry into the flow-budget summary. */
export function summarizeReadingMetrics(
  samples: ReadingMetricsSample[],
  options: {sessionWindow?: number; minSpeedSampleMs?: number} = {}
): ReadingMetricsSummary {
  const window = options.sessionWindow ?? METRICS_SESSION_WINDOW
  const minSampleMs = options.minSpeedSampleMs ?? MIN_SPEED_SAMPLE_MS
  // samples arrive most-recent first; average the recent window.
  const recent = samples.slice(0, window)
  let chars = 0
  let durationMs = 0
  let backtracks = 0
  for (const row of recent) {
    chars += row.chars
    durationMs += row.durationMs
    backtracks += row.backtracks
  }
  const minutes = durationMs / 60000
  return {
    charsPerMinute: durationMs >= minSampleMs && minutes > 0 ? chars / minutes : null,
    backtrackRate: minutes > 0 ? backtracks / minutes : 0,
    sampleMs: durationMs,
  }
}
