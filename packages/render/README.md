# @lexweave/render

The Lexweave renderer: deterministic, zero-dependency replacement injection.

- `createReplacementEngine` — longest-match-first text-run transform over HTML
  or plain text; never touches tag interiors; per-section spatial budget
  (coverage + min-gap); CJK↔Latin "pangu" spacing; action-level display
  shaping (A1 灵石（spirit stone） → A4 spirit stone).
- `densityRenderOptions` — maps a flow-budget density (0..1) onto the spatial
  controls, so every render target agrees.
- `transformText` — one-shot helper for plain text.

This exact module is bundled into the ai-noval-reader WebView runtime, used by
the CLI's HTML/text output, and importable from any web page or extension.
