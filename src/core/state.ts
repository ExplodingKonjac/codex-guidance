import { createHash } from "node:crypto";
import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";

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

export interface ReplaceLoadedGuidanceOptions extends StateUpdateOptions {
  readonly generation: number;
  readonly guidanceIds: readonly string[];
}

export interface TranscriptOptions extends StateUpdateOptions {
  readonly transcriptPath: string;
  readonly tailWindowBytes?: number;
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

export type TranscriptObservation = "normal" | "diverged" | "unavailable";

export interface ParsedGuidanceTag {
  readonly id: string;
  readonly generation: number;
}

const DEFAULT_BUSY_TIMEOUT_MS = 250;
const DEFAULT_TRANSCRIPT_TAIL_BYTES = 4096;

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

export async function loadCurrentSessionState(
  options: StateOptions,
): Promise<SessionState> {
  return loadSessionState(options);
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
  const guidanceIds = uniqueSortedGuidanceIds(options.guidanceIds);
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

export async function replaceLoadedGuidanceForGeneration(
  options: ReplaceLoadedGuidanceOptions,
): Promise<StateUpdateResult> {
  const guidanceIds = uniqueSortedGuidanceIds(options.guidanceIds);
  return withWriteDatabase(options, (database, sessionId) => {
    database.exec("BEGIN IMMEDIATE");
    try {
      ensureSession(database, sessionId);
      replaceLoadedGuidanceRows(
        database,
        sessionId,
        options.generation,
        guidanceIds,
      );
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

export async function observeTranscriptAppend(
  options: TranscriptOptions,
): Promise<TranscriptObservation> {
  let transcript;
  try {
    transcript = transcriptMetadata(options.transcriptPath, options);
  } catch {
    return "unavailable";
  }

  let database;
  try {
    database = openGuidanceDatabase({
      busyTimeoutMs: options.lockTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS,
      ...(options.pluginDataDir === undefined
        ? {}
        : { pluginDataDir: options.pluginDataDir }),
    });
  } catch {
    return "unavailable";
  }

  try {
    const sessionId = sanitizeSessionId(options.sessionId);
    database.exec("BEGIN IMMEDIATE");
    try {
      ensureSession(database, sessionId);
      const previous = database
        .prepare(
          `
            SELECT transcript_path, file_size, tail_start, tail_hash
            FROM session_transcript_state
            WHERE session_id = ?
          `,
        )
        .get(sessionId) as
        | {
            transcript_path?: unknown;
            file_size?: unknown;
            tail_start?: unknown;
            tail_hash?: unknown;
          }
        | undefined;

      const observation = transcriptDiverged(
        options.transcriptPath,
        transcript.fileSize,
        options.tailWindowBytes ?? DEFAULT_TRANSCRIPT_TAIL_BYTES,
        previous,
      )
        ? "diverged"
        : "normal";

      upsertTranscriptState(database, sessionId, transcript);
      database.exec("COMMIT");
      return observation;
    } catch {
      rollbackQuietly(database);
      return "unavailable";
    }
  } finally {
    database.close();
  }
}

export async function syncLoadedGuidanceFromTranscript(
  options: TranscriptOptions,
): Promise<StateUpdateResult> {
  let transcriptText: string;
  try {
    transcriptText = readFileSync(options.transcriptPath, "utf8");
  } catch {
    return { ok: false, reason: "write-error" };
  }

  const parsedTags = parseGuidanceTagsFromTranscript(transcriptText);
  return withWriteDatabase(options, (database, sessionId) => {
    database.exec("BEGIN IMMEDIATE");
    try {
      const existingGeneration = readPersistedGeneration(database, sessionId);
      const targetGeneration =
        existingGeneration ?? highestParsedGeneration(parsedTags);
      ensureSessionAtGeneration(database, sessionId, targetGeneration);
      replaceLoadedGuidanceRows(
        database,
        sessionId,
        targetGeneration,
        parsedTags
          .filter((tag) => tag.generation === targetGeneration)
          .map((tag) => tag.id),
      );
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

export function parseGuidanceTagsFromTranscript(
  transcriptText: string,
): readonly ParsedGuidanceTag[] {
  const tags: ParsedGuidanceTag[] = [];
  const tagPattern = /<guidance\b[^>]*>/g;
  let match: RegExpExecArray | null;
  while ((match = tagPattern.exec(transcriptText)) !== null) {
    const rawTag = match[0];
    const id = readAttribute(rawTag, "id");
    if (id === undefined) {
      continue;
    }
    const generationText = readAttribute(rawTag, "generation");
    const generation =
      generationText === undefined ? 0 : Number.parseInt(generationText, 10);
    tags.push({
      id,
      generation:
        Number.isInteger(generation) && generation >= 0 ? generation : 0,
    });
  }
  return tags;
}

function currentLoadedIds(state: SessionState): readonly string[] {
  return state.loaded[String(state.generation)] ?? [];
}

function normalizeGuidanceIds(
  guidanceIds: readonly string[],
): readonly string[] {
  return guidanceIds.map((id) => id.trim()).filter((id) => id.length > 0);
}

function uniqueSortedGuidanceIds(
  guidanceIds: readonly string[],
): readonly string[] {
  return [...new Set(normalizeGuidanceIds(guidanceIds))].sort((left, right) =>
    left.localeCompare(right),
  );
}

function replaceLoadedGuidanceRows(
  database: ReturnType<typeof openGuidanceDatabase>,
  sessionId: string,
  generation: number,
  guidanceIds: readonly string[],
): void {
  database
    .prepare(
      `
        DELETE FROM session_loaded_guidance
        WHERE session_id = ? AND generation = ?
      `,
    )
    .run(sessionId, generation);

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
  for (const guidanceId of uniqueSortedGuidanceIds(guidanceIds)) {
    insert.run(sessionId, generation, guidanceId);
  }
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

function ensureSessionAtGeneration(
  database: ReturnType<typeof openGuidanceDatabase>,
  sessionId: string,
  generation: number,
): void {
  database
    .prepare(
      `
        INSERT INTO session_state (session_id, generation)
        VALUES (?, ?)
        ON CONFLICT(session_id) DO NOTHING
      `,
    )
    .run(sessionId, generation);
}

function readPersistedGeneration(
  database: ReturnType<typeof openGuidanceDatabase>,
  sessionId: string,
): number | undefined {
  const row = database
    .prepare(
      `
        SELECT generation
        FROM session_state
        WHERE session_id = ?
      `,
    )
    .get(sessionId) as { generation?: unknown } | undefined;

  return typeof row?.generation === "number" ? row.generation : undefined;
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

interface TranscriptMetadata {
  readonly transcriptPath: string;
  readonly fileSize: number;
  readonly tailStart: number;
  readonly tailHash: string;
}

function transcriptMetadata(
  transcriptPath: string,
  options: TranscriptOptions,
): TranscriptMetadata {
  const fileSize = statSync(transcriptPath).size;
  const tailWindowBytes =
    options.tailWindowBytes ?? DEFAULT_TRANSCRIPT_TAIL_BYTES;
  const tailStart = Math.max(0, fileSize - tailWindowBytes);
  return {
    transcriptPath,
    fileSize,
    tailStart,
    tailHash: hashFileRange(transcriptPath, tailStart, fileSize - tailStart),
  };
}

function transcriptDiverged(
  transcriptPath: string,
  fileSize: number,
  tailWindowBytes: number,
  previous:
    | {
        transcript_path?: unknown;
        file_size?: unknown;
        tail_start?: unknown;
        tail_hash?: unknown;
      }
    | undefined,
): boolean {
  if (previous === undefined) {
    return false;
  }
  if (
    typeof previous.transcript_path !== "string" ||
    typeof previous.file_size !== "number" ||
    typeof previous.tail_start !== "number" ||
    typeof previous.tail_hash !== "string"
  ) {
    return true;
  }
  if (previous.transcript_path !== transcriptPath) {
    return true;
  }
  if (fileSize < previous.file_size) {
    return true;
  }

  const expectedLength = previous.file_size - previous.tail_start;
  if (expectedLength < 0 || expectedLength > tailWindowBytes) {
    return true;
  }

  try {
    return (
      hashFileRange(transcriptPath, previous.tail_start, expectedLength) !==
      previous.tail_hash
    );
  } catch {
    return true;
  }
}

function upsertTranscriptState(
  database: ReturnType<typeof openGuidanceDatabase>,
  sessionId: string,
  transcript: TranscriptMetadata,
): void {
  database
    .prepare(
      `
        INSERT INTO session_transcript_state (
          session_id,
          transcript_path,
          file_size,
          tail_start,
          tail_hash
        )
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          transcript_path = excluded.transcript_path,
          file_size = excluded.file_size,
          tail_start = excluded.tail_start,
          tail_hash = excluded.tail_hash
      `,
    )
    .run(
      sessionId,
      transcript.transcriptPath,
      transcript.fileSize,
      transcript.tailStart,
      transcript.tailHash,
    );
}

function hashFileRange(
  filePath: string,
  start: number,
  length: number,
): string {
  const buffer = Buffer.alloc(length);
  const fileDescriptor = openSync(filePath, "r");
  try {
    const bytesRead = readSync(fileDescriptor, buffer, 0, length, start);
    return createHash("sha256")
      .update(bytesRead === length ? buffer : buffer.subarray(0, bytesRead))
      .digest("hex");
  } finally {
    closeSync(fileDescriptor);
  }
}

function readAttribute(tag: string, attributeName: string): string | undefined {
  const attributePattern = new RegExp(
    `${attributeName}\\s*=\\s*(?:"([^"]*)"|\\\\\\"([^\\\\"]*)\\\\\\")`,
  );
  const match = attributePattern.exec(tag);
  const value = match?.[1] ?? match?.[2];
  return value === undefined || value.trim().length === 0 ? undefined : value;
}

function highestParsedGeneration(tags: readonly ParsedGuidanceTag[]): number {
  return tags.reduce((highest, tag) => Math.max(highest, tag.generation), 0);
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
