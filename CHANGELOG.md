# Changelog

All notable changes to the Lexweave packages are documented here. Versions are
released in lockstep across `@lexweave/core`, `@lexweave/compile`,
`@lexweave/render`, and `lexweave`.

## 0.2.0 — 2026-07-04

Full-translation substrate + mastery semantics fix (breaking).

- **@lexweave/compile** — new full-translation substrate: `compileText(…,
  {fullTranslation: true})` (CLI: `lexweave compile --full`) translates EVERY
  segment of the book (batched, glossary-consistent with the extracted
  signature vocabulary, concurrent) and carries each one as a sentence-tier
  unit at salience `common`. The weave now selects from a COMPLETE bilingual
  substrate: density 1.0 with all tiers unlocked renders the whole book in the
  target language; lower densities weave signature vocabulary first. New
  `translateSegments` port on `LexweaveLlm`, `translateSegmentsJob` spec, and
  `translateDocumentSegments` helper.
- **@lexweave/core** — sentence-tier units bypass the word-level n-gram guards
  (boundary-fragment, name-overlap, synonym-list cleanup), so whole segments
  containing names and commas replace correctly.
- **@lexweave/core** — macro progression is a RAMP, not a cliff (breaking:
  `unlockedTiers` replaced by `tierQuotas`). Mastery accrues as continuous
  mass: each graduating word EARNS phrase slots, each graduating phrase earns
  sentence slots (plus a self-term so the cascade reaches full coverage).
  Within a tier, admission is ordered by READINESS — a phrase/sentence whose
  text is already covered by surfaces the reader reads in the target language
  (retired or A3+) flips first (comprehensible input / i+1) — so larger units
  appear sporadically where mastered vocabulary clusters and densify smoothly,
  instead of whole passages flipping at a threshold. `RuntimeReplacement`
  gains a `tier` field.
- **@lexweave/render** — `densityRenderOptions(1)` now uncaps coverage (full
  density means FULL); the matcher indexes rules by first character, keeping
  per-page renders at ~1ms even with thousands of substrate rules.

Mastery semantics fix (breaking): a mastered word must never revert to source.

- **@lexweave/core** — a word whose `masteryScore` reaches `MASTERY_RETIRE` no
  longer disappears from the plan (which silently reverted it to source text
  for the rest of the book). It now graduates: `planReplacements` keeps it in
  the rule set as bare target (A4) marked `retired: true`, outside the density
  cap, so mastery only ever GROWS the target-language share of the page.
  Tap-to-reveal keeps working on graduated words — a tap there is a recall
  check, so `FRICTION_DROP` now only drops words still being learned.
- **@lexweave/core** (breaking) — removed the dead legacy per-segment path:
  `renderSegment`, the `RenderSegmentResult` type, and the planner options
  `maxReplacementDensity` / `charsPerReplacement` / `minReplacementGap` /
  `explainableReplacements` (spatial thinning is `@lexweave/render`'s job).
  `planReplacements` without an explicit `budget` now anchors at
  `DEFAULT_DENSITY` instead of the old stage ladder.
- **@lexweave/render** — coverage now bills the rendered DISPLAY width
  (CJK glyph ≈ 2, Latin ≈ 1) instead of the source span length, so an A1 gloss
  like 灵石（spirit stone） costs what the reader actually sees; pages honor
  the coverage knob instead of rendering 2–4× denser than it claims. Rules
  with `retired: true` are budget-transparent: they always replace and consume
  no coverage/min-gap. `ReplacementRule.retired` and `ReplacementMatch.retired`
  added.

## 0.1.1 — 2026-07-03

Republish: `@lexweave/compile@0.1.0` was burned on npm (published then
unpublished; npm permanently blocks reusing a version). All four packages move
to 0.1.1 in lockstep; inter-package dependencies now use `^0.1.1`. No code
changes.

## 0.1.0 — 2026-07-03

Initial public release.

- **@lexweave/core** — language-unit model; `lexweave.bundle` format v1 with
  zod validation ([spec](./packages/core/BUNDLE_SPEC.md)); LLM-free candidate
  mining; flow budget + A1–A4 action-level policy with per-word mastery;
  word → phrase → sentence tier unlocks; replacement planner with keyness
  priority and name/fragment suppression; learner-state memory and session
  assembly.
- **@lexweave/compile** — `compileText`/`compileDocument` pipeline (chunk →
  extract → verbatim scan → bundle); single `LexweaveLlm` port; provider-
  neutral job specs (prompts + strict JSON schemas); optional passes: keyness
  triage + concept grouping, per-book strategy design, batch enrichment with
  per-batch persistence; O(book) single-pass span scanner.
- **@lexweave/render** — zero-dependency replacement engine: tag-safe
  longest-match transform for HTML and plain text, per-section coverage +
  min-gap spatial budget, CJK↔Latin spacing, action-level display shaping;
  `densityRenderOptions` flow-budget mapping.
- **lexweave (CLI)** — `compile` / `render` / `inspect`; Anthropic, OpenAI,
  and offline mock providers; self-contained HTML learning editions with
  tap-to-reveal; `--mastery` preview of scaffolding decay.
- Offline demo corpus (original xianxia short + glossary) and 24 node:test
  cases.
