# Contributing to Lexweave

Thanks for helping build the open engine for progressively bilingual reading.

## Dev setup

```bash
git clone https://github.com/lexweave-hq/lexweave && cd lexweave
npm install
npm run build      # tsc -b for the packages + esbuild bundle for the CLI
npm test           # node:test suites (core / compile / render)
```

Requirements: Node ≥ 20. No global tooling — everything runs through npm
scripts.

## Repo layout

```
packages/core      engine: unit model, bundle format, planner, learner state
packages/compile   compiler: chunking, verbatim scan, LLM job specs, passes
packages/render    renderer: zero-dep replacement transform (HTML/text)
packages/cli       lexweave CLI + Anthropic/OpenAI/mock providers
```

Design rules worth knowing before you open a PR:

- **LLM at compile time only.** Nothing under `render` or the read path may
  call a model, ever.
- **Ports over dependencies.** Packages never import a provider SDK, database,
  or UI framework. LLM access goes through the `LexweaveLlm` port.
- **Verbatim spans are the contract.** Extracted units must locate in the book
  by exact substring match; anything that breaks that breaks the renderer.
- **`@lexweave/render` stays zero-dependency.** It is bundled into WebViews
  and browser extensions.

## Tests

- Unit tests live in `packages/*/test/*.test.cjs` and run against the built
  `dist/` via `node:test` (no test framework dependency).
- CI smoke-checks the published Fanren playground in `docs/index.html`. If you
  change replacement behavior, inspect that page once in a browser.
- Add a test with every behavior change. Bug fixes need a test that fails
  before the fix.

## Pull requests

- Keep PRs focused; separate refactors from behavior changes.
- Match the existing code style (Prettier-ish, no semicolons, 2-space indent).
- Sign off your commits (DCO): `git commit -s`. By signing off you certify
  the [Developer Certificate of Origin](https://developercertificate.org/).

## Good first contributions

- Additional language pairs: segmentation heuristics, stopword lists, spacing
  rules (see `packages/core/src/document.ts` / `stopwords.ts`).
- New LLM provider adapters for the CLI (see `packages/cli/src/providers/`).
- Render targets: browser extension, static-site generator plugins.
