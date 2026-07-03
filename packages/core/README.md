# @lexweave/core

The Lexweave engine: everything that is true about a book and a reader,
independent of any LLM, database, or UI.

- **Language-unit model + bundle format** (`assets.ts`, `BUNDLE_SPEC.md`) —
  `UnitCandidate` / `UnitOccurrence` / `UnitAnnotation` / `BookBundle`.
- **Document model** (`document.ts`) — chapter/paragraph segmentation.
- **Deterministic analysis** (`deterministic-analysis.ts`) — LLM-free n-gram
  candidate mining (Pass 0).
- **Flow budget + action levels** (`flow-budget.ts`) — density from live
  reading signals; per-word scaffolding ladder A1→A4; word/phrase/sentence
  tier unlocks.
- **Replacement planner** (`replacement-planner.ts`) — which units surface, at
  which level, name/fragment suppression, priority by keyness.
- **Learner state** (`memory.ts`, `session.ts`) — per-unit mastery/friction
  memory, interaction updates, session assembly from stored rows.

Only dependency: `zod`. Runs in Node, browsers, and React Native.

See the monorepo README one directory up for the full architecture.
