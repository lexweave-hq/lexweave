# Security Policy

## Reporting a vulnerability

Please use GitHub's **private vulnerability reporting** on this repository
(Security → Report a vulnerability) instead of opening a public issue.

We will acknowledge reports within 7 days. Please include a reproduction and
the affected package/version.

## Scope notes

- `@lexweave/render` injects replacement markup into HTML. Escaping of
  attribute/text content in the default renderer is security-relevant —
  reports about markup injection through crafted rules or book text are very
  welcome.
- The CLI sends book text to the LLM provider you configure. API keys are
  read from environment variables and are never written to disk by Lexweave.

## Supported versions

Pre-1.0: only the latest published minor receives fixes.
