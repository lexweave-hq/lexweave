const {test} = require('node:test')
const assert = require('node:assert/strict')
const {
  createReplacementEngine,
  densityRenderOptions,
  levelDisplay,
  transformText,
  plainMatchRenderer,
} = require('../dist')

test('longest match wins over its own substring', () => {
  const engine = createReplacementEngine({
    rules: [
      {from: '占卜', to: 'divination'},
      {from: '占卜家', to: 'diviner'},
    ],
  })
  const {output} = engine.transformSection('他是占卜家。')
  assert.match(output, /diviner/)
  assert.doesNotMatch(output, /divination[^)]/)
})

test('tag and attribute interiors are never touched', () => {
  const engine = createReplacementEngine({rules: [{from: '灵石', to: 'spirit stone'}]})
  const {output} = engine.transformSection('<span data-src="灵石">灵石</span>')
  // The attribute keeps the source verbatim; only the text run is replaced.
  assert.match(output, /data-src="灵石"/)
  assert.match(output, /spirit stone/)
})

test('emitted markup is not rescanned (no nested spans)', () => {
  const engine = createReplacementEngine({
    rules: [
      {from: '神秘学', to: 'mysticism'},
      {from: '秘学', to: 'occult'},
    ],
  })
  const {output} = engine.transformSection('<p>他研究神秘学。</p>')
  assert.match(output, /mysticism/)
  assert.doesNotMatch(output, /occult/)
  // exactly one span
  assert.equal(output.split('class="ai-rep"').length - 1, 1)
})

test('action levels shape the display text', () => {
  assert.equal(levelDisplay('灵石', 'spirit stone', 1), '灵石（spirit stone）')
  assert.equal(levelDisplay('灵石', 'spirit stone', 2), 'spirit stone（灵石）')
  assert.equal(levelDisplay('灵石', 'spirit stone', 3), 'spirit stone')
  assert.equal(levelDisplay('灵石', 'spirit stone'), 'spirit stone')
})

test('pangu spacing between CJK and injected Latin', () => {
  const {output} = transformText('三块灵石在桌上', [{from: '灵石', to: 'spirit stone', level: 3}])
  assert.equal(output, '三块 spirit stone 在桌上')
})

test('no pangu space before CJK punctuation', () => {
  const {output} = transformText('掏出灵石，递给他', [{from: '灵石', to: 'spirit stone', level: 3}])
  assert.equal(output, '掏出 spirit stone，递给他')
})

test('minGap thins adjacent replacements', () => {
  const text = '灵石灵石灵石灵石灵石'
  const noGap = transformText(text, [{from: '灵石', to: 'ss', level: 3}])
  const gapped = transformText(text, [{from: '灵石', to: 'ss', level: 3}], {
    density: {minGap: 4},
  })
  assert.equal(count(noGap.output, 'ss'), 5)
  assert.ok(count(gapped.output, 'ss') < 5)
})

test('coverage caps the visible-width share of replacement display text', () => {
  const text = '灵石。'.repeat(30) // 90 CJK chars → visible width 180
  const {output} = transformText(text, [{from: '灵石', to: 'ss', level: 3}], {
    density: {coverage: 0.2},
  })
  const replacedWidth = count(output, 'ss') * 2 // 'ss' display width (Latin ≈ 1 each)
  assert.ok(replacedWidth <= 180 * 0.2)
  assert.ok(replacedWidth > 0)
})

test('coverage bills the rendered display width, not the source span it covers', () => {
  const text = '灵石'.repeat(10) // 20 source chars → visible width 40
  const {output} = transformText(text, [{from: '灵石', to: 'extraordinarily', level: 4}], {
    density: {coverage: 0.5, minGap: 0},
  })
  // Budget is 20 width units; each display costs 15, so only ONE fits. Under
  // source-span accounting (2 chars each) five would have — the page would
  // render far denser than the coverage knob claims.
  assert.equal(count(output, 'extraordinarily'), 1)
})

test('retired (mastered) rules ignore the spatial budget entirely', () => {
  const text = '灵石灵石灵石灵石灵石'
  const {output} = transformText(text, [{from: '灵石', to: 'ss', level: 4, retired: true}], {
    density: {coverage: 0.01, minGap: 100},
  })
  assert.equal(count(output, 'ss'), 5)
})

test('retired rules consume no coverage, so learning words still surface', () => {
  const text = '灵石灵石灵石灵石灵石心法'
  const {output} = transformText(
    text,
    [
      {from: '灵石', to: 'spirit', level: 4, retired: true},
      {from: '心法', to: 'method', level: 3},
    ],
    {density: {coverage: 0.5, minGap: 0}}
  )
  // All five mastered occurrences render, and the learning word still fits:
  // width budget is 12 (24 × 0.5) and the retired spans billed none of it.
  assert.equal(count(output, 'spirit'), 5)
  assert.match(output, /method/)
})

test('maxCount usage window persists across sections until reset', () => {
  const engine = createReplacementEngine({
    rules: [{from: '灵石', to: 'ss', maxCount: 2, level: 3}],
    renderMatch: plainMatchRenderer,
  })
  const a = engine.transformSection('灵石灵石灵石')
  assert.equal(count(a.output, 'ss'), 2)
  const b = engine.transformSection('灵石')
  assert.equal(count(b.output, 'ss'), 0)
  engine.resetUsage()
  const c = engine.transformSection('灵石')
  assert.equal(count(c.output, 'ss'), 1)
})

test('appliedSources reports distinct swapped sources', () => {
  const engine = createReplacementEngine({
    rules: [
      {from: '灵石', to: 'spirit stone'},
      {from: '心法', to: 'method'},
    ],
  })
  const {appliedSources} = engine.transformSection('<p>灵石和灵石和心法</p>')
  assert.deepEqual([...appliedSources].sort(), ['心法', '灵石'])
})

test('empty rules leave input untouched', () => {
  const engine = createReplacementEngine()
  const html = '<p>他拿出三块灵石。</p>'
  assert.equal(engine.transformSection(html).output, html)
})

test('densityRenderOptions maps the budget onto bounded spatial controls', () => {
  const low = densityRenderOptions(0)
  const high = densityRenderOptions(1)
  assert.equal(low.coverage, 0.15)
  assert.equal(low.minGap, 24)
  // Full density means FULL: uncapped coverage so a complete-translation
  // substrate can flip the entire page.
  assert.equal(high.coverage, 1)
  assert.equal(high.minGap, 0)
  assert.ok(densityRenderOptions(0.9).coverage < 1)
  const fallback = densityRenderOptions(NaN)
  assert.ok(fallback.coverage > 0.15 && fallback.coverage < 0.95)
})

function count(haystack, needle) {
  return haystack.split(needle).length - 1
}
