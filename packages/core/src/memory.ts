import type {ReadingInteractionEvent, ReadingMemory} from './types'

/** Highest immersion stage a reader can reach. */
export const MAX_READER_STAGE = 5

/**
 * Lightweight stage progression. A reader's stage is not stored as a fixed
 * value — it is derived each time the book opens from how deep they've read and
 * how many expressions they've actually mastered. This unlocks harder words
 * over time so a new book isn't frozen at the easiest stage forever.
 *
 * - One band per 25% of the book read (1 → 5 across a full read-through).
 * - One extra band per 25 mastered expressions (rewards real learning).
 */
export function computeReaderStage(readingProgress: number, memory: ReadingMemory): number {
  const progress = Math.min(1, Math.max(0, readingProgress))
  const progressStage = 1 + Math.floor(progress / 0.25)

  const masteredCount = Object.values(memory.expressionStats).filter(
    (stat) => stat.masteryScore >= 2
  ).length
  const masteryStage = Math.floor(masteredCount / 25)

  return Math.min(MAX_READER_STAGE, Math.max(1, progressStage + masteryStage))
}

export function createReadingMemory(userId: string, contentId: string): ReadingMemory {
  return {
    userId,
    contentId,
    expressionStats: {},
  }
}

export function recordInteraction(
  memory: ReadingMemory,
  event: ReadingInteractionEvent
): ReadingMemory {
  const current = memory.expressionStats[event.expressionId] ?? {
    seenCount: 0,
    replacedCount: 0,
    explainCount: 0,
    frictionScore: 0,
    masteryScore: 0,
  }

  const weight = event.weight ?? 1

  const next = {
    ...current,
    seenCount: current.seenCount + (event.type === 'seen' ? weight : 0),
    replacedCount: current.replacedCount + (event.type === 'replaced' ? weight : 0),
    explainCount: current.explainCount + (event.type === 'explain_opened' ? weight : 0),
    frictionScore:
      current.frictionScore +
      (event.type === 'explain_opened' || event.type === 'backtrack' || event.type === 'long_dwell'
        ? weight
        : 0),
    masteryScore:
      current.masteryScore +
      (event.type === 'seen' || event.type === 'replaced' ? weight * 0.25 : 0),
  }

  return {
    ...memory,
    expressionStats: {
      ...memory.expressionStats,
      [event.expressionId]: next,
    },
  }
}
