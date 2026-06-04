import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import type { GuidanceDocument } from "./types";

export interface SessionState {
  readonly generation: number;
  readonly loaded: Readonly<Record<string, readonly string[]>>;
}

export interface StatePaths {
  readonly sessionId: string;
  readonly stateDir: string;
  readonly stateFile: string;
  readonly lockFile: string;
}

export interface StateOptions {
  readonly sessionId: string;
  readonly pluginDataDir?: string;
}

export interface StateUpdateOptions extends StateOptions {
  readonly lockTimeoutMs?: number;
  readonly lockRetryMs?: number;
}

export interface MarkGuidanceLoadedOptions extends StateUpdateOptions {
  readonly guidanceIds: readonly string[];
}

export interface SelectUnloadedGuidanceOptions {
  readonly state: SessionState;
  readonly documents: readonly GuidanceDocument[];
}

export type StateUpdateResult =
  | {
      readonly ok: true;
      readonly state: SessionState;
    }
  | {
      readonly ok: false;
      readonly reason: "lock-timeout" | "write-error";
    };

const DEFAULT_LOCK_TIMEOUT_MS = 250;
const DEFAULT_LOCK_RETRY_MS = 10;

function defaultState(): SessionState {
  return {
    generation: 0,
    loaded: {
      "0": [],
    },
  };
}

function sanitizeSessionId(sessionId: string): string {
  const parts = sessionId
    .split(/[\\/]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && part !== "." && part !== "..");
  const normalized = parts
    .join("-")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "");
  return normalized.length > 0 ? normalized : "session";
}

function resolvePluginDataDir(options: StateOptions): string {
  if (
    options.pluginDataDir !== undefined &&
    options.pluginDataDir.trim().length > 0
  ) {
    return path.resolve(options.pluginDataDir);
  }

  const envPluginData = process.env.PLUGIN_DATA;
  if (envPluginData !== undefined && envPluginData.trim().length > 0) {
    return path.resolve(envPluginData);
  }

  throw new Error("PLUGIN_DATA is required for codex-guidance session state.");
}

export function getStatePaths(options: StateOptions): StatePaths {
  const sessionId = sanitizeSessionId(options.sessionId);
  const stateDir = path.join(
    resolvePluginDataDir(options),
    "state",
    "sessions",
  );
  return {
    sessionId,
    stateDir,
    stateFile: path.join(stateDir, `${sessionId}.json`),
    lockFile: path.join(stateDir, `${sessionId}.lock`),
  };
}

function normalizeState(value: unknown): SessionState | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  const payload = value as Record<string, unknown>;
  if (
    !Number.isInteger(payload.generation) ||
    (payload.generation as number) < 0
  ) {
    return null;
  }

  if (
    typeof payload.loaded !== "object" ||
    payload.loaded === null ||
    Array.isArray(payload.loaded)
  ) {
    return null;
  }

  const loaded: Record<string, readonly string[]> = {};
  for (const [generation, ids] of Object.entries(payload.loaded)) {
    if (!/^\d+$/.test(generation)) {
      return null;
    }
    if (
      !Array.isArray(ids) ||
      !ids.every((id) => typeof id === "string" && id.trim().length > 0)
    ) {
      return null;
    }
    loaded[generation] = [...new Set(ids.map((id) => id.trim()))];
  }

  const currentGeneration = String(payload.generation);
  if (loaded[currentGeneration] === undefined) {
    loaded[currentGeneration] = [];
  }

  return {
    generation: payload.generation as number,
    loaded,
  };
}

async function readExistingState(stateFile: string): Promise<SessionState> {
  let raw = "";
  try {
    raw = await readFile(stateFile, "utf8");
  } catch {
    return defaultState();
  }

  try {
    return normalizeState(JSON.parse(raw)) ?? defaultState();
  } catch {
    return defaultState();
  }
}

export async function loadSessionState(
  options: StateOptions,
): Promise<SessionState> {
  return readExistingState(getStatePaths(options).stateFile);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function acquireLock(
  lockFile: string,
  timeoutMs: number,
  retryMs: number,
): Promise<boolean> {
  const start = Date.now();
  while (true) {
    try {
      await writeFile(lockFile, `${process.pid}\n`, { flag: "wx" });
      return true;
    } catch {
      if (Date.now() - start >= timeoutMs) {
        return false;
      }
      await sleep(retryMs);
    }
  }
}

async function releaseLock(lockFile: string): Promise<void> {
  try {
    await unlink(lockFile);
  } catch {
    // Fail open: a missing lock should not break the hook flow.
  }
}

async function writeStateAtomically(
  paths: StatePaths,
  state: SessionState,
): Promise<void> {
  await mkdir(paths.stateDir, { recursive: true });
  const tempFile = path.join(
    paths.stateDir,
    `${paths.sessionId}.${process.pid}.${Date.now()}.${Math.random()
      .toString(16)
      .slice(2)}.tmp`,
  );

  try {
    await writeFile(tempFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(tempFile, paths.stateFile);
  } catch (error) {
    try {
      await unlink(tempFile);
    } catch {
      // Best effort cleanup; preserve the original write error.
    }
    throw error;
  }
}

async function updateSessionState(
  options: StateUpdateOptions,
  update: (state: SessionState) => SessionState,
): Promise<StateUpdateResult> {
  const paths = getStatePaths(options);
  await mkdir(paths.stateDir, { recursive: true });

  const acquired = await acquireLock(
    paths.lockFile,
    options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
    options.lockRetryMs ?? DEFAULT_LOCK_RETRY_MS,
  );
  if (!acquired) {
    return { ok: false, reason: "lock-timeout" };
  }

  try {
    const nextState = update(await readExistingState(paths.stateFile));
    await writeStateAtomically(paths, nextState);
    return { ok: true, state: nextState };
  } catch {
    return { ok: false, reason: "write-error" };
  } finally {
    await releaseLock(paths.lockFile);
  }
}

function currentLoadedIds(state: SessionState): readonly string[] {
  return state.loaded[String(state.generation)] ?? [];
}

export function selectUnloadedGuidance(
  options: SelectUnloadedGuidanceOptions,
): readonly GuidanceDocument[] {
  const loaded = new Set(currentLoadedIds(options.state));
  return options.documents.filter((document) => !loaded.has(document.id));
}

export async function markGuidanceLoaded(
  options: MarkGuidanceLoadedOptions,
): Promise<StateUpdateResult> {
  return updateSessionState(options, (state) => {
    const generation = String(state.generation);
    const loaded = state.loaded[generation] ?? [];
    return {
      generation: state.generation,
      loaded: {
        ...state.loaded,
        [generation]: [
          ...new Set([
            ...loaded,
            ...options.guidanceIds
              .map((id) => id.trim())
              .filter((id) => id.length > 0),
          ]),
        ],
      },
    };
  });
}

export async function compactSessionState(
  options: StateUpdateOptions,
): Promise<StateUpdateResult> {
  return updateSessionState(options, (state) => {
    const generation = state.generation + 1;
    return {
      generation,
      loaded: {
        ...state.loaded,
        [String(generation)]: [],
      },
    };
  });
}
