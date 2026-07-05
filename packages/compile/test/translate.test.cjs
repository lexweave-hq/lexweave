const {test} = require('node:test')
const assert = require('node:assert/strict')
const {compileText, translateDocumentSegments, translationRunFingerprint} = require('../dist')
const {createDocumentFromPlainText} = require('@lexweave/core')

// In-memory TranslationRunStore for checkpoint/resume tests.
function memoryStore() {
  const batches = new Map() // fingerprint -> Map(batchIndex -> translations)
  const contexts = new Map()
  const chunks = new Map() // fingerprint -> Map(chunkIndex -> result)
  return {
    async loadBatches(fingerprint) {
      return new Map(batches.get(fingerprint) ?? [])
    },
    async saveBatch(fingerprint, batchIndex, translations) {
      if (!batches.has(fingerprint)) batches.set(fingerprint, new Map())
      batches.get(fingerprint).set(batchIndex, translations)
    },
    async loadContext(fingerprint) {
      return contexts.get(fingerprint) ?? null
    },
    async saveContext(fingerprint, context) {
      contexts.set(fingerprint, context)
    },
    async loadChunks(fingerprint) {
      return new Map(chunks.get(fingerprint) ?? [])
    },
    async saveChunk(fingerprint, chunkIndex, result) {
      if (!chunks.has(fingerprint)) chunks.set(fingerprint, new Map())
      chunks.get(fingerprint).set(chunkIndex, result)
    },
    _batches: batches,
    _chunks: chunks,
  }
}

function makeDocument(rawText) {
  return createDocumentFromPlainText({
    id: 'd',
    rawText,
    kind: 'novel',
    sourceLanguage: 'zh',
    defaultTargetLanguage: 'en',
  })
}

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

  // The extracted unit is still present alongside the substrate — demoted to
  // 'notable' because 灵石 occurs only once in RAW (freq-1 demotion).
  assert.ok(result.bundle.candidates.some((c) => c.sourceText === '灵石' && c.salience === 'notable'))
})

test('recurrence demotion: freq-1 extractions drop to notable, recurring ones stay signature', async () => {
  const raw = '他拿出三块灵石。\n\n灵石在夜里发光。\n\n他又摸了摸怀里的玉佩。'
  const llm = {
    async extractReadingUnits() {
      return {
        units: [
          {span: '灵石', evidence: '他拿出三块灵石。', translation: 'spirit stone',
           tier: 'word', keepSource: false, risk: 'low', plotCriticality: 'low', reason: 'stub'},
          {span: '玉佩', evidence: '他又摸了摸怀里的玉佩。', translation: 'jade pendant',
           tier: 'word', keepSource: false, risk: 'low', plotCriticality: 'low', reason: 'stub'},
        ],
        baseDensity: 0.5,
        note: 'stub',
      }
    },
  }
  const result = await compileText(
    {rawText: raw, title: 't', sourceLanguage: 'zh', targetLanguage: 'en'},
    {llm}
  )
  const bySrc = Object.fromEntries(result.bundle.candidates.map((c) => [c.sourceText, c]))
  assert.equal(bySrc['灵石'].salience, 'signature') // freq 2 → keeps its slot
  assert.equal(bySrc['玉佩'].salience, 'notable') // freq 1 → can never re-encounter → demoted
})

test('coverage floors in the extraction prompt scale with chunk size', () => {
  const {readingUnitsJob} = require('../dist')
  const chapter = (chars) => ({chapterId: 'c', sectionIdx: 0, title: null, text: '字'.repeat(chars)})
  const small = readingUnitsJob({book: {genre: 'novel', sourceLanguage: 'zh', targetLanguage: 'en'}, chapters: [chapter(1000)]})
  const large = readingUnitsJob({book: {genre: 'novel', sourceLanguage: 'zh', targetLanguage: 'en'}, chapters: [chapter(18000)]})
  assert.match(small.user, /AT LEAST ~6 word units/)
  assert.match(large.user, /AT LEAST ~27 word units, ~27 phrase units, and ~9 sentence units/)
  assert.match(large.user, /RECURRENCE/)
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

test('wire format: terse {i, t} results (prompt v3) normalize and checkpoint as {index, translation}', async () => {
  const document = makeDocument(RAW)
  const store = memoryStore()
  const terse = {
    async translateSegments(payload) {
      return {
        translations: payload.segments.map((segment) => ({
          i: segment.index,
          t: `[en] ${segment.text}`,
        })),
      }
    },
  }
  const result = await translateDocumentSegments(document, {llm: terse, store})
  assert.equal(result.missing, 0)
  assert.ok(result.segments.length > 0)
  for (const segment of result.segments) {
    assert.ok(segment.translation.includes(segment.sourceText))
  }
  // The checkpoint store must hold the canonical long-key form, not the wire form.
  const fingerprints = [...store._batches.keys()]
  assert.equal(fingerprints.length, 1)
  for (const stored of store._batches.get(fingerprints[0]).values()) {
    for (const item of stored) {
      assert.equal(typeof item.index, 'number')
      assert.equal(typeof item.translation, 'string')
      assert.equal(item.i, undefined)
      assert.equal(item.t, undefined)
    }
  }
})

// —— novel-translator borrowings: checkpoint, resume, fingerprint, quality gate ——

test('checkpoint: failed batches are not cached, a resumed run only re-translates them', async () => {
  const document = makeDocument(RAW)
  const store = memoryStore()

  const flaky = {
    calls: 0,
    async translateSegments(payload) {
      this.calls += 1
      if (payload.segments.some((segment) => segment.text.includes('山门'))) {
        throw new Error('transient outage')
      }
      return {
        translations: payload.segments.map((segment) => ({
          index: segment.index,
          translation: `[en] ${segment.text}`,
        })),
      }
    },
  }
  const run1 = await translateDocumentSegments(document, {
    llm: flaky,
    batchChars: 10, // one segment per batch → 3 batches
    store,
    retryDelayMs: 0,
  })
  assert.equal(run1.failedBatches, 1)
  assert.equal(run1.missing, 1)
  assert.equal(run1.segments.length, 2)
  assert.equal(run1.report.flagCounts['batch-failed'], 1)
  // Only the two successful batches were persisted.
  assert.equal(store._batches.get(run1.fingerprint).size, 2)

  const working = {
    calls: 0,
    async translateSegments(payload) {
      this.calls += 1
      return {
        translations: payload.segments.map((segment) => ({
          index: segment.index,
          translation: `[en] ${segment.text}`,
        })),
      }
    },
  }
  const run2 = await translateDocumentSegments(document, {
    llm: working,
    batchChars: 10,
    store,
    retryDelayMs: 0,
  })
  assert.equal(run2.cachedBatches, 2)
  assert.equal(working.calls, 1) // only the previously failed batch ran
  assert.equal(run2.missing, 0)
  assert.equal(run2.segments.length, 3)
  assert.equal(run2.fingerprint, run1.fingerprint)
})

test('fingerprint: glossary, salt, and text changes re-key the cache; identical inputs do not', () => {
  const document = makeDocument(RAW)
  const base = translationRunFingerprint(document, {glossary: []})
  assert.equal(base, translationRunFingerprint(document, {glossary: []}))
  assert.notEqual(
    base,
    translationRunFingerprint(document, {glossary: [{source: '灵石', target: 'spirit stone'}]})
  )
  assert.notEqual(base, translationRunFingerprint(document, {glossary: [], salt: 'openai:gpt'}))
  assert.notEqual(base, translationRunFingerprint(makeDocument(RAW + '\n\n他停下了。'), {glossary: []}))
  assert.notEqual(base, translationRunFingerprint(document, {glossary: [], batchChars: 100}))
})

test('echo-loss recovery: skipped segments are re-asked as a standalone mini-batch', async () => {
  const document = makeDocument(RAW)
  const seen = []
  const dropper = {
    async translateSegments(payload) {
      seen.push(payload.segments.map((segment) => segment.text))
      const translations = payload.segments
        .filter((segment) => seen.length > 1 || segment.index !== 1)
        .map((segment) => ({index: segment.index, translation: `[en] ${segment.text}`}))
      return {translations}
    },
  }
  const result = await translateDocumentSegments(document, {llm: dropper, retryDelayMs: 0})
  assert.equal(result.missing, 0)
  assert.equal(result.segments.length, 3)
  assert.equal(seen.length, 2)
  assert.deepEqual(seen[1], ['守门弟子点了点头。']) // ONLY the dropped segment was retried
})

test('quality gate: source echoes and glossary drift are flagged', async () => {
  const document = makeDocument(RAW)
  const echo = {
    async translateSegments(payload) {
      return {
        translations: payload.segments.map((segment) => ({
          index: segment.index,
          translation: segment.text, // untranslated echo; also misses the glossary form
        })),
      }
    },
  }
  const result = await translateDocumentSegments(document, {
    llm: echo,
    glossary: [{source: '灵石', target: 'spirit stone'}],
    retryDelayMs: 0,
  })
  assert.equal(result.report.flagCounts['source-echo'], 3)
  assert.equal(result.report.flagCounts['glossary-miss'], 1)
  assert.equal(result.report.translated, 3)
  const flagged = result.report.flags.find((flag) => flag.kind === 'glossary-miss')
  assert.ok(flagged.detail.includes('灵石'))
})

test('quality gate: truncation and lost numbers are flagged', async () => {
  const document = makeDocument('公元2024年,他带着100万灵石离开青云宗,一路向北,风雪千里不停歇。')
  const truncator = {
    async translateSegments(payload) {
      return {
        translations: payload.segments.map((segment) => ({index: segment.index, translation: 'go'})),
      }
    },
  }
  const result = await translateDocumentSegments(document, {llm: truncator, retryDelayMs: 0})
  assert.equal(result.report.flagCounts['length-anomaly'], 1)
  assert.equal(result.report.flagCounts['marker-loss'], 2) // 2024 and 100
})

test('total failure: when every batch errors the run throws instead of emitting an empty substrate', async () => {
  const document = makeDocument(RAW)
  const dead = {
    async translateSegments() {
      throw new Error('api key invalid')
    },
  }
  await assert.rejects(
    translateDocumentSegments(document, {llm: dead, batchChars: 10, retryDelayMs: 0}),
    /all 3 batches errored.*api key invalid/
  )
})

// —— Tsukuyomi borrowing: book brief injected into every batch, cached with the run ——

test('book brief: designed once, injected into every batch, reused from the store on re-runs', async () => {
  const store = memoryStore()
  let contextCalls = 0
  const seenContexts = []
  const llm = {
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
      }
    },
    async designTranslationContext(payload) {
      contextCalls += 1
      assert.ok(payload.excerpt.includes('灵石'), 'brief payload carries the opening excerpt')
      assert.deepEqual(payload.glossary, [{source: '灵石', target: 'spirit stone'}])
      return {
        synopsis: 'A cultivator enters the sect.',
        characters: [{name: '守门弟子', rendering: 'the gate disciple', notes: 'minor, formal speech'}],
        world: ['spirit stones are currency'],
      }
    },
    async translateSegments(payload) {
      seenContexts.push(payload.bookContext)
      return {
        translations: payload.segments.map((segment) => {
          let text = segment.text
          for (const entry of payload.glossary) {
            text = text.split(entry.source).join(entry.target)
          }
          return {index: segment.index, translation: `[en] ${text}`}
        }),
      }
    },
  }

  const input = {rawText: RAW, title: 't', sourceLanguage: 'zh', targetLanguage: 'en'}
  const run1 = await compileText(input, {llm, fullTranslation: true, runStore: store})
  assert.equal(contextCalls, 1)
  assert.ok(seenContexts.length > 0)
  assert.ok(
    seenContexts.every((context) => context && context.synopsis === 'A cultivator enters the sect.'),
    'every batch payload carries the book brief'
  )
  assert.equal(run1.translationContext.characters[0].rendering, 'the gate disciple')

  const run2 = await compileText(input, {llm, fullTranslation: true, runStore: store})
  assert.equal(contextCalls, 1, 'the brief comes from the store on the second run')
  assert.ok(run2.translationCachedBatches > 0, 'all batches come from the store on the second run')
  assert.equal(run2.translationMissing, 0)
  assert.equal(run2.translationContext.synopsis, 'A cultivator enters the sect.')
})

// —— extraction checkpoint: chunks resume, keeping the downstream glossary stable ——

test('extraction checkpoint: cached chunks skip the LLM and keep the glossary identical', async () => {
  const store = memoryStore()
  let extractCalls = 0
  const llm = {
    async extractReadingUnits() {
      extractCalls += 1
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
      }
    },
    async translateSegments(payload) {
      return {
        translations: payload.segments.map((segment) => ({
          index: segment.index,
          translation: `[en] ${segment.text}`,
        })),
      }
    },
  }

  const input = {rawText: RAW, title: 't', sourceLanguage: 'zh', targetLanguage: 'en'}
  const run1 = await compileText(input, {llm, fullTranslation: true, runStore: store})
  assert.equal(extractCalls, 1)
  assert.equal(run1.translationMissing, 0)

  const run2 = await compileText(input, {llm, fullTranslation: true, runStore: store})
  assert.equal(extractCalls, 1, 'extraction came from the chunk checkpoint')
  assert.ok(run2.translationCachedBatches > 0, 'stable glossary → same translation fingerprint → batches resumed')
  assert.deepEqual(
    run2.bundle.candidates.map((c) => c.sourceText).sort(),
    run1.bundle.candidates.map((c) => c.sourceText).sort(),
    'resumed compile reproduces the same units'
  )
})

test('extraction retry: one transient failure per chunk is absorbed', async () => {
  let attempts = 0
  const flakyOnce = {
    async extractReadingUnits() {
      attempts += 1
      if (attempts === 1) throw new Error('transient 500')
      return {units: [], baseDensity: 0.5, note: 'ok'}
    },
    async translateSegments(payload) {
      return {
        translations: payload.segments.map((segment) => ({
          index: segment.index,
          translation: `[en] ${segment.text}`,
        })),
      }
    },
  }
  const result = await compileText(
    {rawText: RAW, title: 't', sourceLanguage: 'zh', targetLanguage: 'en'},
    {llm: flakyOnce, retryDelayMs: 0}
  )
  assert.equal(attempts, 2)
  assert.ok(result.bundle)
})

// —— substrate granularity: paragraphs split into sentence-sized units ——

test('substrate granularity: a multi-sentence paragraph yields one unit PER SENTENCE', async () => {
  const {splitSentences} = require('../dist')
  assert.deepEqual(splitSentences('他拿出三块灵石。守门弟子点了点头。他走进了山门。'), [
    '他拿出三块灵石。',
    '守门弟子点了点头。',
    '他走进了山门。',
  ])
  assert.deepEqual(splitSentences('“不去了。”他说：“太晚了！”真的吗?'), [
    '“不去了。”',
    '他说：“太晚了！”',
    '真的吗?',
  ])
  assert.deepEqual(splitSentences('Version 3.5 shipped. It works well.'), [
    'Version 3.5 shipped.',
    'It works well.',
  ])

  // One PARAGRAPH (single document segment) containing three sentences…
  const paragraph = '他拿出三块灵石。守门弟子点了点头。他走进了山门。'
  const result = await compileText(
    {rawText: paragraph, title: 't', sourceLanguage: 'zh', targetLanguage: 'en'},
    {llm: stubLlm, fullTranslation: true}
  )
  // …becomes three sentence-tier substrate units, not one paragraph unit.
  const sentences = result.bundle.candidates.filter((c) => c.kind === 'sentence_pattern')
  assert.equal(result.bundle.book.segmentCount, 1)
  assert.equal(sentences.length, 3)
  assert.ok(sentences.every((c) => c.sourceText.length < paragraph.length))
})
