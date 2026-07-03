import type {LexweaveLlm} from '@lexweave/compile'
import type {ReadingUnit} from '@lexweave/compile'

/**
 * Deterministic offline provider for demos and tests: instead of asking a
 * model to discover a book's signature units, it "extracts" the spans listed
 * in a glossary file. Zero network, byte-stable output.
 */
export type MockGlossaryEntry = {
  span: string
  translation: string
  tier?: ReadingUnit['tier']
  keepSource?: boolean
  risk?: ReadingUnit['risk']
  plotCriticality?: ReadingUnit['plotCriticality']
}

export function createMockLlm(entries: MockGlossaryEntry[]): LexweaveLlm {
  return {
    async extractReadingUnits(payload) {
      const text = payload.chapters.map((chapter) => chapter.text).join('\n\n')
      const units: ReadingUnit[] = []
      for (const entry of entries) {
        const index = text.indexOf(entry.span)
        if (index === -1) {
          continue
        }
        units.push({
          span: entry.span,
          evidence: surroundingLine(text, index, entry.span.length),
          translation: entry.translation,
          tier: entry.tier ?? guessTier(entry.span),
          keepSource: entry.keepSource === true,
          risk: entry.risk ?? 'low',
          plotCriticality: entry.plotCriticality ?? 'low',
          reason: 'mock glossary entry',
        })
      }
      return {
        units,
        baseDensity: 0.6,
        note: 'Mock provider: units taken from the supplied glossary.',
        usage: {inputTokens: 0, outputTokens: 0, totalTokens: 0},
      }
    },
  }
}

function surroundingLine(text: string, index: number, length: number): string {
  const lineStart = text.lastIndexOf('\n', index) + 1
  const lineEnd = text.indexOf('\n', index + length)
  return text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd).trim()
}

function guessTier(span: string): ReadingUnit['tier'] {
  const chars = [...span].length
  if (chars >= 8) return 'sentence'
  if (chars >= 4) return 'phrase'
  return 'word'
}
