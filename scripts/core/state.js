"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ensureTurnNode = ensureTurnNode;
exports.ensureCompactTurnNode = ensureCompactTurnNode;
exports.markTurnCompleted = markTurnCompleted;
exports.markGuidanceLoadedOnTurn = markGuidanceLoadedOnTurn;
exports.resolveCurrentTurnId = resolveCurrentTurnId;
exports.selectLoadedGuidanceForTurn = selectLoadedGuidanceForTurn;
exports.selectUnloadedGuidanceForTurn = selectUnloadedGuidanceForTurn;
const sqlite_1 = require("./sqlite");
const DEFAULT_BUSY_TIMEOUT_MS = 250;
async function ensureTurnNode(options) {
    return withWriteDatabase(options, (database, sessionId) => {
        database.exec("BEGIN IMMEDIATE");
        try {
            const existing = readTurnNode(database, options.turnId);
            const turn = existing ??
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
        }
        catch (error) {
            rollbackQuietly(database);
            return failureFromError(error);
        }
    });
}
async function ensureCompactTurnNode(options) {
    return withWriteDatabase(options, (database, sessionId) => {
        database.exec("BEGIN IMMEDIATE");
        try {
            const existing = readTurnNode(database, options.turnId);
            const turn = existing ??
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
            const finalTurn = options.complete === true && turn.status !== "completed"
                ? updateTurnStatus(database, turn.turnId, "completed")
                : turn;
            if (options.advanceCursor !== false) {
                updateCursor(database, sessionId, finalTurn.turnId);
            }
            database.exec("COMMIT");
            return { ok: true, turn: finalTurn };
        }
        catch (error) {
            rollbackQuietly(database);
            return failureFromError(error);
        }
    });
}
async function markTurnCompleted(options) {
    return withWriteDatabase(options, (database) => {
        database.exec("BEGIN IMMEDIATE");
        try {
            const turn = requireTurnNode(database, options.turnId);
            const updated = turn.status === "completed"
                ? turn
                : updateTurnStatus(database, turn.turnId, "completed");
            database.exec("COMMIT");
            return { ok: true, turn: updated };
        }
        catch (error) {
            rollbackQuietly(database);
            return failureFromError(error);
        }
    });
}
async function markGuidanceLoadedOnTurn(options) {
    const guidanceIds = [...new Set(normalizeGuidanceIds(options.guidanceIds))];
    return withWriteDatabase(options, (database) => {
        database.exec("BEGIN IMMEDIATE");
        try {
            const turn = requireTurnNode(database, options.turnId);
            const insert = database.prepare(`
          INSERT OR IGNORE INTO turn_guidance (turn_id, guidance_id)
          VALUES (?, ?)
        `);
            for (const guidanceId of guidanceIds) {
                insert.run(turn.turnId, guidanceId);
            }
            database.exec("COMMIT");
            return { ok: true, turn };
        }
        catch (error) {
            rollbackQuietly(database);
            return failureFromError(error);
        }
    });
}
async function resolveCurrentTurnId(options) {
    return withDatabase(options, (database, sessionId) => {
        const row = database
            .prepare(`
          SELECT current_turn_id
          FROM session_cursor
          WHERE session_id = ?
        `)
            .get(sessionId);
        return typeof row?.current_turn_id === "string"
            ? row.current_turn_id
            : null;
    });
}
async function selectLoadedGuidanceForTurn(options) {
    return withDatabase(options, (database) => {
        const current = requireTurnNode(database, options.turnId);
        const loaded = new Set();
        let cursor = current;
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
async function selectUnloadedGuidanceForTurn(options) {
    const loaded = new Set(await selectLoadedGuidanceForTurn(options));
    return options.documents.filter((document) => !loaded.has(document.id));
}
function generationForUserTurn(database, parentTurnId) {
    if (parentTurnId === null) {
        return 0;
    }
    return requireTurnNode(database, parentTurnId).generation;
}
function generationForCompactTurn(database, parentTurnId) {
    if (parentTurnId === null) {
        return 1;
    }
    return requireTurnNode(database, parentTurnId).generation + 1;
}
function insertTurnNode(database, turn) {
    database
        .prepare(`
        INSERT INTO turn_node (
          turn_id,
          parent_turn_id,
          generation,
          kind,
          status
        )
        VALUES (?, ?, ?, ?, ?)
      `)
        .run(turn.turnId, turn.parentTurnId, turn.generation, turn.kind, turn.status);
    return turn;
}
function updateTurnStatus(database, turnId, status) {
    database
        .prepare(`
        UPDATE turn_node
        SET status = ?
        WHERE turn_id = ?
      `)
        .run(status, turnId);
    return requireTurnNode(database, turnId);
}
function updateCursor(database, sessionId, turnId) {
    database
        .prepare(`
        INSERT INTO session_cursor (session_id, current_turn_id)
        VALUES (?, ?)
        ON CONFLICT(session_id) DO UPDATE SET current_turn_id = excluded.current_turn_id
      `)
        .run(sessionId, turnId);
}
function verifyTurnShape(turn, expected) {
    if (turn.parentTurnId !== expected.parentTurnId || turn.kind !== expected.kind) {
        throw new Error(`Conflicting existing turn node: ${turn.turnId}`);
    }
}
function requireTurnNode(database, turnId) {
    const turn = readTurnNode(database, turnId);
    if (turn === null) {
        throw new Error(`Resolved parent or current turn is missing: ${turnId}`);
    }
    return turn;
}
function readTurnNode(database, turnId) {
    const row = database
        .prepare(`
        SELECT turn_id, parent_turn_id, generation, kind, status
        FROM turn_node
        WHERE turn_id = ?
      `)
        .get(turnId);
    if (typeof row?.turn_id !== "string" ||
        !(typeof row.parent_turn_id === "string" || row.parent_turn_id === null) ||
        typeof row.generation !== "number" ||
        !(row.kind === "user" || row.kind === "compact") ||
        !(row.status === "active" || row.status === "completed")) {
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
function readGuidanceIds(database, turnId) {
    const rows = database
        .prepare(`
        SELECT guidance_id
        FROM turn_guidance
        WHERE turn_id = ?
        ORDER BY guidance_id ASC
      `)
        .all(turnId);
    return rows
        .map((row) => row.guidance_id)
        .filter((guidanceId) => typeof guidanceId === "string");
}
function normalizeGuidanceIds(guidanceIds) {
    return guidanceIds
        .map((id) => id.trim())
        .filter((id) => id.length > 0);
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
    const database = (0, sqlite_1.openGuidanceDatabase)({
        busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS,
        ...(options.pluginDataDir === undefined
            ? {}
            : { pluginDataDir: options.pluginDataDir }),
    });
    try {
        return callback(database, sanitizeSessionId(options.sessionId));
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
