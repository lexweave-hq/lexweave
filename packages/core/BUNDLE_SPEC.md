# Lexweave Learning-Edition Bundle — Format Spec v1

A **bundle** is the portable artifact one compile produces for one book:
everything a renderer needs to produce a progressively bilingual edition,
decoupled from any storage engine and from any reader's personal state.

- Media type: JSON (UTF-8). Suggested extension: `.lexweave.json`.
- Validation: `parseBookBundle()` in `@lexweave/core` (zod schema
  `bookBundleSchema`).
- Versioning: `format` is always `"lexweave.bundle"`; `version` is an integer.
  Breaking changes bump `version`. Additive optional fields do not.

```jsonc
{
  "format": "lexweave.bundle",
  "version": 1,
  "producer": "lexweave-cli-anthropic@1",   // idempotency tag: pipeline+prompt version
  "book": {
    "contentHash": "…",                      // optional stable content id
    "title": "诡秘之主",
    "kind": "novel",                         // novel | book | paper | report | transcript
    "sourceLanguage": "zh",
    "targetLanguage": "en",
    "sourceCharCount": 1248,
    "sectionCount": 3,
    "segmentCount": 26
  },
  "strategy": {                              // per-book replacement strategy
    "baseDensity": 0.6,                      // 0..1 anchor; live feedback floats around it
    "promoteNotable": false,                 // surface notable vocab early if few signature terms
    "note": "…"
  },
  "candidates": [ /* UnitCandidate */ ],
  "occurrences": [ /* UnitOccurrence */ ],
  "annotations": [ /* UnitAnnotation */ ]
}
```

## UnitCandidate — one learnable surface form

The per-surface row. `sourceText` is a **verbatim span**: it appears in the
book text character-for-character, so any renderer can locate it by exact
substring match — the same contract for a word, a phrase, or a sentence.

```jsonc
{
  "canonicalSource": "灵石",       // this surface's own id
  "sourceText": "灵石",            // verbatim span (the match key)
  "kind": "term",                 // term | phrase | sentence_pattern | name | word
  "frequency": 184,               // non-overlapping occurrences in the whole book
  "dispersion": 0.67,             // share of sections containing the span (0..1)
  "salience": "signature",        // signature | notable | common | name | none  (keyness)
  "conceptCanonical": "spirit stone"  // concept-family key (variants share one)
}
```

`kind` maps onto the macro tier ladder (word → phrase → sentence) that
unlocks with proficiency. `salience` is a **keyness** judgment — how
characteristic of THIS book — not raw frequency; `name` units stay in source
by default.

## UnitOccurrence — a representative location

```jsonc
{
  "canonicalSource": "灵石",
  "sectionIdx": 2, "segmentIdx": 14,
  "start": 6, "end": 8,           // char offsets within the segment
  "before": "他拿出三块", "text": "灵石", "after": "，递给守门弟子"
}
```

One representative occurrence per candidate is required (context for
enrichment / explain panels); emitting all occurrences is allowed.

## UnitAnnotation — the replacement policy for one concept

Keyed by `conceptCanonical`, not by surface: all variants of a concept inherit
one annotation and share one mastery row.

```jsonc
{
  "canonicalSource": "spirit stone",   // = the concept key
  "producer": "lexweave-cli-anthropic@1",
  "translations": [{
    "targetLanguage": "en", "targetText": "spirit stone",
    "register": "plain",               // plain | literary | technical
    "confidence": 0.95, "notes": "…"
  }],
  "risk": "low",                       // translation risk: low | medium | high
  "plotCriticality": "low",            // SECOND axis: plot-comprehension cost (caps action level)
  "replacementStage": 1,               // difficulty ladder (1-5); modulates deferred bands
  "shouldKeepSource": false,           // true → never replace (names, untranslatables)
  "mapperKind": "translate",           // translate | simplify
  "explanation": "…"                   // optional longer gloss (simplify mapper)
}
```

## What is deliberately NOT in the bundle

- **Learner state** (per-unit mastery/friction rows, reading metrics): per
  user, lives with the host. Shapes: `ReadingMemoryRow`,
  `ReadingMetricsSample` in `@lexweave/core`.
- **The book text itself**: the bundle carries offsets and context windows
  only, so it can be distributed without redistributing the work.

## Render contract (informative)

1. `expressionsFromAssets(candidates, annotations)` → planner expressions.
2. `planReplacements(expressions, sessionState, {budget})` → book-wide rules
   (which words, at which action level), gated by learner memory.
3. `createReplacementEngine({rules, coverage, minGap})` →
   `transformSection(html)` injects `<span class="ai-rep" data-level data-src>`
   runs; `densityRenderOptions(density)` maps the flow budget onto
   coverage/min-gap.
4. Report exposures (`appliedSources`) and taps back into learner state via
   `recordInteraction` — the next render adapts.
