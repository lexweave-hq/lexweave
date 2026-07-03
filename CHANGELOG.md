# Changelog

All notable changes to the Lexweave packages are documented here. Versions are
released in lockstep across `@lexweave/core`, `@lexweave/compile`,
`@lexweave/render`, and `lexweave`.

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
