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
  ensureCompactTurnNode,
  ensureTurnNode,
  markGuidanceLoadedOnTurn,
  markTurnCompleted,
  resolveCurrentTurnId,
  selectUnloadedGuidanceForTurn,
  type StateOptions,
  type StateUpdateOptions,
} from "./core/state";
import { resolveTurnFromTranscript } from "./core/transcript";
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
  readonly turnId?: string;
  readonly transcriptPath?: string;
  readonly toolName?: string;
  readonly toolInput?: unknown;
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
  const turnId = readString(payload.turn_id) ?? readString(payload.turnId);
  const transcriptPath =
    readString(payload.transcript_path) ?? readString(payload.transcriptPath);
  const toolName =
    readString(payload.tool_name) ?? readString(payload.toolName);
  const toolInput = payload.tool_input ?? payload.toolInput;

  return {
    ...(cwd === undefined ? {} : { cwd }),
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(turnId === undefined ? {} : { turnId }),
    ...(transcriptPath === undefined ? {} : { transcriptPath }),
    ...(toolName === undefined ? {} : { toolName }),
    ...(toolInput === undefined ? {} : { toolInput }),
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
): Promise<readonly GuidanceDocument[]> {
  if (documents.length === 0) {
    return [];
  }

  const stateMarkOptions = stateUpdateOptions(input, context);
  if (stateMarkOptions === null) {
    return [];
  }

  let turnId: string | null;
  let unloaded: readonly GuidanceDocument[];
  try {
    turnId = await currentTurnId(input, context);
    if (turnId === null) {
      return [];
    }
    unloaded = await selectUnloadedGuidanceForTurn({
      ...stateMarkOptions,
      turnId,
      documents,
    });
  } catch {
    return [];
  }
  if (unloaded.length === 0) {
    return [];
  }

  const result = await markGuidanceLoadedOnTurn({
    ...stateMarkOptions,
    turnId,
    guidanceIds: unloaded.map((document) => document.id),
  });

  return result.ok ? unloaded : [];
}

export async function ensureUserTurnForPrompt(
  input: HookInput,
  context: HookContext,
): Promise<StateUpdateOptions | null> {
  const options = stateUpdateOptions(input, context);
  if (options === null || input.turnId === undefined) {
    return null;
  }

  const resolved = resolveTurnFromTranscript({
    transcriptPath: transcriptPathForInput(input, context),
    turnId: input.turnId,
  });
  const result = await ensureTurnNode({
    ...options,
    turnId: resolved.turnId,
    parentTurnId: resolved.parentTurnId,
  });
  if (!result.ok) {
    throw new Error(`Failed to record user turn: ${result.reason}`);
  }
  return options;
}

export async function ensureCompactForHook(
  input: HookInput,
  context: HookContext,
  complete: boolean,
): Promise<void> {
  const options = stateUpdateOptions(input, context);
  if (options === null || input.turnId === undefined) {
    return;
  }

  const parentTurnId = await resolveCurrentTurnId(options);
  if (parentTurnId === null) {
    throw new Error("Cannot record compact turn without an active parent turn");
  }
  const result = await ensureCompactTurnNode({
    ...options,
    turnId: input.turnId,
    parentTurnId,
    complete,
    advanceCursor: complete,
  });
  if (!result.ok) {
    throw new Error(`Failed to record compact turn: ${result.reason}`);
  }
}

export async function markStopTurnIfPossible(
  input: HookInput,
  context: HookContext,
): Promise<void> {
  const options = stateUpdateOptions(input, context);
  if (options === null) {
    return;
  }
  const turnId = await currentTurnId(input, context);
  if (turnId === null) {
    return;
  }
  const result = await markTurnCompleted({
    ...options,
    turnId,
  });
  if (!result.ok) {
    throw new Error(`Failed to complete turn: ${result.reason}`);
  }
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
  return contextResult("SessionStart", renderGlobalGuidance(loaded), loaded);
}

export async function handleUserPromptSubmit(
  rawInput: string,
  context: HookContext = {},
): Promise<HookResult> {
  const input = parseHookInput(rawInput);
  if (input === null) {
    return NO_OUTPUT;
  }

  await ensureUserTurnForPrompt(input, context);
  return NO_OUTPUT;
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
  return contextResult("PostToolUse", renderPathGuidance(loaded), loaded);
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
    renderPathGuidance(loaded),
    loaded,
    loaded.length === 0
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

  await ensureCompactForHook(input, context, true);
  return NO_OUTPUT;
}

export async function handlePreCompact(
  rawInput: string,
  context: HookContext = {},
): Promise<HookResult> {
  const input = parseHookInput(rawInput);
  if (input === null) {
    return NO_OUTPUT;
  }

  await ensureCompactForHook(input, context, false);
  return NO_OUTPUT;
}

export async function handleStop(
  rawInput: string,
  context: HookContext = {},
): Promise<HookResult> {
  const input = parseHookInput(rawInput);
  if (input === null) {
    return NO_OUTPUT;
  }

  await markStopTurnIfPossible(input, context);
  return NO_OUTPUT;
}

const HOOK_HANDLERS: Readonly<Record<string, HookHandler>> = {
  session_start: handleSessionStart,
  user_prompt_submit: handleUserPromptSubmit,
  post_tool_use: handlePostToolUse,
  pre_tool_use: handlePreToolUse,
  pre_compact: handlePreCompact,
  post_compact: handlePostCompact,
  stop: handleStop,
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

async function currentTurnId(
  input: HookInput,
  context: HookContext,
): Promise<string | null> {
  if (input.turnId !== undefined) {
    return input.turnId;
  }
  const options = stateOptions(input, context);
  if (options === null) {
    return null;
  }
  return resolveCurrentTurnId(options);
}

function transcriptPathForInput(input: HookInput, context: HookContext): string {
  if (input.transcriptPath !== undefined) {
    return input.transcriptPath;
  }
  if (input.sessionId === undefined) {
    throw new Error("transcript_path is required when session_id is missing");
  }

  const homeDir = context.env?.HOME;
  if (homeDir === undefined || homeDir.trim().length === 0) {
    throw new Error("transcript_path is required when HOME is unavailable");
  }

  const sessionRoot = path.join(homeDir, ".codex", "sessions");
  const matches = findFilesContainingName(sessionRoot, input.sessionId);
  if (matches.length !== 1) {
    throw new Error(
      `Unable to resolve transcript_path for session ${input.sessionId}: found ${matches.length} matches`,
    );
  }
  return matches[0] as string;
}

function findFilesContainingName(root: string, needle: string): readonly string[] {
  const matches: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const entry = stack.pop();
    if (entry === undefined) {
      continue;
    }

    let stat;
    try {
      stat = statSync(entry);
    } catch {
      continue;
    }

    if (stat.isDirectory()) {
      for (const child of readdirSync(entry)) {
        stack.push(path.join(entry, child));
      }
      continue;
    }

    if (stat.isFile() && path.basename(entry).includes(needle)) {
      matches.push(entry);
    }
  }
  return matches;
}

function readPositiveInteger(value: unknown): number | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

if (require.main === module) {
  void runCli(selectedHookHandler(process.argv.slice(2)));
}
