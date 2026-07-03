# @lexweave/compile

The Lexweave compiler: book text in, portable learning-edition bundle out.

- `compileText` / `compileDocument` — chunk → extract reading units (one LLM
  call per chunk) → verbatim-scan the whole book → bundle.
- `LexweaveLlm` port (`ports.ts`) — the single seam to any model; implement it
  with a direct API call, an edge function, a queue, or a mock.
- Job specs (`jobs.ts`) — the prompts + strict JSON schemas for every compile
  job, provider-neutral.
- Optional passes: `rateBookIntelligence` (keyness triage + concept grouping),
  `designStrategy` (per-book density anchor), `enrichAnnotations` (batch
  translation with per-batch persistence).
- `scanUnitStats` — O(book chars) single-pass frequency/dispersion scanner
  that never blocks a single-threaded host.

LLM runs at compile time only. See `../README.md` and `../core/BUNDLE_SPEC.md`.
