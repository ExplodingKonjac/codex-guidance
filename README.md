# Codex Guidance

Codex Guidance is a hooks-only Codex plugin that loads Markdown guidance into Codex sessions.

It provides Claude Code-style path-scoped rules, but uses the name `guidance` to keep the feature separate from Codex command-permission rules.

## What It Does

- Loads global guidance at session start.
- Loads path-scoped guidance after matching file reads.
- Loads path-scoped guidance before matching edits, denies the first edit, and asks Codex to retry after seeing the guidance.
- Tracks loaded guidance on Codex turn IDs, so rewind, fork, and compaction inherit only guidance still visible in the current model context.
- Treats compaction as a generation boundary so pre-compaction guidance can be reloaded when needed.
- Stores session state and guidance cache in a SQLite database under `PLUGIN_DATA` for faster repeated hook runs and safer concurrent access.

## Installation

It is recommended to install through Codex plugin marketplace.

Add this repo as a marketplace:

```bash
codex plugin marketplace add ExplodingKonjac/codex-guidance
```

Then install the plugin:

```bash
codex plugin add codex-guidance@codex-guidance
```

## Guidance Locations

The plugin discovers Markdown guidance from:

```text
~/.codex/guidance
<repo>/.codex/guidance
<repo>/.agents/guidance
<repo>/.claude/rules
```

All locations support nested directories. Files ending in `.md` or `.markdown` are loaded.

## Guidance Format

Files without front matter are global guidance:

```markdown
# Preferences

Use concise explanations and preserve local style.
```

Files with a `paths` front matter block are path-scoped guidance:

```markdown
---
paths:
  - "src/**/*.ts"
  - "test/**/*.ts"
---

# TypeScript

Prefer strict types and focused native test coverage.
```

Only a narrow `paths` block-list front matter format is supported. The parser accepts unquoted, single-quoted, and double-quoted list items, and rejects broader YAML features such as inline arrays or additional keys. Front matter is stripped before guidance is injected.

## Development

Node.js 22.17 or newer is required because the plugin uses the built-in `node:sqlite` module.

Install dependencies:

```bash
npm install
```

Build the committed runtime JS under `scripts/`:

```bash
npm run build
```

Run checks:

```bash
npm run typecheck
npm run build
npm test
```
