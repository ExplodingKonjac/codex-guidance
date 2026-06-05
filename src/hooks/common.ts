import { readFileSync } from "node:fs";

import { discoverGuidance } from "../core/discover";
import { findMatchingGuidance } from "../core/match";
import { extractToolPaths } from "../core/path_extract";
import { renderLoadedStatus } from "../core/render";
import {
  compactSessionState,
  loadSessionState,
  markGuidanceLoaded,
  selectUnloadedGuidance,
  type StateOptions,
  type StateUpdateOptions,
} from "../core/state";
import type { GuidanceDocument } from "../core/types";

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

  return {
    ...(cwd === undefined ? {} : { cwd }),
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(toolName === undefined ? {} : { toolName }),
    ...(toolInput === undefined ? {} : { toolInput }),
  };
}

export function isReadTool(toolName: string | undefined): boolean {
  if (toolName === undefined) {
    return false;
  }
  const normalized = toolName.toLowerCase();
  return normalized === "read" || normalized.includes("read_file");
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

  const stateLoadOptions = stateOptions(input, context);
  const stateMarkOptions = stateUpdateOptions(input, context);
  if (stateLoadOptions === null || stateMarkOptions === null) {
    return [];
  }

  const unloaded = selectUnloadedGuidance({
    state: await loadSessionState(stateLoadOptions),
    documents,
  });
  if (unloaded.length === 0) {
    return [];
  }

  const result = await markGuidanceLoaded({
    ...stateMarkOptions,
    guidanceIds: unloaded.map((document) => document.id),
  });

  return result.ok ? unloaded : [];
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
