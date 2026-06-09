import { openGuidanceDatabase } from "./sqlite";
import type { GuidanceDocument } from "./types";

export interface StateOptions {
  readonly sessionId: string;
  readonly pluginDataDir?: string;
}

export interface TurnStateOptions extends StateOptions {
  readonly turnId: string;
}

export interface StateUpdateOptions extends StateOptions {
  readonly lockTimeoutMs?: number;
  readonly lockRetryMs?: number;
}

export interface EnsureTurnNodeOptions extends StateUpdateOptions {
  readonly turnId: string;
  readonly parentTurnId: string | null;
}

export interface EnsureCompactTurnNodeOptions extends EnsureTurnNodeOptions {
  readonly complete?: boolean;
  readonly advanceCursor?: boolean;
}

export interface MarkTurnCompletedOptions extends StateUpdateOptions {
  readonly turnId: string;
}

export interface MarkGuidanceLoadedOnTurnOptions
  extends MarkTurnCompletedOptions {
  readonly guidanceIds: readonly string[];
}

export interface SelectGuidanceForTurnOptions extends TurnStateOptions {
  readonly documents: readonly GuidanceDocument[];
}

export interface TurnNode {
  readonly turnId: string;
  readonly parentTurnId: string | null;
  readonly generation: number;
  readonly kind: "user" | "compact";
  readonly status: "active" | "completed";
}

export type StateUpdateResult =
  | {
      readonly ok: true;
      readonly turn: TurnNode;
    }
  | {
      readonly ok: false;
      readonly reason: "lock-timeout" | "write-error";
    };

const DEFAULT_BUSY_TIMEOUT_MS = 250;

export async function ensureTurnNode(
  options: EnsureTurnNodeOptions,
): Promise<StateUpdateResult> {
  return withWriteDatabase(options, (database, sessionId) => {
    database.exec("BEGIN IMMEDIATE");
    try {
      const existing = readTurnNode(database, options.turnId);
      const turn =
        existing ??
        insertTurnNode(database, {
          turnId: options.turnId,
          parentTurnId: options.parentTurnId,
          kind: "user",
          status: "active",
          generation: generationForUserTurn(database, options.parentTurnId),
        });

      verifyTurnShape(turn, {
        parentTurnId: options.parentTurnId,
        kind: "user",
      });
      updateCursor(database, sessionId, turn.turnId);
      database.exec("COMMIT");
      return { ok: true, turn };
    } catch (error) {
      rollbackQuietly(database);
      return failureFromError(error);
    }
  });
}

export async function ensureCompactTurnNode(
  options: EnsureCompactTurnNodeOptions,
): Promise<StateUpdateResult> {
  return withWriteDatabase(options, (database, sessionId) => {
    database.exec("BEGIN IMMEDIATE");
    try {
      const existing = readTurnNode(database, options.turnId);
      const turn =
        existing ??
        insertTurnNode(database, {
          turnId: options.turnId,
          parentTurnId: options.parentTurnId,
          kind: "compact",
          status: options.complete === true ? "completed" : "active",
          generation: generationForCompactTurn(database, options.parentTurnId),
        });

      verifyTurnShape(turn, {
        parentTurnId: options.parentTurnId,
        kind: "compact",
      });

      const finalTurn =
        options.complete === true && turn.status !== "completed"
          ? updateTurnStatus(database, turn.turnId, "completed")
          : turn;
      if (options.advanceCursor !== false) {
        updateCursor(database, sessionId, finalTurn.turnId);
      }
      database.exec("COMMIT");
      return { ok: true, turn: finalTurn };
    } catch (error) {
      rollbackQuietly(database);
      return failureFromError(error);
    }
  });
}

export async function markTurnCompleted(
  options: MarkTurnCompletedOptions,
): Promise<StateUpdateResult> {
  return withWriteDatabase(options, (database) => {
    database.exec("BEGIN IMMEDIATE");
    try {
      const turn = requireTurnNode(database, options.turnId);
      const updated =
        turn.status === "completed"
          ? turn
          : updateTurnStatus(database, turn.turnId, "completed");
      database.exec("COMMIT");
      return { ok: true, turn: updated };
    } catch (error) {
      rollbackQuietly(database);
      return failureFromError(error);
    }
  });
}

export async function markGuidanceLoadedOnTurn(
  options: MarkGuidanceLoadedOnTurnOptions,
): Promise<StateUpdateResult> {
  const guidanceIds = [...new Set(normalizeGuidanceIds(options.guidanceIds))];
  return withWriteDatabase(options, (database) => {
    database.exec("BEGIN IMMEDIATE");
    try {
      const turn = requireTurnNode(database, options.turnId);
      const insert = database.prepare(
        `
          INSERT OR IGNORE INTO turn_guidance (turn_id, guidance_id)
          VALUES (?, ?)
        `,
      );
      for (const guidanceId of guidanceIds) {
        insert.run(turn.turnId, guidanceId);
      }
      database.exec("COMMIT");
      return { ok: true, turn };
    } catch (error) {
      rollbackQuietly(database);
      return failureFromError(error);
    }
  });
}

export async function resolveCurrentTurnId(
  options: StateOptions,
): Promise<string | null> {
  return withDatabase(options, (database, sessionId) => {
    const row = database
      .prepare(
        `
          SELECT current_turn_id
          FROM session_cursor
          WHERE session_id = ?
        `,
      )
      .get(sessionId) as { current_turn_id?: unknown } | undefined;
    return typeof row?.current_turn_id === "string"
      ? row.current_turn_id
      : null;
  });
}

export async function selectLoadedGuidanceForTurn(
  options: TurnStateOptions,
): Promise<readonly string[]> {
  return withDatabase(options, (database) => {
    const current = requireTurnNode(database, options.turnId);
    const loaded = new Set<string>();
    let cursor: TurnNode | null = current;

    while (cursor !== null && cursor.generation === current.generation) {
      for (const guidanceId of readGuidanceIds(database, cursor.turnId)) {
        loaded.add(guidanceId);
      }
      cursor =
        cursor.parentTurnId === null
          ? null
          : readTurnNode(database, cursor.parentTurnId);
    }

    return [...loaded].sort();
  });
}

export async function selectUnloadedGuidanceForTurn(
  options: SelectGuidanceForTurnOptions,
): Promise<readonly GuidanceDocument[]> {
  const loaded = new Set(await selectLoadedGuidanceForTurn(options));
  return options.documents.filter((document) => !loaded.has(document.id));
}

function generationForUserTurn(
  database: ReturnType<typeof openGuidanceDatabase>,
  parentTurnId: string | null,
): number {
  if (parentTurnId === null) {
    return 0;
  }
  return requireTurnNode(database, parentTurnId).generation;
}

function generationForCompactTurn(
  database: ReturnType<typeof openGuidanceDatabase>,
  parentTurnId: string | null,
): number {
  if (parentTurnId === null) {
    return 1;
  }
  return requireTurnNode(database, parentTurnId).generation + 1;
}

function insertTurnNode(
  database: ReturnType<typeof openGuidanceDatabase>,
  turn: TurnNode,
): TurnNode {
  database
    .prepare(
      `
        INSERT INTO turn_node (
          turn_id,
          parent_turn_id,
          generation,
          kind,
          status
        )
        VALUES (?, ?, ?, ?, ?)
      `,
    )
    .run(
      turn.turnId,
      turn.parentTurnId,
      turn.generation,
      turn.kind,
      turn.status,
    );
  return turn;
}

function updateTurnStatus(
  database: ReturnType<typeof openGuidanceDatabase>,
  turnId: string,
  status: TurnNode["status"],
): TurnNode {
  database
    .prepare(
      `
        UPDATE turn_node
        SET status = ?
        WHERE turn_id = ?
      `,
    )
    .run(status, turnId);
  return requireTurnNode(database, turnId);
}

function updateCursor(
  database: ReturnType<typeof openGuidanceDatabase>,
  sessionId: string,
  turnId: string,
): void {
  database
    .prepare(
      `
        INSERT INTO session_cursor (session_id, current_turn_id)
        VALUES (?, ?)
        ON CONFLICT(session_id) DO UPDATE SET current_turn_id = excluded.current_turn_id
      `,
    )
    .run(sessionId, turnId);
}

function verifyTurnShape(
  turn: TurnNode,
  expected: Pick<TurnNode, "parentTurnId" | "kind">,
): void {
  if (turn.parentTurnId !== expected.parentTurnId || turn.kind !== expected.kind) {
    throw new Error(`Conflicting existing turn node: ${turn.turnId}`);
  }
}

function requireTurnNode(
  database: ReturnType<typeof openGuidanceDatabase>,
  turnId: string,
): TurnNode {
  const turn = readTurnNode(database, turnId);
  if (turn === null) {
    throw new Error(`Resolved parent or current turn is missing: ${turnId}`);
  }
  return turn;
}

function readTurnNode(
  database: ReturnType<typeof openGuidanceDatabase>,
  turnId: string,
): TurnNode | null {
  const row = database
    .prepare(
      `
        SELECT turn_id, parent_turn_id, generation, kind, status
        FROM turn_node
        WHERE turn_id = ?
      `,
    )
    .get(turnId) as
    | {
        turn_id?: unknown;
        parent_turn_id?: unknown;
        generation?: unknown;
        kind?: unknown;
        status?: unknown;
      }
    | undefined;

  if (
    typeof row?.turn_id !== "string" ||
    !(typeof row.parent_turn_id === "string" || row.parent_turn_id === null) ||
    typeof row.generation !== "number" ||
    !(row.kind === "user" || row.kind === "compact") ||
    !(row.status === "active" || row.status === "completed")
  ) {
    return null;
  }

  return {
    turnId: row.turn_id,
    parentTurnId: row.parent_turn_id,
    generation: row.generation,
    kind: row.kind,
    status: row.status,
  };
}

function readGuidanceIds(
  database: ReturnType<typeof openGuidanceDatabase>,
  turnId: string,
): readonly string[] {
  const rows = database
    .prepare(
      `
        SELECT guidance_id
        FROM turn_guidance
        WHERE turn_id = ?
        ORDER BY guidance_id ASC
      `,
    )
    .all(turnId) as Array<{ guidance_id?: unknown }>;
  return rows
    .map((row) => row.guidance_id)
    .filter((guidanceId): guidanceId is string => typeof guidanceId === "string");
}

function normalizeGuidanceIds(guidanceIds: readonly string[]): readonly string[] {
  return guidanceIds
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
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
  callback: (
    database: ReturnType<typeof openGuidanceDatabase>,
    sessionId: string,
  ) => T,
): T {
  const database = openGuidanceDatabase({
    busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS,
    ...(options.pluginDataDir === undefined
      ? {}
      : { pluginDataDir: options.pluginDataDir }),
  });

  try {
    return callback(database, sanitizeSessionId(options.sessionId));
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
