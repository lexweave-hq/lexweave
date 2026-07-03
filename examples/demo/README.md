# Offline demo

An end-to-end run of the compile → inspect → render pipeline with **no API
key**: the `mock` provider "extracts" the reading units listed in
`glossary.json` instead of asking a model, so the output is deterministic.

`sample-book.txt` is an original three-chapter xianxia short written for this
demo — its signature vocabulary (灵石, 聚气丹, 筑基, 储物袋…) recurs across
chapters exactly the way a real webnovel's does.

```bash
# from the repo root
npm install && npm run build
npm run demo
open examples/demo/sample-book.html   # tap a highlighted word to reveal the source
```

Or step by step:

```bash
cd examples/demo

# 1. compile the book into a learning-edition bundle (offline)
node ../../packages/cli/dist/lexweave.cjs compile sample-book.txt \
  --source zh --target en --provider mock --glossary glossary.json \
  -o sample-book.lexweave.json

# 2. what did the compiler learn?
node ../../packages/cli/dist/lexweave.cjs inspect sample-book.lexweave.json

# 3. preview how the page evolves as the reader masters words
node ../../packages/cli/dist/lexweave.cjs render sample-book.txt \
  --bundle sample-book.lexweave.json --format text --mastery 0   # A1: 灵石（spirit stone）
node ../../packages/cli/dist/lexweave.cjs render sample-book.txt \
  --bundle sample-book.lexweave.json --format text --mastery 3   # A4: bare "spirit stone"
```

With a real key, drop `--provider mock --glossary …` and the LLM discovers the
units itself:

```bash
export ANTHROPIC_API_KEY=sk-...
node ../../packages/cli/dist/lexweave.cjs compile sample-book.txt --source zh --target en
```
