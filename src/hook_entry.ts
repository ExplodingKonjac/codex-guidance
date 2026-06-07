import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { discoverGuidance } from "./core/discover";
import { findMatchingGuidance } from "./core/match";
import { extractToolPaths } from "./core/path_extract";
import {
  renderGlobalGuidance,
  renderLoadedStatus,
  renderPathGuidance,
} from "./core/render";
import {
  compactSessionState,
  loadCurrentSessionState,
  markGuidanceLoaded,
  observeTranscriptAppend,
  selectUnloadedGuidance,
  syncLoadedGuidanceFromTranscript,
  type StateOptions,
  type StateUpdateOptions,
} from "./core/state";
import type { GuidanceDocument } from "./core/types";

export interface HookContext {
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
}

export interface HookResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface HookInput {
  readonly cwd?: string;
  readonly sessionId?: string;
  readonly toolName?: string;
  readonly toolInput?: unknown;
  readonly transcriptPath?: string;
}

interface LoadedGuidance {
  readonly documents: readonly GuidanceDocument[];
  readonly generation: number;
}

export type HookHandler = (
  rawInput: string,
  context?: HookContext,
) => Promise<HookResult>;

export const NO_OUTPUT: HookResult = {
  exitCode: 0,
  stdout: "",
  stderr: "",
};

const RETRY_REASON =
  "Codex Guidance loaded matching guidance. Retry the edit after applying the loaded guidance.";

export function parseHookInput(rawInput: string): HookInput | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawInput);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }

  const payload = parsed as Record<string, unknown>;
  const cwd = readString(payload.cwd);
  const sessionId =
    readString(payload.session_id) ?? readString(payload.sessionId);
  const toolName =
    readString(payload.tool_name) ?? readString(payload.toolName);
  const toolInput = payload.tool_input ?? payload.toolInput;
  const transcriptPath =
    readString(payload.transcript_path) ?? readString(payload.transcriptPath);

  return {
    ...(cwd === undefined ? {} : { cwd }),
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(toolName === undefined ? {} : { toolName }),
    ...(toolInput === undefined ? {} : { toolInput }),
    ...(transcriptPath === undefined ? {} : { transcriptPath }),
  };
}

export function isReadTool(toolName: string | undefined): boolean {
  if (toolName === undefined) {
    return false;
  }
  const normalized = toolName.toLowerCase();
  if (normalized === "bash" || normalized.includes("bash")) {
    return false;
  }
  return normalized === "read" || normalized.includes("read");
}

export function isEditTool(toolName: string | undefined): boolean {
  if (toolName === undefined) {
    return false;
  }
  const normalized = toolName.toLowerCase();
  return (
    normalized === "write" ||
    normalized === "edit" ||
    normalized === "multiedit" ||
    normalized === "apply_patch" ||
    normalized.includes("write") ||
    normalized.includes("edit")
  );
}

export function hookJson(
  hookEventName: string,
  payload: Record<string, unknown>,
): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName,
      ...payload,
    },
  });
}

export function contextResult(
  hookEventName: string,
  additionalContext: string,
  documents: readonly GuidanceDocument[],
  extra: Record<string, unknown> = {},
): HookResult {
  if (additionalContext.length === 0) {
    return NO_OUTPUT;
  }

  const status = renderLoadedStatus(documents);
  return {
    exitCode: 0,
    stdout: hookJson(hookEventName, {
      additionalContext,
      ...extra,
    }),
    stderr: status.length > 0 ? `${status}\n` : "",
  };
}

export async function runCli(handler: HookHandler): Promise<void> {
  try {
    const rawInput = readFileSync(0, "utf8");
    const result = await handler(rawInput, {
      env: process.env,
      cwd: process.cwd(),
    });
    if (result.stdout.length > 0) {
      process.stdout.write(result.stdout);
    }
    if (result.stderr.length > 0) {
      process.stderr.write(result.stderr);
    }
    process.exitCode = result.exitCode;
  } catch (error) {
    process.stderr.write(
      error instanceof Error ? `${error.message}\n` : `${String(error)}\n`,
    );
    process.exitCode = 1;
  }
}

export async function discoverForHook(
  input: HookInput,
  context: HookContext = {},
): Promise<readonly GuidanceDocument[]> {
  const homeDir = context.env?.HOME;
  const pluginDataDir = context.env?.PLUGIN_DATA;
  return (
    await discoverGuidance({
      repoRoot: repoRoot(input, context),
      ...(homeDir === undefined || homeDir.trim().length === 0
        ? {}
        : { homeDir }),
      ...(pluginDataDir === undefined || pluginDataDir.trim().length === 0
        ? {}
        : { pluginDataDir }),
    })
  ).documents;
}

export function repoRoot(input: HookInput, context: HookContext = {}): string {
  return input.cwd ?? context.cwd ?? process.cwd();
}

export function stateOptions(
  input: HookInput,
  context: HookContext = {},
): StateOptions | null {
  if (input.sessionId === undefined) {
    return null;
  }

  const pluginDataDir = context.env?.PLUGIN_DATA;
  return pluginDataDir === undefined || pluginDataDir.trim().length === 0
    ? { sessionId: input.sessionId }
    : { sessionId: input.sessionId, pluginDataDir };
}

export function stateUpdateOptions(
  input: HookInput,
  context: HookContext = {},
): StateUpdateOptions | null {
  const baseOptions = stateOptions(input, context);
  if (baseOptions === null) {
    return null;
  }

  const lockTimeoutMs = readPositiveInteger(
    context.env?.CODEX_GUIDANCE_LOCK_TIMEOUT_MS,
  );
  const lockRetryMs = readPositiveInteger(
    context.env?.CODEX_GUIDANCE_LOCK_RETRY_MS,
  );

  return {
    ...baseOptions,
    ...(lockTimeoutMs === undefined ? {} : { lockTimeoutMs }),
    ...(lockRetryMs === undefined ? {} : { lockRetryMs }),
  };
}

export async function markLoadedIfPossible(
  input: HookInput,
  context: HookContext,
  documents: readonly GuidanceDocument[],
): Promise<LoadedGuidance> {
  if (documents.length === 0) {
    return { documents: [], generation: 0 };
  }

  const stateLoadOptions = stateOptions(input, context);
  const stateMarkOptions = stateUpdateOptions(input, context);
  if (stateLoadOptions === null || stateMarkOptions === null) {
    return { documents: [], generation: 0 };
  }

  const state = await loadCurrentSessionState(stateLoadOptions);
  const unloaded = selectUnloadedGuidance({
    state,
    documents,
  });
  if (unloaded.length === 0) {
    return { documents: [], generation: state.generation };
  }

  const result = await markGuidanceLoaded({
    ...stateMarkOptions,
    guidanceIds: unloaded.map((document) => document.id),
  });

  return result.ok
    ? { documents: unloaded, generation: result.state.generation }
    : { documents: [], generation: state.generation };
}

export async function compactIfPossible(
  input: HookInput,
  context: HookContext,
): Promise<void> {
  const options = stateUpdateOptions(input, context);
  if (options === null) {
    return;
  }
  await compactSessionState(options);
}

export function matchingGuidanceForPaths(
  documents: readonly GuidanceDocument[],
  paths: readonly string[],
  input: HookInput,
  context: HookContext,
): readonly GuidanceDocument[] {
  const byId = new Map<string, GuidanceDocument>();
  for (const targetPath of paths) {
    for (const document of findMatchingGuidance({
      documents,
      repoRoot: repoRoot(input, context),
      targetPath,
    })) {
      byId.set(document.id, document);
    }
  }
  return [...byId.values()];
}

export function extractPathsForHook(input: HookInput): readonly string[] {
  if (input.toolName === undefined) {
    return [];
  }
  return extractToolPaths({
    toolName: input.toolName,
    toolInput: input.toolInput,
  });
}

export async function handleSessionStart(
  rawInput: string,
  context: HookContext = {},
): Promise<HookResult> {
  const input = parseHookInput(rawInput);
  if (input === null) {
    return NO_OUTPUT;
  }

  const globalGuidance = (await discoverForHook(input, context)).filter(
    (document) => document.paths === null,
  );
  const loaded = await markLoadedIfPossible(input, context, globalGuidance);
  return contextResult(
    "SessionStart",
    renderGlobalGuidance(loaded.documents, loaded.generation),
    loaded.documents,
  );
}

export async function handlePostToolUse(
  rawInput: string,
  context: HookContext = {},
): Promise<HookResult> {
  const input = parseHookInput(rawInput);
  if (input === null || !isReadTool(input.toolName)) {
    return NO_OUTPUT;
  }

  const paths = extractPathsForHook(input);
  if (paths.length === 0) {
    return NO_OUTPUT;
  }

  const matchingGuidance = matchingGuidanceForPaths(
    await discoverForHook(input, context),
    paths,
    input,
    context,
  );
  const loaded = await markLoadedIfPossible(input, context, matchingGuidance);
  return contextResult(
    "PostToolUse",
    renderPathGuidance(loaded.documents, loaded.generation),
    loaded.documents,
  );
}

export async function handlePreToolUse(
  rawInput: string,
  context: HookContext = {},
): Promise<HookResult> {
  const input = parseHookInput(rawInput);
  if (input === null || !isEditTool(input.toolName)) {
    return NO_OUTPUT;
  }

  const paths = extractPathsForHook(input);
  if (paths.length === 0) {
    return NO_OUTPUT;
  }

  const matchingGuidance = matchingGuidanceForPaths(
    await discoverForHook(input, context),
    paths,
    input,
    context,
  );
  const loaded = await markLoadedIfPossible(input, context, matchingGuidance);
  return contextResult(
    "PreToolUse",
    renderPathGuidance(loaded.documents, loaded.generation),
    loaded.documents,
    loaded.documents.length === 0
      ? {}
      : {
          permissionDecision: "deny",
          permissionDecisionReason: RETRY_REASON,
        },
  );
}

export async function handlePostCompact(
  rawInput: string,
  context: HookContext = {},
): Promise<HookResult> {
  const input = parseHookInput(rawInput);
  if (input === null) {
    return NO_OUTPUT;
  }

  await compactIfPossible(input, context);
  return NO_OUTPUT;
}

export async function handleUserPromptSubmit(
  rawInput: string,
  context: HookContext = {},
): Promise<HookResult> {
  const input = parseHookInput(rawInput);
  const options = input === null ? null : stateUpdateOptions(input, context);
  const transcriptPath =
    input === null ? undefined : resolveTranscriptPath(input, context);
  if (input === null || options === null || transcriptPath === undefined) {
    return NO_OUTPUT;
  }

  const observation = await observeTranscriptAppend({
    ...options,
    transcriptPath,
  });
  if (observation === "diverged") {
    await syncLoadedGuidanceFromTranscript({
      ...options,
      transcriptPath,
    });
  }
  return NO_OUTPUT;
}

const HOOK_HANDLERS: Readonly<Record<string, HookHandler>> = {
  session_start: handleSessionStart,
  post_tool_use: handlePostToolUse,
  pre_tool_use: handlePreToolUse,
  post_compact: handlePostCompact,
  user_prompt_submit: handleUserPromptSubmit,
};

function selectedHookHandler(argv: readonly string[]): HookHandler {
  const hookName = readHookName(argv);
  const handler = HOOK_HANDLERS[hookName];
  if (handler !== undefined) {
    return handler;
  }

  throw new Error(
    `Unknown or missing --hook value. Expected one of: ${Object.keys(HOOK_HANDLERS).join(", ")}`,
  );
}

function readHookName(argv: readonly string[]): string {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) {
      continue;
    }
    if (arg === "--hook") {
      return argv[index + 1] ?? "";
    }
    if (arg.startsWith("--hook=")) {
      return arg.slice("--hook=".length);
    }
  }
  return "";
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

function readPositiveInteger(value: unknown): number | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function resolveTranscriptPath(
  input: HookInput,
  context: HookContext,
): string | undefined {
  if (input.transcriptPath !== undefined) {
    return input.transcriptPath;
  }
  if (input.sessionId === undefined) {
    return undefined;
  }

  const candidates = transcriptSearchRoots(context);
  for (const root of candidates) {
    const found = findTranscriptInRoot(root, input.sessionId);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

function transcriptSearchRoots(context: HookContext): readonly string[] {
  const roots: string[] = [];
  const codexHome = context.env?.CODEX_HOME;
  if (codexHome !== undefined && codexHome.trim().length > 0) {
    roots.push(path.join(codexHome, "sessions"));
  }

  const home = context.env?.HOME;
  if (home !== undefined && home.trim().length > 0) {
    roots.push(path.join(home, ".codex", "sessions"));
  }
  return roots;
}

function findTranscriptInRoot(
  root: string,
  sessionId: string,
): string | undefined {
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) {
      continue;
    }

    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
        continue;
      }
      if (!entry.name.includes(sessionId)) {
        continue;
      }
      try {
        if (statSync(entryPath).isFile()) {
          return entryPath;
        }
      } catch {
        // Ignore files that disappear while scanning.
      }
    }
  }
  return undefined;
}

if (require.main === module) {
  void runCli(selectedHookHandler(process.argv.slice(2)));
}
