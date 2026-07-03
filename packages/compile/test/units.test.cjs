const {test} = require('node:test')
const assert = require('node:assert/strict')
const {createDocumentFromPlainText} = require('@lexweave/core')
const {chunkDocument, mapReadingUnitsToAssets, scanUnitStats} = require('../dist')

const doc = (rawText) =>
  createDocumentFromPlainText({
    id: 'book',
    rawText,
    sourceLanguage: 'zh',
    defaultTargetLanguage: 'en',
  })

test('scanUnitStats counts non-overlapping occurrences with dispersion and offsets', async () => {
  const document = doc(
    ['第一章 起', '', '灵石灵石，他掏出灵石。', '', '第二章 承', '', '没有那种石头。'].join('\n')
  )
  const stats = await scanUnitStats(document, ['灵石', '石头', '不存在'])

  const lingshi = stats.get('灵石')
  assert.equal(lingshi.frequency, 3)
  assert.equal(lingshi.dispersion, 0.5) // 1 of 2 sections
  assert.equal(lingshi.first.sectionIdx, 0)
  assert.equal(lingshi.first.start, 0)
  assert.equal(lingshi.first.end, 2)

  assert.equal(stats.get('石头').frequency, 1)
  assert.equal(stats.get('不存在').frequency, 0)
  assert.equal(stats.get('不存在').first, null)
})

test('mapReadingUnitsToAssets drops unlocatable spans and dedups by verbatim span', async () => {
  const document = doc('他掏出三块灵石，深吸一口气。')
  const unit = (span, translation, extra = {}) => ({
    span,
    evidence: span,
    translation,
    tier: 'word',
    keepSource: false,
    risk: 'low',
    plotCriticality: 'low',
    ...extra,
  })
  const assets = await mapReadingUnitsToAssets(
    document,
    {
      units: [
        unit('灵石', 'spirit stone'),
        unit('灵石', 'spirit stone'), // duplicate span → one row
        unit('深吸一口气', 'took a deep breath', {tier: 'phrase'}),
        unit('不在书里', 'not in the book'), // → dropped
      ],
      baseDensity: 0.5,
    },
    {producer: 'test@1'}
  )

  assert.equal(assets.candidates.length, 2)
  assert.equal(assets.droppedUnlocatable, 1)
  const lingshi = assets.candidates.find((c) => c.sourceText === '灵石')
  assert.equal(lingshi.salience, 'signature')
  assert.equal(lingshi.kind, 'term')
  assert.equal(lingshi.conceptCanonical, 'spirit stone')
  const phrase = assets.candidates.find((c) => c.sourceText === '深吸一口气')
  assert.equal(phrase.kind, 'phrase')
  assert.equal(assets.annotations.every((a) => a.producer === 'test@1'), true)
})

test('mapReadingUnitsToAssets keeps proper nouns in source', async () => {
  const document = doc('林昭走了进来。')
  const assets = await mapReadingUnitsToAssets(
    document,
    {
      units: [
        {
          span: '林昭',
          evidence: '林昭走了进来。',
          translation: 'Lin Zhao',
          tier: 'word',
          keepSource: true,
          risk: 'low',
          plotCriticality: 'low',
        },
      ],
    },
    {producer: 'test@1'}
  )
  const name = assets.candidates[0]
  assert.equal(name.salience, 'name')
  assert.equal(name.kind, 'name')
  const annotation = assets.annotations[0]
  assert.equal(annotation.shouldKeepSource, true)
  assert.equal(annotation.translations.length, 0)
})

test('variants sharing one translation share one concept annotation', async () => {
  const document = doc('灵石就是灵石头。')
  const unit = (span) => ({
    span,
    evidence: span,
    translation: 'Spirit  Stone', // messy casing/spacing → same normalized concept
    tier: 'word',
    keepSource: false,
    risk: 'low',
    plotCriticality: 'low',
  })
  const assets = await mapReadingUnitsToAssets(
    document,
    {units: [unit('灵石'), unit('灵石头')]},
    {producer: 'test@1'}
  )
  assert.equal(assets.candidates.length, 2)
  assert.equal(assets.annotations.length, 1)
  assert.equal(assets.candidates[0].conceptCanonical, assets.candidates[1].conceptCanonical)
})

test('chunkDocument respects the max-chars budget and section ranges', () => {
  const chapters = []
  for (let i = 0; i < 6; i += 1) {
    chapters.push(`第${i + 1}章 x`, '', '一二三四五六七八九十'.repeat(10), '')
  }
  const document = doc(chapters.join('\n'))
  const chunks = chunkDocument(document, 250)
  assert.ok(chunks.length > 1)
  for (const chunk of chunks) {
    assert.ok(chunk.chapters[0].text.length <= 250 + 120) // one segment of slack
    assert.ok(chunk.sectionEnd >= chunk.sectionStart)
  }
  // Coverage: chunks span all sections in order.
  assert.equal(chunks[0].sectionStart, 0)
  assert.equal(chunks[chunks.length - 1].sectionEnd, document.sections.length - 1)
})
