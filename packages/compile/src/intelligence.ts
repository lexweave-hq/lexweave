import {
  isFunctionWord,
  type ExpressionConceptRating,
  type ExpressionSalience,
  type ExpressionSalienceInput,
  type UnitCandidate,
} from '@lexweave/core'

/**
 * Book-intelligence pass: ONE LLM read over the whole candidate pool that
 * (a) rates each term's salience relative to THIS book (keyness, not raw
 * frequency) and (b) groups spelling/inflectional/fragment variants and clear
 * synonyms under a shared concept canonical — so the executor learns + dedupes
 * by concept, not by raw surface form. Cheap by design: strings + stats only.
 */

export type IntelligenceItem = {
  canonicalSource: string
  salience: ExpressionSalience
  conceptCanonical: string
}

export type IntelligenceSummary = {
  ratedCount: number
  /** Distinct concepts after grouping (≤ ratedCount). */
  conceptCount: number
  signatureCount: number
  notableCount: number
  commonCount: number
  nameCount: number
  noneCount: number
}

export type RateBookIntelligenceInput = {
  book: {
    title?: string
    genre: string
    sourceLanguage: string
    targetLanguage: string
  }
  candidates: UnitCandidate[]
  rate: (payload: ExpressionSalienceInput) => Promise<ExpressionConceptRating[]>
  batchSize?: number
}

const DEFAULT_BATCH_SIZE = 200

export async function rateBookIntelligence(
  input: RateBookIntelligenceInput
): Promise<{items: IntelligenceItem[]; summary: IntelligenceSummary}> {
  const batchSize = input.batchSize ?? DEFAULT_BATCH_SIZE
  const candidates = input.candidates

  // Default every candidate to 'notable' + its own concept; mark obvious glue as
  // 'none' locally so we never spend LLM budget on it; the rest go to the model.
  const salienceByCanonical = new Map<string, ExpressionSalience>()
  const conceptByCanonical = new Map<string, string>()
  const toRate: UnitCandidate[] = []
  for (const candidate of candidates) {
    conceptByCanonical.set(candidate.canonicalSource, candidate.canonicalSource)
    if (isFunctionWord(candidate.sourceText)) {
      salienceByCanonical.set(candidate.canonicalSource, 'none')
    } else {
      salienceByCanonical.set(candidate.canonicalSource, 'notable')
      toRate.push(candidate)
    }
  }

  // Sort so spelling/inflectional/fragment variants sit adjacent and land in the
  // same batch — the model can only group what it sees together in one call.
  toRate.sort((left, right) => left.sourceText.localeCompare(right.sourceText))

  const candidateBySource = new Map<string, UnitCandidate>()
  for (const candidate of toRate) {
    candidateBySource.set(candidate.sourceText, candidate)
    candidateBySource.set(candidate.canonicalSource, candidate)
  }

  for (let start = 0; start < toRate.length; start += batchSize) {
    const batch = toRate.slice(start, start + batchSize)
    const payload: ExpressionSalienceInput = {
      book: input.book,
      candidates: batch.map((candidate) => ({
        sourceText: candidate.sourceText,
        frequency: candidate.frequency,
        dispersion: candidate.dispersion,
        kind: candidate.kind,
      })),
    }

    const ratings = await input.rate(payload)
    for (const rating of ratings) {
      const candidate =
        candidateBySource.get(rating.sourceText) ??
        candidateBySource.get(rating.sourceText.trim().toLocaleLowerCase())
      if (!candidate) {
        continue
      }
      salienceByCanonical.set(candidate.canonicalSource, rating.salience)
      conceptByCanonical.set(
        candidate.canonicalSource,
        resolveConcept(rating.canonical, candidate.canonicalSource, candidateBySource)
      )
    }
  }

  // Flatten chains (A→B→C) so every candidate points to a ROOT that is its own
  // concept — guaranteeing the representative exists and gets enriched, and that
  // variants don't inherit from a non-enriched middle node.
  flattenConcepts(conceptByCanonical)

  const items = [...salienceByCanonical.entries()].map(([canonicalSource, salience]) => ({
    canonicalSource,
    salience,
    conceptCanonical: conceptByCanonical.get(canonicalSource) ?? canonicalSource,
  }))

  return {items, summary: summarize(items)}
}

// Map the model's canonical surface form to a real candidate id; fall back to the
// candidate's own id (standalone) when the canonical isn't one of the candidates.
function resolveConcept(
  canonical: string,
  self: string,
  candidateBySource: Map<string, UnitCandidate>
): string {
  const target =
    candidateBySource.get(canonical) ?? candidateBySource.get(canonical.trim().toLocaleLowerCase())
  return target ? target.canonicalSource : self
}

// Collapse multi-hop concept chains to a single root per candidate (cycle-safe,
// hop-capped). After this, conceptByCanonical[root] === root for every root.
function flattenConcepts(conceptByCanonical: Map<string, string>): void {
  const root = (start: string): string => {
    let current = start
    const seen = new Set<string>([start])
    for (let hop = 0; hop < 8; hop += 1) {
      const next = conceptByCanonical.get(current)
      if (!next || next === current || seen.has(next)) {
        break
      }
      seen.add(next)
      current = next
    }
    return current
  }
  for (const key of [...conceptByCanonical.keys()]) {
    conceptByCanonical.set(key, root(key))
  }
}

function summarize(items: IntelligenceItem[]): IntelligenceSummary {
  const result: IntelligenceSummary = {
    ratedCount: items.length,
    conceptCount: 0,
    signatureCount: 0,
    notableCount: 0,
    commonCount: 0,
    nameCount: 0,
    noneCount: 0,
  }
  const concepts = new Set<string>()
  for (const item of items) {
    concepts.add(item.conceptCanonical)
    if (item.salience === 'signature') result.signatureCount += 1
    else if (item.salience === 'notable') result.notableCount += 1
    else if (item.salience === 'common') result.commonCount += 1
    else if (item.salience === 'name') result.nameCount += 1
    else result.noneCount += 1
  }
  result.conceptCount = concepts.size
  return result
}
