const {test} = require('node:test')
const assert = require('node:assert/strict')
const {
  createReadingMemory,
  expressionsFromAssets,
  planReplacements,
  FRICTION_DROP,
  MASTERY_RETIRE,
} = require('../dist')

const candidate = (sourceText, extra = {}) => ({
  canonicalSource: sourceText,
  sourceText,
  kind: 'term',
  frequency: 10,
  dispersion: 0.5,
  salience: 'signature',
  conceptCanonical: sourceText,
  ...extra,
})

const annotation = (canonicalSource, targetText, extra = {}) => ({
  canonicalSource,
  producer: 'test@1',
  translations: [
    {targetLanguage: 'en', targetText, register: 'plain', confidence: 0.95},
  ],
  risk: 'low',
  plotCriticality: 'low',
  replacementStage: 1,
  shouldKeepSource: false,
  mapperKind: 'translate',
  ...extra,
})

const session = (memory) => ({
  userId: 'u',
  contentId: 'b',
  targetLanguage: 'en',
  readingProgress: 0,
  currentStage: 1,
  memory,
})

const stats = (extra = {}) => ({
  seenCount: 0,
  replacedCount: 0,
  explainCount: 0,
  frictionScore: 0,
  masteryScore: 0,
  ...extra,
})

test('a mastered word graduates to bare target — it never reverts to source', () => {
  const {expressions} = expressionsFromAssets(
    [candidate('灵石', {conceptCanonical: 'spirit stone'})],
    [annotation('spirit stone', 'spirit stone')]
  )
  const memory = createReadingMemory('u', 'b')
  memory.expressionStats[expressions[0].id] = stats({masteryScore: MASTERY_RETIRE})

  const rules = planReplacements(expressions, session(memory), {budget: {density: 1}})
  assert.equal(rules.length, 1)
  assert.equal(rules[0].from, '灵石')
  assert.equal(rules[0].retired, true)
  assert.equal(rules[0].level, 4)
})

test('taps on a mastered word are recall checks, never grounds to drop it', () => {
  const {expressions} = expressionsFromAssets(
    [candidate('灵石', {conceptCanonical: 'spirit stone'})],
    [annotation('spirit stone', 'spirit stone')]
  )
  const memory = createReadingMemory('u', 'b')
  memory.expressionStats[expressions[0].id] = stats({
    masteryScore: MASTERY_RETIRE,
    frictionScore: FRICTION_DROP + 10,
    explainCount: 14,
  })

  const rules = planReplacements(expressions, session(memory), {budget: {density: 1}})
  assert.equal(rules.length, 1)
  assert.equal(rules[0].retired, true)
})

test('friction still drops a word the reader is LEARNING', () => {
  const {expressions} = expressionsFromAssets(
    [candidate('灵石', {conceptCanonical: 'spirit stone'})],
    [annotation('spirit stone', 'spirit stone')]
  )
  const memory = createReadingMemory('u', 'b')
  memory.expressionStats[expressions[0].id] = stats({frictionScore: FRICTION_DROP})

  const rules = planReplacements(expressions, session(memory), {budget: {density: 1}})
  assert.equal(rules.length, 0)
})

test('retired words ride outside the density cap and never crowd out learning slots', () => {
  const learningSources = [
    '灵石', '占卜', '仪式', '秘药', '雾都', '钟塔',
    '命途', '星尘', '影阁', '荒原', '烛火', '黑棺',
  ]
  const masteredSources = ['赤月', '白塔', '古卷', '铁律', '梦境']
  const all = [...learningSources, ...masteredSources]
  const {expressions} = expressionsFromAssets(
    all.map((s, i) => candidate(s, {conceptCanonical: `concept${i}`})),
    all.map((s, i) => annotation(`concept${i}`, `target${i}`))
  )

  const memory = createReadingMemory('u', 'b')
  for (const expression of expressions) {
    if (masteredSources.includes(expression.sourceText)) {
      memory.expressionStats[expression.id] = stats({masteryScore: MASTERY_RETIRE})
    }
  }

  const rules = planReplacements(expressions, session(memory), {budget: {density: 0.5}})
  const retired = rules.filter((r) => r.retired)
  const learning = rules.filter((r) => !r.retired)
  // All 5 mastered words stay, for free; the density cap applies to the 12
  // learning words only: max(MIN_FLOW_WORDS=8, round(0.5 × 12)=6) → 8.
  assert.equal(retired.length, 5)
  assert.equal(learning.length, 8)
})

test('planReplacements without an explicit budget anchors at the default density', () => {
  const {expressions} = expressionsFromAssets(
    [candidate('灵石', {conceptCanonical: 'spirit stone'})],
    [annotation('spirit stone', 'spirit stone')]
  )
  const rules = planReplacements(expressions, session(createReadingMemory('u', 'b')))
  assert.equal(rules.length, 1)
  assert.equal(rules[0].retired, false)
})
