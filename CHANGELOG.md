# Changelog

All notable changes to the Lexweave packages are documented here. Versions are
released in lockstep across `@lexweave/core`, `@lexweave/compile`,
`@lexweave/render`, and `lexweave`.

## 0.2.0 — 2026-07-03

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
