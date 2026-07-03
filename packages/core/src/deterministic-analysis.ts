import {isFunctionWord} from './stopwords'
import type {
  ContentDocument,
  DeterministicAnalysisOptions,
  DeterministicAnalysisResult,
  Expression,
  ExpressionKind,
  ExpressionOccurrence,
  ReplacementRisk,
  Segment,
} from './types'

type CandidateBucket = {
  sourceText: string
  canonicalSource: string
  frequency: number
  examples: ExpressionOccurrence[]
  sectionIds: Set<string>
}

const defaultOptions = {
  minFrequency: 3,
  maxCandidates: 500,
  maxExamplesPerExpression: 8,
  minPhraseLength: 2,
  maxPhraseLength: 6,
  candidateScanCharacterLimit: Number.POSITIVE_INFINITY,
  occurrenceScanCharacterLimit: Number.POSITIVE_INFINITY,
  maxOccurrencesPerExpression: Number.POSITIVE_INFINITY,
}

const punctuationPattern =
  /[\s,.!?;:()[\]{}<>\u3001\u3002\uff0c\uff01\uff1f\uff1b\uff1a\u201c\u201d\u2018\u2019\u300a\u300b\u2026\u2014-]/
const termHintPattern = /[\u672f\u6cd5\u4e39\u7b26\u9635\u7075\u8bc0\u5251\u5b97\u95e8\u8c37\u5cf0]/

export function analyzeDocument(
  document: ContentDocument,
  options: DeterministicAnalysisOptions = {}
): DeterministicAnalysisResult {
  const resolvedOptions = {...defaultOptions, ...options}
  const buckets = new Map<string, CandidateBucket>()
  let sourceCharacterCount = 0
  let segmentCount = 0
  let remainingCandidateScanCharacters = resolvedOptions.candidateScanCharacterLimit

  for (const section of document.sections) {
    for (const segment of section.segments) {
      sourceCharacterCount += segment.sourceText.length
      segmentCount += 1
      if (remainingCandidateScanCharacters > 0) {
        const scanCharacterCount = Math.min(
          segment.sourceText.length,
          remainingCandidateScanCharacters
        )
        collectSegmentCandidates(
          {...segment, sourceText: segment.sourceText.slice(0, scanCharacterCount)},
          resolvedOptions,
          buckets
        )
        remainingCandidateScanCharacters -= scanCharacterCount
      }
    }
  }

  const expressionSeeds = [...buckets.values()]
    .filter((bucket) => bucket.frequency >= resolvedOptions.minFrequency)
    .map((bucket) =>
      toExpression(bucket, document.sections.length, resolvedOptions.maxExamplesPerExpression)
    )
    .sort((left, right) => {
      const scoreDelta = expressionScore(right) - expressionScore(left)
      return scoreDelta === 0 ? left.sourceText.localeCompare(right.sourceText) : scoreDelta
    })
    .slice(0, resolvedOptions.maxCandidates)

  const expressions = collectSelectedOccurrences(document, expressionSeeds, resolvedOptions)

  return {
    document: attachExpressionSpans(document, expressions),
    expressions,
    stats: {
      sectionCount: document.sections.length,
      segmentCount,
      sourceCharacterCount,
      candidateCount: expressions.length,
    },
  }
}

function collectSegmentCandidates(
  segment: Segment,
  options: Required<DeterministicAnalysisOptions>,
  buckets: Map<string, CandidateBucket>
): void {
  const text = segment.sourceText

  for (let length = options.minPhraseLength; length <= options.maxPhraseLength; length += 1) {
    for (let start = 0; start <= text.length - length; start += 1) {
      const value = text.slice(start, start + length)
      if (!isUsefulCandidate(value)) {
        continue
      }

      const canonicalSource = canonicalize(value)
      const bucket = buckets.get(canonicalSource) ?? {
        sourceText: value,
        canonicalSource,
        frequency: 0,
        examples: [],
        sectionIds: new Set<string>(),
      }

      bucket.frequency += 1
      if (bucket.examples.length < options.maxExamplesPerExpression) {
        bucket.examples.push({
          segmentId: segment.id,
          sectionId: segment.sectionId,
          start,
          end: start + length,
          before: text.slice(Math.max(0, start - 24), start),
          text: value,
          after: text.slice(start + length, Math.min(text.length, start + length + 24)),
        })
      }
      bucket.sectionIds.add(segment.sectionId)
      buckets.set(canonicalSource, bucket)
    }
  }
}

function isUsefulCandidate(value: string): boolean {
  if (value.length < 2) {
    return false
  }

  if ([...value].some((character) => punctuationPattern.test(character))) {
    return false
  }

  const hasChinese = [...value].some(isChineseCharacter)
  const hasLatin = /[A-Za-z]/.test(value)

  if (!hasChinese && !hasLatin) {
    return false
  }

  if (/^\d+$/.test(value)) {
    return false
  }

  // Skip grammatical glue so the candidate pool stays content-bearing.
  return !isFunctionWord(value)
}

function isChineseCharacter(character: string): boolean {
  return character >= '\u4e00' && character <= '\u9fff'
}

function canonicalize(value: string): string {
  return value.trim().toLocaleLowerCase()
}

function toExpression(
  bucket: CandidateBucket,
  totalSections: number,
  maxExamplesPerExpression: number
): Expression {
  const frequency = bucket.frequency
  const dispersion = totalSections === 0 ? 0 : bucket.sectionIds.size / totalSections
  const kind = inferExpressionKind(bucket.sourceText, frequency, dispersion)
  const risk = inferInitialRisk(kind, bucket.sourceText, dispersion)

  return {
    id: `expr:${stableHash(bucket.canonicalSource)}`,
    sourceText: bucket.sourceText,
    canonicalSource: bucket.canonicalSource,
    kind,
    frequency,
    dispersion,
    occurrences: bucket.examples.slice(0, maxExamplesPerExpression),
    risk,
    replacementStage: inferInitialStage(kind, risk, frequency),
    candidates: [],
  }
}

function inferExpressionKind(
  sourceText: string,
  frequency: number,
  dispersion: number
): ExpressionKind {
  if (/^[A-Z][A-Za-z]+/.test(sourceText)) {
    return 'name'
  }

  if (sourceText.length >= 4 && frequency >= 5 && dispersion > 0.15) {
    return 'phrase'
  }

  if (sourceText.length >= 3 && termHintPattern.test(sourceText)) {
    return 'term'
  }

  return sourceText.length <= 2 ? 'word' : 'phrase'
}

function inferInitialRisk(
  kind: ExpressionKind,
  sourceText: string,
  dispersion: number
): ReplacementRisk {
  if (kind === 'name' || kind === 'term') {
    return 'medium'
  }

  if (sourceText.length >= 5 || dispersion < 0.05) {
    return 'high'
  }

  return 'low'
}

function inferInitialStage(kind: ExpressionKind, risk: ReplacementRisk, frequency: number): number {
  if (risk === 'high') {
    return 4
  }

  if (kind === 'name' || kind === 'term') {
    return 3
  }

  return frequency > 20 ? 1 : 2
}

function expressionScore(expression: Expression): number {
  const riskPenalty = expression.risk === 'high' ? 10 : expression.risk === 'medium' ? 4 : 0
  return expression.frequency * (0.5 + expression.dispersion) - riskPenalty
}

function collectSelectedOccurrences(
  document: ContentDocument,
  expressions: Expression[],
  options: Required<DeterministicAnalysisOptions>
): Expression[] {
  const occurrencesByExpression = new Map<string, ExpressionOccurrence[]>()
  const expressionsByFirstChar = new Map<string, Expression[]>()
  let scannedCharacters = 0

  for (const expression of expressions) {
    const firstChar = expression.sourceText[0]
    const list = expressionsByFirstChar.get(firstChar) ?? []
    list.push(expression)
    expressionsByFirstChar.set(firstChar, list)
    occurrencesByExpression.set(expression.id, [])
  }

  for (const section of document.sections) {
    for (const segment of section.segments) {
      const text = segment.sourceText
      const remainingCharacters = options.occurrenceScanCharacterLimit - scannedCharacters
      if (remainingCharacters <= 0) {
        break
      }
      const scanText = text.slice(0, Math.min(text.length, remainingCharacters))
      scannedCharacters += scanText.length

      for (let start = 0; start < scanText.length; start += 1) {
        const candidates = expressionsByFirstChar.get(scanText[start])
        if (!candidates) {
          continue
        }

        for (const expression of candidates) {
          const existingOccurrences = occurrencesByExpression.get(expression.id)
          if (
            !existingOccurrences ||
            existingOccurrences.length >= options.maxOccurrencesPerExpression ||
            !scanText.startsWith(expression.sourceText, start)
          ) {
            continue
          }

          existingOccurrences.push({
            segmentId: segment.id,
            sectionId: segment.sectionId,
            start,
            end: start + expression.sourceText.length,
            before: scanText.slice(Math.max(0, start - 24), start),
            text: expression.sourceText,
            after: scanText.slice(
              start + expression.sourceText.length,
              Math.min(scanText.length, start + expression.sourceText.length + 24)
            ),
          })
        }
      }
    }
  }

  return expressions.map((expression) => ({
    ...expression,
    occurrences: occurrencesByExpression.get(expression.id) ?? expression.occurrences,
  }))
}

function attachExpressionSpans(
  document: ContentDocument,
  expressions: Expression[]
): ContentDocument {
  const expressionsBySegment = new Map<string, Expression[]>()

  for (const expression of expressions) {
    for (const occurrence of expression.occurrences) {
      const list = expressionsBySegment.get(occurrence.segmentId) ?? []
      list.push(expression)
      expressionsBySegment.set(occurrence.segmentId, list)
    }
  }

  return {
    ...document,
    sections: document.sections.map((section) => ({
      ...section,
      segments: section.segments.map((segment) => ({
        ...segment,
        spans: buildExpressionSpans(segment, expressionsBySegment.get(segment.id) ?? []),
      })),
    })),
  }
}

function buildExpressionSpans(segment: Segment, expressions: Expression[]) {
  const occurrences = expressions
    .flatMap((expression) =>
      expression.occurrences
        .filter((occurrence) => occurrence.segmentId === segment.id)
        .map((occurrence) => ({...occurrence, expressionId: expression.id}))
    )
    .sort((left, right) => {
      const lengthDelta = right.end - right.start - (left.end - left.start)
      return lengthDelta === 0 ? left.start - right.start : lengthDelta
    })

  const selected: typeof occurrences = []

  for (const occurrence of occurrences) {
    const overlaps = selected.some(
      (selectedOccurrence) =>
        occurrence.start < selectedOccurrence.end && occurrence.end > selectedOccurrence.start
    )
    if (!overlaps) {
      selected.push(occurrence)
    }
  }

  return selected
    .sort((left, right) => left.start - right.start)
    .map((occurrence) => ({
      start: occurrence.start,
      end: occurrence.end,
      text: segment.sourceText.slice(occurrence.start, occurrence.end),
      expressionId: occurrence.expressionId,
    }))
}

function stableHash(value: string): string {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24)
  }

  return (hash >>> 0).toString(36)
}
