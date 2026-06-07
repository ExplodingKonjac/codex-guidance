import { openGuidanceDatabase } from "./sqlite";
import type { GuidanceDocument } from "./types";

export interface SessionState {
  readonly generation: number;
  readonly loaded: Readonly<Record<string, readonly string[]>>;
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

const DEFAULT_BUSY_TIMEOUT_MS = 250;

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

export async function loadSessionState(
  options: StateOptions,
): Promise<SessionState> {
  return withDatabase(options, (database) =>
    readSessionState(database, sanitizeSessionId(options.sessionId)),
  );
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
  const guidanceIds = [...new Set(normalizeGuidanceIds(options.guidanceIds))];
  return withWriteDatabase(options, (database, sessionId) => {
    database.exec("BEGIN IMMEDIATE");
    try {
      const generation = ensureSession(database, sessionId);
      const insert = database.prepare(
        `
          INSERT OR IGNORE INTO session_loaded_guidance (
            session_id,
            generation,
            guidance_id
          )
          VALUES (?, ?, ?)
        `,
      );
      for (const guidanceId of guidanceIds) {
        insert.run(sessionId, generation, guidanceId);
      }
      database.exec("COMMIT");
      return {
        ok: true,
        state: readSessionState(database, sessionId),
      };
    } catch (error) {
      rollbackQuietly(database);
      return failureFromError(error);
    }
  });
}

export async function compactSessionState(
  options: StateUpdateOptions,
): Promise<StateUpdateResult> {
  return withWriteDatabase(options, (database, sessionId) => {
    database.exec("BEGIN IMMEDIATE");
    try {
      const generation = ensureSession(database, sessionId) + 1;
      database
        .prepare(
          `
            UPDATE session_state
            SET generation = ?
            WHERE session_id = ?
          `,
        )
        .run(generation, sessionId);
      database.exec("COMMIT");
      return {
        ok: true,
        state: readSessionState(database, sessionId),
      };
    } catch (error) {
      rollbackQuietly(database);
      return failureFromError(error);
    }
  });
}

function currentLoadedIds(state: SessionState): readonly string[] {
  return state.loaded[String(state.generation)] ?? [];
}

function normalizeGuidanceIds(guidanceIds: readonly string[]): readonly string[] {
  return guidanceIds
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}

function ensureSession(
  database: ReturnType<typeof openGuidanceDatabase>,
  sessionId: string,
): number {
  database
    .prepare(
      `
        INSERT INTO session_state (session_id, generation)
        VALUES (?, 0)
        ON CONFLICT(session_id) DO NOTHING
      `,
    )
    .run(sessionId);

  const row = database
    .prepare(
      `
        SELECT generation
        FROM session_state
        WHERE session_id = ?
      `,
    )
    .get(sessionId) as { generation?: unknown } | undefined;

  return typeof row?.generation === "number" ? row.generation : 0;
}

function readSessionState(
  database: ReturnType<typeof openGuidanceDatabase>,
  sessionId: string,
): SessionState {
  const row = database
    .prepare(
      `
        SELECT generation
        FROM session_state
        WHERE session_id = ?
      `,
    )
    .get(sessionId) as { generation?: unknown } | undefined;

  const generation = typeof row?.generation === "number" ? row.generation : 0;
  const loadedRows = database
    .prepare(
      `
        SELECT generation, guidance_id
        FROM session_loaded_guidance
        WHERE session_id = ?
        ORDER BY generation ASC, guidance_id ASC
      `,
    )
    .all(sessionId) as Array<{ generation?: unknown; guidance_id?: unknown }>;

  const loaded: Record<string, string[]> = {};
  for (const loadedRow of loadedRows) {
    if (
      typeof loadedRow.generation !== "number" ||
      typeof loadedRow.guidance_id !== "string"
    ) {
      continue;
    }

    const key = String(loadedRow.generation);
    const entries = loaded[key] ?? [];
    entries.push(loadedRow.guidance_id);
    loaded[key] = entries;
  }

  if (loaded[String(generation)] === undefined) {
    loaded[String(generation)] = [];
  }

  return { generation, loaded };
}

function rollbackQuietly(
  database: ReturnType<typeof openGuidanceDatabase>,
): void {
  try {
    database.exec("ROLLBACK");
  } catch {
    // Best effort cleanup after a failed write transaction.
  }
}

function failureFromError(error: unknown): StateUpdateResult {
  return isBusyError(error)
    ? { ok: false, reason: "lock-timeout" }
    : { ok: false, reason: "write-error" };
}

function isBusyError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return (
    error.message.includes("database is locked") ||
    error.message.includes("SQLITE_BUSY")
  );
}

function withDatabase<T>(
  options: StateOptions,
  callback: (database: ReturnType<typeof openGuidanceDatabase>) => T,
): T | SessionState {
  let database;
  try {
    database = openGuidanceDatabase({
      busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS,
      ...(options.pluginDataDir === undefined
        ? {}
        : { pluginDataDir: options.pluginDataDir }),
    });
  } catch {
    return defaultState();
  }

  try {
    return callback(database);
  } catch {
    return defaultState();
  } finally {
    database.close();
  }
}

function withWriteDatabase(
  options: StateUpdateOptions,
  callback: (
    database: ReturnType<typeof openGuidanceDatabase>,
    sessionId: string,
  ) => StateUpdateResult,
): StateUpdateResult {
  let database;
  try {
    database = openGuidanceDatabase({
      busyTimeoutMs: options.lockTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS,
      ...(options.pluginDataDir === undefined
        ? {}
        : { pluginDataDir: options.pluginDataDir }),
    });
  } catch (error) {
    return failureFromError(error);
  }

  try {
    return callback(database, sanitizeSessionId(options.sessionId));
  } catch (error) {
    return failureFromError(error);
  } finally {
    database.close();
  }
}
