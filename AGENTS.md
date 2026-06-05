# AGENTS.md

## Project Summary

`codex-guidance` is a hooks-only Codex plugin that injects Markdown guidance into Codex sessions.

- Global guidance loads at `SessionStart`.
- Path-scoped guidance loads after matching reads in `PostToolUse`.
- Before matching edits in `PreToolUse`, the plugin injects guidance, denies the first edit, and expects Codex to retry with the new context.
- `PostCompact` advances session generation so guidance can be reloaded after compaction.

This repo is a plugin repo, not a general-purpose app. The important contract is the hook lifecycle and the exact JSON/output shape Codex expects.

## Source Of Truth

Read these first before making changes:

1. `README.md` for the user-facing behavior and installation flow.
2. `DESIGN.md` for the intended architecture and lifecycle.
3. `hooks/hooks.json` for the runtime hook wiring.
4. `.codex-plugin/plugin.json` for the plugin manifest.
5. `src/hooks/*.ts` and `src/core/*.ts` for implementation.

## Layout

- `src/core/`
  Core logic for discovery, parsing, matching, rendering, path extraction, SQLite cache, and session state.
- `src/hooks/`
  Hook handlers and shared hook utilities.
- `scripts/`
  Committed compiled runtime JS.
- `scripts/hooks/`
  Direct hook entrypoints referenced by `hooks/hooks.json`.
- `scripts/core/`
  Runtime support modules used by the hook entrypoints.
- `.agents/plugins/marketplace.json`
  Self-reference marketplace entry for local Codex plugin discovery.
- `plugins/codex-guidance -> ..`
  Required local symlink for the self-reference marketplace layout.

## Editing Rules

- Edit `src/**` first. Treat `scripts/**` as committed runtime artifacts that must be regenerated and kept in sync with source changes.
- If you change hook behavior, keep `hooks/hooks.json`, `src/hooks/*`, and `scripts/hooks/*` aligned.
- If you change plugin metadata or install behavior, review both `.codex-plugin/plugin.json` and `.agents/plugins/marketplace.json`.
- Do not add MCP-specific architecture unless the task explicitly asks for it. The current design is hook-only.
- Keep guidance semantics narrow: only `paths` is supported in front matter.
- Keep runtime state outside the repo. The plugin writes SQLite state under `${PLUGIN_DATA}/db/codex-guidance.sqlite`.

## Runtime Assumptions

- Node.js `>=22.17` is required because runtime storage uses `node:sqlite`.
- Hook scripts are invoked through `${PLUGIN_ROOT}/scripts/hooks/*.js`.
- Hook handlers communicate through JSON on stdin/stdout and must preserve Codex hook payload structure.
- Read/write behavior depends on extracting file paths from tool payloads, including MCP-style tool names and `apply_patch` headers.

## Validation

Run the smallest relevant checks after changes:

```bash
npm run typecheck
npm test
```

If you changed source that feeds the committed runtime scripts or anything consumed by `hooks/hooks.json`, also run:

```bash
npm run build
```

Focus tests by area when possible:

- `src/hooks/hooks.test.ts` for hook lifecycle behavior
- `src/core/discover.test.ts` for guidance discovery and cache behavior
- `src/core/parse.test.ts` for front matter parsing rules
- `src/core/path_extract.test.ts` for tool payload path extraction
- `src/core/sqlite.test.ts` and `src/core/state.test.ts` for runtime storage/state behavior

## Change Guidance

- For guidance loading bugs, inspect `src/hooks/common.ts`, `src/core/discover.ts`, `src/core/match.ts`, and `src/core/render.ts` together.
- For edit-denial or retry behavior, start with `src/hooks/pre_tool_use.ts`.
- For read-triggered loading, start with `src/hooks/post_tool_use.ts`.
- For session generation/reset issues, start with `src/hooks/post_compact.ts` and `src/core/state.ts`.
- For missing or incorrect matched paths, inspect `src/core/path_extract.ts` before changing hook routing.
- For cache or concurrency issues, inspect `src/core/sqlite.ts`, `src/core/cache.ts`, and `src/core/state.ts`.

## Docs And Packaging

- Keep `README.md` and `DESIGN.md` consistent with actual hook behavior.
- Preserve the local marketplace layout:
  - `.agents/plugins/marketplace.json` uses `./plugins/codex-guidance`
  - `plugins/codex-guidance` should remain a symlink to the repo root
- If the installation surface changes, verify both the plugin manifest and marketplace entry still describe the same plugin.
