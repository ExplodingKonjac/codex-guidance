"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadSessionState = loadSessionState;
exports.selectUnloadedGuidance = selectUnloadedGuidance;
exports.markGuidanceLoaded = markGuidanceLoaded;
exports.compactSessionState = compactSessionState;
const sqlite_1 = require("./sqlite");
const DEFAULT_BUSY_TIMEOUT_MS = 250;
function defaultState() {
    return {
        generation: 0,
        loaded: {
            "0": [],
        },
    };
}
function sanitizeSessionId(sessionId) {
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
async function loadSessionState(options) {
    return withDatabase(options, (database) => readSessionState(database, sanitizeSessionId(options.sessionId)));
}
function selectUnloadedGuidance(options) {
    const loaded = new Set(currentLoadedIds(options.state));
    return options.documents.filter((document) => !loaded.has(document.id));
}
async function markGuidanceLoaded(options) {
    const guidanceIds = [...new Set(normalizeGuidanceIds(options.guidanceIds))];
    return withWriteDatabase(options, (database, sessionId) => {
        database.exec("BEGIN IMMEDIATE");
        try {
            const generation = ensureSession(database, sessionId);
            const insert = database.prepare(`
          INSERT OR IGNORE INTO session_loaded_guidance (
            session_id,
            generation,
            guidance_id
          )
          VALUES (?, ?, ?)
        `);
            for (const guidanceId of guidanceIds) {
                insert.run(sessionId, generation, guidanceId);
            }
            database.exec("COMMIT");
            return {
                ok: true,
                state: readSessionState(database, sessionId),
            };
        }
        catch (error) {
            rollbackQuietly(database);
            return failureFromError(error);
        }
    });
}
async function compactSessionState(options) {
    return withWriteDatabase(options, (database, sessionId) => {
        database.exec("BEGIN IMMEDIATE");
        try {
            const generation = ensureSession(database, sessionId) + 1;
            database
                .prepare(`
            UPDATE session_state
            SET generation = ?
            WHERE session_id = ?
          `)
                .run(generation, sessionId);
            database.exec("COMMIT");
            return {
                ok: true,
                state: readSessionState(database, sessionId),
            };
        }
        catch (error) {
            rollbackQuietly(database);
            return failureFromError(error);
        }
    });
}
function currentLoadedIds(state) {
    return state.loaded[String(state.generation)] ?? [];
}
function normalizeGuidanceIds(guidanceIds) {
    return guidanceIds
        .map((id) => id.trim())
        .filter((id) => id.length > 0);
}
function ensureSession(database, sessionId) {
    database
        .prepare(`
        INSERT INTO session_state (session_id, generation)
        VALUES (?, 0)
        ON CONFLICT(session_id) DO NOTHING
      `)
        .run(sessionId);
    const row = database
        .prepare(`
        SELECT generation
        FROM session_state
        WHERE session_id = ?
      `)
        .get(sessionId);
    return typeof row?.generation === "number" ? row.generation : 0;
}
function readSessionState(database, sessionId) {
    const row = database
        .prepare(`
        SELECT generation
        FROM session_state
        WHERE session_id = ?
      `)
        .get(sessionId);
    const generation = typeof row?.generation === "number" ? row.generation : 0;
    const loadedRows = database
        .prepare(`
        SELECT generation, guidance_id
        FROM session_loaded_guidance
        WHERE session_id = ?
        ORDER BY generation ASC, guidance_id ASC
      `)
        .all(sessionId);
    const loaded = {};
    for (const loadedRow of loadedRows) {
        if (typeof loadedRow.generation !== "number" ||
            typeof loadedRow.guidance_id !== "string") {
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
function rollbackQuietly(database) {
    try {
        database.exec("ROLLBACK");
    }
    catch {
        // Best effort cleanup after a failed write transaction.
    }
}
function failureFromError(error) {
    return isBusyError(error)
        ? { ok: false, reason: "lock-timeout" }
        : { ok: false, reason: "write-error" };
}
function isBusyError(error) {
    if (!(error instanceof Error)) {
        return false;
    }
    return (error.message.includes("database is locked") ||
        error.message.includes("SQLITE_BUSY"));
}
function withDatabase(options, callback) {
    let database;
    try {
        database = (0, sqlite_1.openGuidanceDatabase)({
            busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS,
            ...(options.pluginDataDir === undefined
                ? {}
                : { pluginDataDir: options.pluginDataDir }),
        });
    }
    catch {
        return defaultState();
    }
    try {
        return callback(database);
    }
    catch {
        return defaultState();
    }
    finally {
        database.close();
    }
}
function withWriteDatabase(options, callback) {
    let database;
    try {
        database = (0, sqlite_1.openGuidanceDatabase)({
            busyTimeoutMs: options.lockTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS,
            ...(options.pluginDataDir === undefined
                ? {}
                : { pluginDataDir: options.pluginDataDir }),
        });
    }
    catch (error) {
        return failureFromError(error);
    }
    try {
        return callback(database, sanitizeSessionId(options.sessionId));
    }
    catch (error) {
        return failureFromError(error);
    }
    finally {
        database.close();
    }
}
