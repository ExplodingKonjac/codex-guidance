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

Each Markdown file may contain YAML front matter with only one supported field:

```yaml
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
core/path-extract
```

## Project Structure

Compiled hook scripts should live in `scripts/`.

```text
codex-guidance/
├── .codex-plugin/
│   └── plugin.json
├── hooks/
│   └── hooks.json
├── scripts/
│   ├── session_start.js
│   ├── post_tool_use.js
│   ├── pre_tool_use.js
│   └── post_compact.js
├── src/
│   ├── core/
│   │   ├── discover.ts
│   │   ├── parse.ts
│   │   ├── match.ts
│   │   ├── render.ts
│   │   ├── state.ts
│   │   └── path-extract.ts
│   └── hooks/
│       ├── session_start.ts
│       ├── post_tool_use.ts
│       ├── pre_tool_use.ts
│       └── post_compact.ts
└── test/
```

`src/hooks/*` contains TypeScript source.

`scripts/*` contains compiled JavaScript entrypoints referenced by Codex.

## Hook Configuration

`hooks.json` should reference compiled files under `${PLUGIN_ROOT}/scripts/...`.

Conceptually:

```text
SessionStart:
  ${PLUGIN_ROOT}/scripts/session_start.js

PostToolUse:
  ${PLUGIN_ROOT}/scripts/post_tool_use.js

PreToolUse:
  ${PLUGIN_ROOT}/scripts/pre_tool_use.js

PostCompact:
  ${PLUGIN_ROOT}/scripts/post_compact.js
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

YAML front matter should not be included in the injected content.

The plugin should also surface a concise status message:

```text
codex:backend/api.md loaded
```

## Session State

Session state should be saved outside the repository. Location:

```text
${PLUGIN_DATA}/state/sessions/<session_id>.json
```

The plugin should not write session state into:

```text
<repo>/.codex/
<repo>/.agents/
<repo>/.claude/
```

Session state is runtime data, not project configuration.

Use a minimal JSON format:

```json
{
  "generation": 0,
  "loaded": {
    "0": ["user:preferences.md", "codex:backend/api.md"]
  }
}
```

The only required information is:

```text
generation:
  Current context generation.

loaded:
  Guidance IDs already injected in each generation.
```

A guidance file is considered already loaded only if its ID appears in `loaded[current generation]`.

## State Locking

Hooks may run close together, so state updates should use a per-session lock file.

Lock file location:

```text
${PLUGIN_DATA}/state/sessions/<session_id>.lock
```

Fallback lock files should live next to the fallback state file.

Recommended behavior:

1. Acquire the per-session lock.
2. Read the state file.
3. Apply the state update.
4. Write the new state to a temporary file.
5. Atomically rename the temporary file over the state file.
6. Release the lock.

If the lock cannot be acquired quickly, the plugin should fail open:

- Do not block Codex.
- Do not inject uncertain or duplicate guidance.
- Do not deny an edit unless newly matched guidance was successfully loaded and recorded.

State writes should be atomic. Partial state files should not be left behind after crashes.

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
src/hooks/session_start.ts   -> scripts/session_start.js
src/hooks/post_tool_use.ts   -> scripts/post_tool_use.js
src/hooks/pre_tool_use.ts    -> scripts/pre_tool_use.js
src/hooks/post_compact.ts    -> scripts/post_compact.js
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
  minimal per-session JSON under ${PLUGIN_DATA}/state/sessions
  protected by a per-session lock file

Scripts:
  compiled TypeScript output lives in scripts/
  hooks.json references ${PLUGIN_ROOT}/scripts/...

MCP:
  omitted from MVP
```

This design keeps the project simple while preserving the essential behavior: Codex receives the right guidance at the point where it becomes relevant.
