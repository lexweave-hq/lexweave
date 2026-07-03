const {test} = require('node:test')
const assert = require('node:assert/strict')
const {
  computeActionLevel,
  createReadingMemory,
  expressionsFromAssets,
  memoryFromRows,
  parseBookBundle,
  planReplacements,
  recordInteraction,
  summarizeReadingMetrics,
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

test('expressionsFromAssets: variants inherit the concept annotation and share one id', () => {
  const {expressions} = expressionsFromAssets(
    [
      candidate('灵石', {conceptCanonical: 'spirit stone'}),
      candidate('灵石头', {conceptCanonical: 'spirit stone'}),
    ],
    [annotation('spirit stone', 'spirit stone')]
  )
  assert.equal(expressions.length, 2)
  assert.equal(expressions[0].id, expressions[1].id)
  assert.equal(expressions[0].candidates[0].targetText, 'spirit stone')
  assert.equal(expressions[1].candidates[0].targetText, 'spirit stone')
})

test('expressionsFromAssets: pendingEnrichment only for unannotated signature/notable concepts', () => {
  const annotated = expressionsFromAssets(
    [candidate('灵石')],
    [annotation('灵石', 'spirit stone')]
  )
  assert.equal(annotated.pendingEnrichment, false)

  const pending = expressionsFromAssets([candidate('灵石')], [])
  assert.equal(pending.pendingEnrichment, true)

  const glueOnly = expressionsFromAssets([candidate('这是', {salience: 'none'})], [])
  assert.equal(glueOnly.pendingEnrichment, false)
})

test('computeActionLevel: scaffolding sheds with per-word mastery, caps hold strangers back', () => {
  const fresh = computeActionLevel({risk: 'low', plotCriticality: 'low'}, undefined)
  assert.equal(fresh, 1) // brand-new word arrives fully glossed

  const mastered = computeActionLevel(
    {risk: 'low', plotCriticality: 'low'},
    {seenCount: 10, replacedCount: 5, explainCount: 0, frictionScore: 0, masteryScore: 2}
  )
  assert.equal(mastered, 4)

  const highRiskFresh = computeActionLevel({risk: 'high', plotCriticality: 'low'}, undefined)
  assert.equal(highRiskFresh, 1)

  // Proven mastery earns past the static plot cap.
  const plotCriticalMastered = computeActionLevel(
    {risk: 'low', plotCriticality: 'high'},
    {seenCount: 10, replacedCount: 5, explainCount: 0, frictionScore: 0, masteryScore: 2}
  )
  assert.ok(plotCriticalMastered >= 3)
})

test('planReplacements: fresh reader gets glossed signature vocab, names stay in source', () => {
  const {expressions} = expressionsFromAssets(
    [
      candidate('灵石', {conceptCanonical: 'spirit stone'}),
      candidate('林昭', {kind: 'name', salience: 'name', conceptCanonical: 'lin zhao'}),
    ],
    [
      annotation('spirit stone', 'spirit stone'),
      annotation('lin zhao', 'Lin Zhao', {shouldKeepSource: true, translations: []}),
    ]
  )
  const rules = planReplacements(
    expressions,
    {
      userId: 'u',
      contentId: 'b',
      targetLanguage: 'en',
      readingProgress: 0,
      currentStage: 1,
      memory: createReadingMemory('u', 'b'),
    },
    {budget: {density: 1}}
  )
  assert.equal(rules.length, 1)
  assert.equal(rules[0].from, '灵石')
  assert.equal(rules[0].to, 'spirit stone')
  assert.equal(rules[0].level, 1)
})

test('memory round-trip: interactions accrue and rebuild from rows', () => {
  let memory = createReadingMemory('u', 'b')
  memory = recordInteraction(memory, {
    type: 'replaced',
    userId: 'u',
    contentId: 'b',
    expressionId: 'spirit stone',
  })
  const stats = memory.expressionStats['spirit stone']
  assert.equal(stats.replacedCount, 1)
  assert.ok(stats.masteryScore > 0)

  const rebuilt = memoryFromRows('u', 'b', [
    {canonicalSource: 'spirit stone', ...stats},
  ])
  assert.deepEqual(rebuilt.expressionStats['spirit stone'], stats)
})

test('summarizeReadingMetrics: too-small samples yield no speed estimate', () => {
  const noisy = summarizeReadingMetrics([{chars: 100, durationMs: 5000, backtracks: 0}])
  assert.equal(noisy.charsPerMinute, null)

  const solid = summarizeReadingMetrics([{chars: 3000, durationMs: 60000, backtracks: 2}])
  assert.equal(solid.charsPerMinute, 3000)
  assert.equal(solid.backtrackRate, 2)
})

test('parseBookBundle validates and rejects malformed bundles', () => {
  const bundle = {
    format: 'lexweave.bundle',
    version: 1,
    producer: 'test@1',
    book: {
      kind: 'novel',
      sourceLanguage: 'zh',
      targetLanguage: 'en',
      sourceCharCount: 10,
      sectionCount: 1,
      segmentCount: 1,
    },
    strategy: {baseDensity: 0.5, promoteNotable: false},
    candidates: [candidate('灵石')],
    occurrences: [],
    annotations: [annotation('灵石', 'spirit stone')],
  }
  const parsed = parseBookBundle(JSON.stringify(bundle))
  assert.equal(parsed.candidates.length, 1)

  assert.throws(() => parseBookBundle({...bundle, format: 'something-else'}))
})
