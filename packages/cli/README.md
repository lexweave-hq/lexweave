# lexweave (CLI)

```
lexweave compile <input.txt> --source zh --target en [--provider anthropic|openai|mock] [-o out.lexweave.json]
lexweave render  <input.txt> --bundle out.lexweave.json [--density 0.6] [--mastery 3] [--format html|text] [-o out.html]
lexweave inspect <bundle.json>
```

- Providers: Anthropic (`ANTHROPIC_API_KEY`), OpenAI (`OPENAI_API_KEY`), and a
  deterministic offline `mock` (`--glossary file.json`) for tests.
- `render` produces a self-contained HTML learning edition with tap-to-reveal,
  or plain text; `--mastery N` previews how the page sheds scaffolding as the
  reader learns.
- Build: `node packages/cli/build.cjs` (esbuild single-file bundle).
