import type {BookStrategy, CorpusDigest, UnitCandidate} from '@lexweave/core'

/**
 * Per-book replacement strategy design: the LLM decides HOW to replace from the
 * book's own character (anchor density + whether to promote notable vocab)
 * instead of a fixed rule — from a cheap, document-free corpus digest.
 */

const DEFAULT_TOP_CANDIDATES = 80
const FALLBACK_DENSITY = 0.55

export type BuildDigestInput = {
  book: {
    title?: string
    genre: string
    sourceLanguage: string
    targetLanguage: string
  }
  stats: {
    sourceCharCount: number
    sectionCount: number
    segmentCount: number
  }
  candidates: UnitCandidate[]
  topCandidates?: number
}

export function buildCorpusDigest(input: BuildDigestInput): CorpusDigest {
  const topN = input.topCandidates ?? DEFAULT_TOP_CANDIDATES
  const top = [...input.candidates]
    .sort((left, right) => right.frequency * right.dispersion - left.frequency * left.dispersion)
    .slice(0, topN)
  return {
    book: input.book,
    stats: {
      ...input.stats,
      candidateCount: input.candidates.length,
    },
    topCandidates: top.map((candidate) => ({
      sourceText: candidate.sourceText,
      frequency: candidate.frequency,
      dispersion: candidate.dispersion,
      kind: candidate.kind,
    })),
  }
}

/** Clamp + default a raw model response into a usable strategy. */
export function normalizeBookStrategy(raw: Partial<BookStrategy> | null | undefined): BookStrategy {
  return {
    baseDensity: clamp(
      typeof raw?.baseDensity === 'number' ? raw.baseDensity : FALLBACK_DENSITY,
      0.15,
      1
    ),
    promoteNotable: raw?.promoteNotable === true,
    note: typeof raw?.note === 'string' ? raw.note : undefined,
  }
}

export async function designStrategy(
  input: BuildDigestInput & {
    design: (digest: CorpusDigest) => Promise<Partial<BookStrategy>>
  }
): Promise<BookStrategy> {
  const digest = buildCorpusDigest(input)
  return normalizeBookStrategy(await input.design(digest))
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
