import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const GUIDANCE_DATABASE_SCHEMA_VERSION = 2;
export const DEFAULT_SQLITE_BUSY_TIMEOUT_MS = 250;

export interface GuidanceDatabaseOptions {
  readonly pluginDataDir?: string;
  readonly busyTimeoutMs?: number;
}

function resolvePluginDataDir(options: GuidanceDatabaseOptions): string {
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

  throw new Error(
    "PLUGIN_DATA is required for codex-guidance runtime storage.",
  );
}

export function getDatabasePath(options: GuidanceDatabaseOptions): string {
  return path.join(
    resolvePluginDataDir(options),
    "db",
    "codex-guidance.sqlite",
  );
}

export function openGuidanceDatabase(
  options: GuidanceDatabaseOptions,
): DatabaseSync {
  const databasePath = getDatabasePath(options);
  mkdirSync(path.dirname(databasePath), { recursive: true });

  const database = new DatabaseSync(databasePath, {
    timeout: options.busyTimeoutMs ?? DEFAULT_SQLITE_BUSY_TIMEOUT_MS,
  });

  try {
    database.exec("PRAGMA foreign_keys = ON");
    database.exec("PRAGMA journal_mode = WAL");
    database.exec(
      `PRAGMA busy_timeout = ${options.busyTimeoutMs ?? DEFAULT_SQLITE_BUSY_TIMEOUT_MS}`,
    );

    const row = database.prepare("PRAGMA user_version").get() as
      | { user_version?: unknown }
      | undefined;
    const userVersion =
      typeof row?.user_version === "number" ? row.user_version : 0;

    if (userVersion === 0) {
      initializeSchema(database);
      database.exec(
        `PRAGMA user_version = ${GUIDANCE_DATABASE_SCHEMA_VERSION}`,
      );
      return database;
    }

    if (userVersion === 1) {
      migrateSchemaFromV1ToV2(database);
      database.exec(
        `PRAGMA user_version = ${GUIDANCE_DATABASE_SCHEMA_VERSION}`,
      );
      return database;
    }

    if (userVersion !== GUIDANCE_DATABASE_SCHEMA_VERSION) {
      throw new Error(
        `Unsupported database schema version: ${String(userVersion)}`,
      );
    }

    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

function initializeSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS session_state (
      session_id TEXT PRIMARY KEY,
      generation INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS session_loaded_guidance (
      session_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      guidance_id TEXT NOT NULL,
      PRIMARY KEY (session_id, generation, guidance_id),
      FOREIGN KEY (session_id) REFERENCES session_state(session_id) ON DELETE CASCADE
    ) STRICT;

    CREATE TABLE IF NOT EXISTS guidance_root_cache (
      source TEXT NOT NULL,
      root TEXT NOT NULL,
      root_timestamp TEXT NOT NULL,
      max_bytes INTEGER NOT NULL,
      documents_json TEXT NOT NULL,
      issues_json TEXT NOT NULL,
      PRIMARY KEY (source, root)
    ) STRICT;
  `);

  createTranscriptStateTable(database);
}

function migrateSchemaFromV1ToV2(database: DatabaseSync): void {
  createTranscriptStateTable(database);
}

function createTranscriptStateTable(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS session_transcript_state (
      session_id TEXT PRIMARY KEY,
      transcript_path TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      tail_start INTEGER NOT NULL,
      tail_hash TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES session_state(session_id) ON DELETE CASCADE
    ) STRICT;
  `);
}
