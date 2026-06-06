# Codex Guidance Plugin: Design Documentation

## Purpose

This project implements **prompt-based, path-scoped guidance** for Codex.

It is inspired by Claude Code’s path-scoped rules, but uses the name **guidance** because Codex already uses `.codex/rules` for command permission control. Guidance is advisory model context, not an enforcement or security mechanism.

## Scope

The plugin loads Markdown guidance from:

```text
~/.codex/guidance
<repo>/.codex/guidance
<repo>/.agents/guidance
<repo>/.claude/rules
```

All directories support subdirectories.

Each Markdown file may contain a narrow front matter block with only one supported field:

```text
paths:
  - "src/**/*.ts"
```

Files without `paths` are **global guidance**. Files with `paths` are **path-scoped guidance**.

## Core Behavior

The plugin uses Codex hooks only. MCP is not part of the MVP.

```text
SessionStart:
  Load global guidance.

Read / PostToolUse:
  When Codex reads a matching file, load matching path-scoped guidance.

Edit / PreToolUse:
  Before Codex edits a matching file, check whether matching guidance has already been loaded.
  If not, inject the guidance and deny the current edit so Codex retries after seeing the guidance.

PostCompact:
  Reset loaded guidance state for the current session generation.
  Reload guidance lazily on the next matching read or edit.
```

## Why No MCP in MVP

MCP is unnecessary for the core feature. The core problem is lifecycle-based context injection, which is a hook responsibility.

MCP may be added later for optional inspection tools:

```text
guidance.status
guidance.list
guidance.match
guidance.reload
```

If added later, MCP should be written in TypeScript, use stdio transport, and reuse the same core library as the hooks.

## Recommended Technology

Use **TypeScript**.

Reasons:

```text
- Simple npm distribution.
- Shared implementation between hooks and optional future MCP.
- Good fit for filesystem scanning, front matter parsing, glob matching, and JSON hook IO.
```

Recommended modules:

```text
core/discover
core/parse
core/match
core/render
core/state
core/path_extract
```

## Project Structure

Committed runtime hook scripts should live in `scripts/`, with `scripts/hook_entry.js` serving as the single direct hook entrypoint.

```text
codex-guidance/
├── .codex-plugin/
│   └── plugin.json
├── hooks/
│   └── hooks.json
├── scripts/
│   ├── core/
│   └── hook_entry.js
├── src/
│   ├── core/
│   │   ├── discover.ts
│   │   ├── parse.ts
│   │   ├── match.ts
│   │   ├── render.ts
│   │   ├── state.ts
│   │   └── path_extract.ts
│   └── hook_entry.ts
└── test/
```

`src/core/*` and `src/hook_entry.ts` contain TypeScript source.

`scripts/hook_entry.js` contains the committed JavaScript runtime entrypoint referenced by Codex.

`scripts/core/*` contains committed compiled runtime support code produced from `src/`.

## Hook Configuration

`hooks.json` should reference compiled files under `${PLUGIN_ROOT}/scripts/...`.

Conceptually:

```text
SessionStart:
  ${PLUGIN_ROOT}/scripts/hook_entry.js --hook session_start

PostToolUse:
  ${PLUGIN_ROOT}/scripts/hook_entry.js --hook post_tool_use

PreToolUse:
  ${PLUGIN_ROOT}/scripts/hook_entry.js --hook pre_tool_use

PostCompact:
  ${PLUGIN_ROOT}/scripts/hook_entry.js --hook post_compact
```

This avoids runtime TypeScript execution inside Codex hooks and keeps plugin execution predictable.

## Guidance Discovery

Guidance is discovered from four sources:

```text
user:    ~/.codex/guidance
codex:   <repo>/.codex/guidance
agents:  <repo>/.agents/guidance
claude:  <repo>/.claude/rules
```

Each guidance file receives a stable ID:

```text
source:relative/path.md
```

Examples:

```text
user:preferences.md
codex:backend/api.md
agents:frontend/react.md
claude:testing.md
```

Only Markdown files are loaded. Oversized files, invalid front matter, and files outside configured roots should be skipped safely.

The front matter parser intentionally supports only a top-level `paths` block list of strings. Broader YAML features such as inline arrays, nested objects, anchors, and additional keys are not supported.

## Discovery Cache

Guidance discovery may cache parsed root results outside the repository in SQLite:

```text
${PLUGIN_DATA}/db/codex-guidance.sqlite
```

Each cache row represents one guidance root and stores the source, absolute root path, recursive Markdown metadata signature, max file size, parsed guidance documents, and discovery issues.

The recursive metadata signature should include Markdown relative paths, file sizes, and modification times. Non-Markdown files should not invalidate the cache.

Cache reads and writes are fail-open. If a cache entry is missing, corrupted, stale, version-incompatible, or unwritable, discovery should parse the root normally and continue.

## Matching Model

All file paths should be normalized to repository-relative POSIX-style paths before matching.

Path matching should use glob semantics compatible with Claude-style rules.

Guidance without `paths` is global.

Guidance with `paths` is loaded when any pattern matches the read or edited file path.

## Injection Format

Guidance should be injected as explicit tagged context:

```text
Below are guidance related to the current file. You must follow them in later actions:

<guidance id="user:preferences.md">
[Markdown content]
</guidance>

<guidance id="codex:backend/api.md">
[Markdown content]
</guidance>
```

For global guidance:

```text
Below are global guidance for this session. You must follow them in later actions:

<guidance id="user:preferences.md">
[Markdown content]
</guidance>

<guidance id="codex:backend/api.md">
[Markdown content]
</guidance>
```

Front matter should not be included in the injected content.

The plugin should also surface a concise status message:

```text
codex:backend/api.md loaded
```

## Session State

Session state should be saved outside the repository in the same SQLite database:

```text
${PLUGIN_DATA}/db/codex-guidance.sqlite
```

The plugin should not write session state into:

```text
<repo>/.codex/
<repo>/.agents/
<repo>/.claude/
```

Session state is runtime data, not project configuration.

Use two logical tables:

```text
session_state(session_id, generation)
session_loaded_guidance(session_id, generation, guidance_id)
```

The only required information is the current generation and the set of guidance IDs already injected for each generation.

A guidance file is considered already loaded only if its ID appears in `loaded[current generation]`.

## State Locking

Hooks may run close together, so state updates should rely on SQLite write locking plus a short busy timeout.

If the database cannot be opened or a write lock cannot be acquired quickly, the plugin should fail open:

- Do not block Codex.
- Do not inject uncertain or duplicate guidance.
- Do not deny an edit unless newly matched guidance was successfully loaded and recorded.

## Compact Handling

Do not try to preserve or summarize guidance during compact.

Instead:

```text
PostCompact:
  Increment generation.
  Initialize an empty loaded set for the new generation.

Next matching Read or Edit:
  Reload matching guidance if needed.
```

This keeps compact behavior simple and reliable.

## Edit Handling

For edits, use a conservative deny-and-retry model.

If Codex tries to edit a file whose matching guidance has not been loaded:

1. Inject matching guidance.
2. Mark it as loaded.
3. Deny the current edit.
4. Ask Codex to retry after applying the loaded guidance.

If matching guidance is already loaded in the current generation, the edit proceeds normally.

## Read Handling

For reads, inject matching guidance after the file is read.

This mirrors Claude Code-style behavior: path-scoped guidance becomes relevant when the model begins working with a matching file.

The implementation should only trigger when the hook can confidently identify the read file path.

## Path Extraction

The MVP should support path extraction from:

- `apply_patch` edits
- obvious MCP read/write/edit tool inputs
- simple known path fields such as path, filePath, filepath, file, paths, files

Bash path extraction should be minimal or disabled in MVP.

## Build and Distribution Choice

The plugin should build TypeScript source into committed or packaged JavaScript files under `scripts/`.

Recommended build behavior:

```text
src/core/*.ts           -> scripts/core/*.js
src/hook_entry.ts -> scripts/hook_entry.js
```

The published plugin should not require Codex to run `tsx`, `ts-node`, or any TypeScript runtime loader.

## Failure Policy

The plugin should fail open.

Examples:

- Invalid guidance file: skip it, and report.
- Oversized guidance file: skip it, and report.
- State file problem: reset state if safe.
- Unknown tool input shape: do nothing.
- Ambiguous path extraction: do nothing.
- Lock acquisition timeout: do nothing.

The plugin should avoid blocking Codex unless it has successfully matched, injected, and recorded newly relevant guidance for an edit.

## Observability

Default messages should be minimal:

```text
claude:testing.md loaded
codex:backend/api.md loaded
```

Detailed diagnostics should go to optional debug logs, not into model context.

## Final Design Summary

The MVP is a small hooks-only Codex plugin.

```text
SessionStart:
  inject global guidance

PostToolUse:
  inject path guidance after matching reads

PreToolUse:
  inject path guidance before matching edits
  deny first edit if guidance was newly loaded

PostCompact:
  increment generation and reload lazily later

State:
  persisted in ${PLUGIN_DATA}/db/codex-guidance.sqlite
  protected by SQLite transactions and busy timeouts

Scripts:
  compiled TypeScript output lives in scripts/
  hooks.json references ${PLUGIN_ROOT}/scripts/...

MCP:
  omitted from MVP
```

This design keeps the project simple while preserving the essential behavior: Codex receives the right guidance at the point where it becomes relevant.
