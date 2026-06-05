# Codex Guidance

Codex Guidance is a hooks-only Codex plugin that loads Markdown guidance into Codex sessions.

It provides Claude Code-style path-scoped rules, but uses the name `guidance` to keep the feature separate from Codex command-permission rules.

## What It Does

- Loads global guidance at session start.
- Loads path-scoped guidance after matching file reads.
- Loads path-scoped guidance before matching edits, denies the first edit, and asks Codex to retry after seeing the guidance.
- Resets loaded guidance state after compaction so guidance can be reloaded for the next context generation.
- Stores session state and guidance cache in a SQLite database under `PLUGIN_DATA` for faster repeated hook runs and safer concurrent access.

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

Files with `paths` are path-scoped guidance:

```markdown
---
paths:
  - "src/**/*.ts"
  - "test/**/*.ts"
---

# TypeScript

Prefer strict types and focused Vitest coverage.
```

Only the `paths` front matter field is supported. Front matter is stripped before guidance is injected.

## Runtime Data

Runtime storage is kept outside the repository in one SQLite database:

```text
${PLUGIN_DATA}/db/codex-guidance.sqlite
```

The plugin does not write runtime state into `.codex/`, `.agents/`, or `.claude/` inside the repository.

## Development

Node.js 22.17 or newer is required because the plugin uses the built-in `node:sqlite` module.

Install dependencies:

```bash
npm install
```

Build compiled hook scripts:

```bash
npm run build
```

Run checks:

```bash
npm run typecheck
npm test -- --run
python3 /home/explodingkonjac/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py .
```

## Published Contents

The package includes only the plugin manifest, hook configuration, compiled hook scripts, README, license, and design documentation. TypeScript source and tests are development-only.
