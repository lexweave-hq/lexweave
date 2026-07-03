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

test('substrate sentence: survives name-overlap and comma cleanup, flips whole segment', () => {
  // 15 words + 8 phrases so masteryBonus unlocks phrase AND sentence tiers.
  const words = ['灵石', '占卜', '仪式', '秘药', '雾都', '钟塔', '命途', '星尘',
    '影阁', '荒原', '烛火', '黑棺', '赤月', '白塔', '古卷']
  const phrases = ['深吸一口气', '点了点头', '皱起眉头', '握紧拳头', '摇了摇头',
    '吃了一惊', '脸色一变', '盘膝而坐']
  const sentenceSource = '韩立拿出三块灵石，递给守门弟子。'
  const candidates = [
    ...words.map((s, i) => candidate(s, {conceptCanonical: `w${i}`})),
    ...phrases.map((s, i) => candidate(s, {kind: 'phrase', conceptCanonical: `p${i}`})),
    candidate('韩立', {kind: 'name', salience: 'name', conceptCanonical: 'name0'}),
    candidate(sentenceSource, {kind: 'sentence_pattern', salience: 'common', conceptCanonical: 's0', frequency: 1}),
  ]
  const annotations = [
    ...words.map((s, i) => annotation(`w${i}`, `word${i}`)),
    ...phrases.map((s, i) => annotation(`p${i}`, `phrase${i}`)),
    annotation('name0', 'Han Li', {shouldKeepSource: true, translations: []}),
    annotation('s0', 'Han Li took out three spirit stones, and handed them to the gate disciple.'),
  ]
  const {expressions} = expressionsFromAssets(candidates, annotations)
  const rules = planReplacements(
    expressions,
    session(createReadingMemory('u', 'b')),
    {budget: {density: 1}, masteryBonus: 6}
  )
  const sentence = rules.find((r) => r.from === sentenceSource)
  assert.ok(sentence, 'whole segment should be replaceable despite containing a name')
  // Comma-bearing sentence translation passes through verbatim (no synonym split).
  assert.equal(sentence.to, 'Han Li took out three spirit stones, and handed them to the gate disciple.')
})

test('tier ramp: phrases trickle in as words graduate, no cliff', () => {
  const words = ['灵石', '占卜', '仪式', '秘药', '雾都', '钟塔']
  const phrases = ['深吸一口气', '点了点头', '皱起眉头', '握紧拳头', '摇了摇头', '吃了一惊']
  const {expressions} = expressionsFromAssets(
    [
      ...words.map((s, i) => candidate(s, {conceptCanonical: `w${i}`})),
      ...phrases.map((s, i) => candidate(s, {kind: 'phrase', conceptCanonical: `p${i}`})),
    ],
    [
      ...words.map((s, i) => annotation(`w${i}`, `word${i}`)),
      ...phrases.map((s, i) => annotation(`p${i}`, `phrase${i}`)),
    ]
  )

  // Fresh reader: zero mastery → zero earned phrase slots, even at density 1.
  const fresh = planReplacements(expressions, session(createReadingMemory('u', 'b')), {
    budget: {density: 1},
  })
  assert.equal(fresh.filter((r) => r.tier === 'phrase').length, 0)

  // One fully-mastered word earns 2 phrase slots — sporadic, not the whole pool.
  const memory = createReadingMemory('u', 'b')
  const wordId = expressions.find((e) => e.sourceText === '灵石').id
  memory.expressionStats[wordId] = stats({masteryScore: MASTERY_RETIRE})
  const some = planReplacements(expressions, session(memory), {budget: {density: 1}})
  assert.equal(some.filter((r) => r.tier === 'phrase' && !r.retired).length, 2)
})

test('readiness: the phrase built from known words flips first (i+1)', () => {
  const {expressions} = expressionsFromAssets(
    [
      candidate('灵石', {conceptCanonical: 'w0'}),
      candidate('三块灵石', {kind: 'phrase', frequency: 2, conceptCanonical: 'p0'}),
      candidate('摇了摇头', {kind: 'phrase', frequency: 9, conceptCanonical: 'p1'}),
    ],
    [
      annotation('w0', 'spirit stone'),
      annotation('p0', 'three spirit stones'),
      annotation('p1', 'shook his head'),
    ]
  )
  // Half-learned word (mastery 1.5 → A3 on page, mass 0.5) → exactly ONE
  // earned phrase slot. Readiness must pick the phrase CONTAINING the known
  // word over the higher-frequency unrelated one.
  const memory = createReadingMemory('u', 'b')
  const wordId = expressions.find((e) => e.sourceText === '灵石').id
  memory.expressionStats[wordId] = stats({masteryScore: 1.5, seenCount: 6})
  const rules = planReplacements(expressions, session(memory), {budget: {density: 1}})
  const phraseRules = rules.filter((r) => r.tier === 'phrase')
  assert.equal(phraseRules.length, 1)
  assert.equal(phraseRules[0].from, '三块灵石')
})
