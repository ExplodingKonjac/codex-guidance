"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_SQLITE_BUSY_TIMEOUT_MS = exports.GUIDANCE_DATABASE_SCHEMA_VERSION = void 0;
exports.getDatabasePath = getDatabasePath;
exports.openGuidanceDatabase = openGuidanceDatabase;
const node_fs_1 = require("node:fs");
const node_path_1 = __importDefault(require("node:path"));
const node_sqlite_1 = require("node:sqlite");
exports.GUIDANCE_DATABASE_SCHEMA_VERSION = 1;
exports.DEFAULT_SQLITE_BUSY_TIMEOUT_MS = 250;
function resolvePluginDataDir(options) {
    if (options.pluginDataDir !== undefined &&
        options.pluginDataDir.trim().length > 0) {
        return node_path_1.default.resolve(options.pluginDataDir);
    }
    const envPluginData = process.env.PLUGIN_DATA;
    if (envPluginData !== undefined && envPluginData.trim().length > 0) {
        return node_path_1.default.resolve(envPluginData);
    }
    throw new Error("PLUGIN_DATA is required for codex-guidance runtime storage.");
}
function getDatabasePath(options) {
    return node_path_1.default.join(resolvePluginDataDir(options), "db", "codex-guidance.sqlite");
}
function openGuidanceDatabase(options) {
    const databasePath = getDatabasePath(options);
    (0, node_fs_1.mkdirSync)(node_path_1.default.dirname(databasePath), { recursive: true });
    const database = new node_sqlite_1.DatabaseSync(databasePath, {
        timeout: options.busyTimeoutMs ?? exports.DEFAULT_SQLITE_BUSY_TIMEOUT_MS,
    });
    try {
        database.exec("PRAGMA foreign_keys = ON");
        database.exec("PRAGMA journal_mode = WAL");
        database.exec(`PRAGMA busy_timeout = ${options.busyTimeoutMs ?? exports.DEFAULT_SQLITE_BUSY_TIMEOUT_MS}`);
        const row = database
            .prepare("PRAGMA user_version")
            .get();
        const userVersion = typeof row?.user_version === "number" ? row.user_version : 0;
        if (userVersion === 0) {
            initializeSchema(database);
            database.exec(`PRAGMA user_version = ${exports.GUIDANCE_DATABASE_SCHEMA_VERSION}`);
            return database;
        }
        if (userVersion !== exports.GUIDANCE_DATABASE_SCHEMA_VERSION) {
            throw new Error(`Unsupported database schema version: ${String(userVersion)}`);
        }
        return database;
    }
    catch (error) {
        database.close();
        throw error;
    }
}
function initializeSchema(database) {
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
}
