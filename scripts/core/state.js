"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadSessionState = loadSessionState;
exports.loadCurrentSessionState = loadCurrentSessionState;
exports.selectUnloadedGuidance = selectUnloadedGuidance;
exports.markGuidanceLoaded = markGuidanceLoaded;
exports.replaceLoadedGuidanceForGeneration = replaceLoadedGuidanceForGeneration;
exports.compactSessionState = compactSessionState;
exports.observeTranscriptAppend = observeTranscriptAppend;
exports.syncLoadedGuidanceFromTranscript = syncLoadedGuidanceFromTranscript;
exports.parseGuidanceTagsFromTranscript = parseGuidanceTagsFromTranscript;
const node_crypto_1 = require("node:crypto");
const node_fs_1 = require("node:fs");
const sqlite_1 = require("./sqlite");
const DEFAULT_BUSY_TIMEOUT_MS = 250;
const DEFAULT_TRANSCRIPT_TAIL_BYTES = 4096;
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
async function loadCurrentSessionState(options) {
    return loadSessionState(options);
}
function selectUnloadedGuidance(options) {
    const loaded = new Set(currentLoadedIds(options.state));
    return options.documents.filter((document) => !loaded.has(document.id));
}
async function markGuidanceLoaded(options) {
    const guidanceIds = uniqueSortedGuidanceIds(options.guidanceIds);
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
async function replaceLoadedGuidanceForGeneration(options) {
    const guidanceIds = uniqueSortedGuidanceIds(options.guidanceIds);
    return withWriteDatabase(options, (database, sessionId) => {
        database.exec("BEGIN IMMEDIATE");
        try {
            ensureSession(database, sessionId);
            replaceLoadedGuidanceRows(database, sessionId, options.generation, guidanceIds);
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
async function observeTranscriptAppend(options) {
    let transcript;
    try {
        transcript = transcriptMetadata(options.transcriptPath, options);
    }
    catch {
        return "unavailable";
    }
    let database;
    try {
        database = (0, sqlite_1.openGuidanceDatabase)({
            busyTimeoutMs: options.lockTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS,
            ...(options.pluginDataDir === undefined
                ? {}
                : { pluginDataDir: options.pluginDataDir }),
        });
    }
    catch {
        return "unavailable";
    }
    try {
        const sessionId = sanitizeSessionId(options.sessionId);
        database.exec("BEGIN IMMEDIATE");
        try {
            ensureSession(database, sessionId);
            const previous = database
                .prepare(`
            SELECT transcript_path, file_size, tail_start, tail_hash
            FROM session_transcript_state
            WHERE session_id = ?
          `)
                .get(sessionId);
            const observation = transcriptDiverged(options.transcriptPath, transcript.fileSize, options.tailWindowBytes ?? DEFAULT_TRANSCRIPT_TAIL_BYTES, previous)
                ? "diverged"
                : "normal";
            upsertTranscriptState(database, sessionId, transcript);
            database.exec("COMMIT");
            return observation;
        }
        catch {
            rollbackQuietly(database);
            return "unavailable";
        }
    }
    finally {
        database.close();
    }
}
async function syncLoadedGuidanceFromTranscript(options) {
    let transcriptText;
    try {
        transcriptText = (0, node_fs_1.readFileSync)(options.transcriptPath, "utf8");
    }
    catch {
        return { ok: false, reason: "write-error" };
    }
    const parsedTags = parseGuidanceTagsFromTranscript(transcriptText);
    return withWriteDatabase(options, (database, sessionId) => {
        database.exec("BEGIN IMMEDIATE");
        try {
            const existingGeneration = readPersistedGeneration(database, sessionId);
            const targetGeneration = existingGeneration ?? highestParsedGeneration(parsedTags);
            ensureSessionAtGeneration(database, sessionId, targetGeneration);
            replaceLoadedGuidanceRows(database, sessionId, targetGeneration, parsedTags
                .filter((tag) => tag.generation === targetGeneration)
                .map((tag) => tag.id));
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
function parseGuidanceTagsFromTranscript(transcriptText) {
    const tags = [];
    const tagPattern = /<guidance\b[^>]*>/g;
    let match;
    while ((match = tagPattern.exec(transcriptText)) !== null) {
        const rawTag = match[0];
        const id = readAttribute(rawTag, "id");
        if (id === undefined) {
            continue;
        }
        const generationText = readAttribute(rawTag, "generation");
        const generation = generationText === undefined ? 0 : Number.parseInt(generationText, 10);
        tags.push({
            id,
            generation: Number.isInteger(generation) && generation >= 0 ? generation : 0,
        });
    }
    return tags;
}
function currentLoadedIds(state) {
    return state.loaded[String(state.generation)] ?? [];
}
function normalizeGuidanceIds(guidanceIds) {
    return guidanceIds
        .map((id) => id.trim())
        .filter((id) => id.length > 0);
}
function uniqueSortedGuidanceIds(guidanceIds) {
    return [...new Set(normalizeGuidanceIds(guidanceIds))].sort((left, right) => left.localeCompare(right));
}
function replaceLoadedGuidanceRows(database, sessionId, generation, guidanceIds) {
    database
        .prepare(`
        DELETE FROM session_loaded_guidance
        WHERE session_id = ? AND generation = ?
      `)
        .run(sessionId, generation);
    const insert = database.prepare(`
      INSERT OR IGNORE INTO session_loaded_guidance (
        session_id,
        generation,
        guidance_id
      )
      VALUES (?, ?, ?)
    `);
    for (const guidanceId of uniqueSortedGuidanceIds(guidanceIds)) {
        insert.run(sessionId, generation, guidanceId);
    }
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
function ensureSessionAtGeneration(database, sessionId, generation) {
    database
        .prepare(`
        INSERT INTO session_state (session_id, generation)
        VALUES (?, ?)
        ON CONFLICT(session_id) DO NOTHING
      `)
        .run(sessionId, generation);
}
function readPersistedGeneration(database, sessionId) {
    const row = database
        .prepare(`
        SELECT generation
        FROM session_state
        WHERE session_id = ?
      `)
        .get(sessionId);
    return typeof row?.generation === "number" ? row.generation : undefined;
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
function transcriptMetadata(transcriptPath, options) {
    const fileSize = (0, node_fs_1.statSync)(transcriptPath).size;
    const tailWindowBytes = options.tailWindowBytes ?? DEFAULT_TRANSCRIPT_TAIL_BYTES;
    const tailStart = Math.max(0, fileSize - tailWindowBytes);
    return {
        transcriptPath,
        fileSize,
        tailStart,
        tailHash: hashFileRange(transcriptPath, tailStart, fileSize - tailStart),
    };
}
function transcriptDiverged(transcriptPath, fileSize, tailWindowBytes, previous) {
    if (previous === undefined) {
        return false;
    }
    if (typeof previous.transcript_path !== "string" ||
        typeof previous.file_size !== "number" ||
        typeof previous.tail_start !== "number" ||
        typeof previous.tail_hash !== "string") {
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
        return (hashFileRange(transcriptPath, previous.tail_start, expectedLength) !==
            previous.tail_hash);
    }
    catch {
        return true;
    }
}
function upsertTranscriptState(database, sessionId, transcript) {
    database
        .prepare(`
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
      `)
        .run(sessionId, transcript.transcriptPath, transcript.fileSize, transcript.tailStart, transcript.tailHash);
}
function hashFileRange(filePath, start, length) {
    const buffer = Buffer.alloc(length);
    const fileDescriptor = (0, node_fs_1.openSync)(filePath, "r");
    try {
        const bytesRead = (0, node_fs_1.readSync)(fileDescriptor, buffer, 0, length, start);
        return (0, node_crypto_1.createHash)("sha256")
            .update(bytesRead === length ? buffer : buffer.subarray(0, bytesRead))
            .digest("hex");
    }
    finally {
        (0, node_fs_1.closeSync)(fileDescriptor);
    }
}
function readAttribute(tag, attributeName) {
    const attributePattern = new RegExp(`${attributeName}\\s*=\\s*(?:"([^"]*)"|\\\\\\"([^\\\\"]*)\\\\\\")`);
    const match = attributePattern.exec(tag);
    const value = match?.[1] ?? match?.[2];
    return value === undefined || value.trim().length === 0 ? undefined : value;
}
function highestParsedGeneration(tags) {
    return tags.reduce((highest, tag) => Math.max(highest, tag.generation), 0);
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
