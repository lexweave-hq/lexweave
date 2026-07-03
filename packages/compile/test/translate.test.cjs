const {test} = require('node:test')
const assert = require('node:assert/strict')
const {compileText, translateDocumentSegments} = require('../dist')
const {createDocumentFromPlainText} = require('@lexweave/core')

// Stub adapter: one extracted word unit + deterministic "[en] …" translations
// that keep the glossary substitutions visible and include a comma (sentence
// translations legitimately contain punctuation that word-level cleanup strips).
const stubLlm = {
  async extractReadingUnits() {
    return {
      units: [
        {
          span: '灵石',
          evidence: '他拿出三块灵石。',
          translation: 'spirit stone',
          tier: 'word',
          keepSource: false,
          risk: 'low',
          plotCriticality: 'low',
          reason: 'stub',
        },
      ],
      baseDensity: 0.5,
      note: 'stub',
      usage: {inputTokens: 1, outputTokens: 1, totalTokens: 2},
    }
  },
  async translateSegments(payload) {
    return {
      translations: payload.segments.map((segment) => {
        let text = segment.text
        for (const entry of payload.glossary) {
          text = text.split(entry.source).join(entry.target)
        }
        return {index: segment.index, translation: `[en] ${text}, indeed`}
      }),
      usage: {inputTokens: 1, outputTokens: 1, totalTokens: 2},
    }
  },
}

const RAW = '他拿出三块灵石。\n\n守门弟子点了点头。\n\n他走进了山门。'

test('fullTranslation: every segment becomes a common-salience sentence unit', async () => {
  const result = await compileText(
    {rawText: RAW, title: 't', sourceLanguage: 'zh', targetLanguage: 'en'},
    {llm: stubLlm, fullTranslation: true}
  )
  const sentences = result.bundle.candidates.filter((c) => c.kind === 'sentence_pattern')
  assert.equal(sentences.length, result.bundle.book.segmentCount)
  assert.ok(sentences.every((c) => c.salience === 'common'))
  assert.equal(result.translationMissing, 0)

  // Glossary consistency reached the substrate: 灵石 rendered as spirit stone.
  const first = result.bundle.annotations.find((a) =>
    a.canonicalSource.includes('spirit stone')
  )
  assert.ok(first, 'substrate translation should carry the glossary rendering')

  // The extracted signature unit is still present alongside the substrate.
  assert.ok(result.bundle.candidates.some((c) => c.sourceText === '灵石' && c.salience === 'signature'))
})

test('fullTranslation off: no sentence substrate is added', async () => {
  const result = await compileText(
    {rawText: RAW, title: 't', sourceLanguage: 'zh', targetLanguage: 'en'},
    {llm: stubLlm}
  )
  assert.equal(result.bundle.candidates.filter((c) => c.kind === 'sentence_pattern').length, 0)
  assert.equal(result.translationMissing, undefined)
})

test('translateDocumentSegments: batching preserves order and reports missing echoes', async () => {
  const document = createDocumentFromPlainText({
    id: 'd',
    rawText: RAW,
    kind: 'novel',
    sourceLanguage: 'zh',
    defaultTargetLanguage: 'en',
  })
  const skipEven = {
    async translateSegments(payload) {
      return {
        translations: payload.segments
          .filter((segment) => segment.index % 2 === 0)
          .map((segment) => ({index: segment.index, translation: `[en] ${segment.text}`})),
      }
    },
  }
  const result = await translateDocumentSegments(document, {
    llm: skipEven,
    batchChars: 10, // force one segment per batch → every local index is 0 → none skipped
  })
  assert.equal(result.missing, 0)
  assert.equal(result.segments.length, 3)
  // Alignment: each translation carries its own source text.
  for (const segment of result.segments) {
    assert.ok(segment.translation.includes(segment.sourceText))
  }
})
