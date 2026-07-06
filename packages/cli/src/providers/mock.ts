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

export type MockLlmOptions = {
  /** Base density the mock "strategy" reports (a real provider derives this from the book). */
  baseDensity?: number
}

export function createMockLlm(entries: MockGlossaryEntry[], options: MockLlmOptions = {}): LexweaveLlm {
  const baseDensity = options.baseDensity ?? 0.6
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
        baseDensity,
        note: 'Mock provider: units taken from the supplied glossary.',
        usage: {inputTokens: 0, outputTokens: 0, totalTokens: 0},
      }
    },
    // Deterministic book brief so the --full context path exercises offline.
    async designTranslationContext(payload) {
      return {
        synopsis: `Mock synopsis for ${payload.book.title ?? 'the book'}.`,
        characters: payload.glossary.slice(0, 3).map((entry) => ({
          name: entry.source,
          rendering: entry.target,
          notes: 'mock character card',
        })),
        world: ['mock world note'],
        usage: {inputTokens: 0, outputTokens: 0, totalTokens: 0},
      }
    },
    // Deterministic placeholder substrate so --full works offline: obviously
    // fake "[en] …" translations, with glossary terms swapped in for realism.
    // Returns the terse {i, t} wire form real providers emit since prompt v3,
    // so the normalization path gets exercised offline too.
    async translateSegments(payload) {
      const translations = payload.segments.map((segment) => {
        let text = segment.text
        for (const entry of payload.glossary) {
          text = text.split(entry.source).join(entry.target)
        }
        return {i: segment.index, t: `[en] ${text}`}
      })
      return {translations, usage: {inputTokens: 0, outputTokens: 0, totalTokens: 0}}
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
