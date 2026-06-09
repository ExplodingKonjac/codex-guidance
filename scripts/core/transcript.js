"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveTurnFromTranscript = resolveTurnFromTranscript;
const node_fs_1 = require("node:fs");
const DEFAULT_CHUNK_BYTES = 64 * 1024;
const DEFAULT_MAX_SCAN_BYTES = 16 * 1024 * 1024;
function resolveTurnFromTranscript(options) {
    if (options.transcriptPath.trim().length === 0) {
        throw new Error("transcript_path is required to resolve turn parent");
    }
    if (options.turnId.trim().length === 0) {
        throw new Error("turn_id is required to resolve turn parent");
    }
    let pendingRollbackUserTurns = 0;
    let draft = emptyDraft();
    for (const line of readJsonlLinesReverse({
        filePath: options.transcriptPath,
        maxScanBytes: options.maxScanBytes ?? DEFAULT_MAX_SCAN_BYTES,
    })) {
        const record = parseTranscriptLine(line);
        if (isRollbackRecord(record)) {
            pendingRollbackUserTurns += readRollbackTurns(record);
            continue;
        }
        updateDraft(draft, record);
        if (!isTaskStartedRecord(record)) {
            continue;
        }
        const segment = finalizeSegment(draft, record);
        draft = emptyDraft();
        if (segment.turnId === options.turnId) {
            continue;
        }
        if (segment.containsCompacted) {
            return {
                turnId: options.turnId,
                parentTurnId: segment.turnId,
                kind: "user",
            };
        }
        if (segment.countsAsUserTurn) {
            if (pendingRollbackUserTurns > 0) {
                pendingRollbackUserTurns -= 1;
                continue;
            }
            return {
                turnId: options.turnId,
                parentTurnId: segment.turnId,
                kind: "user",
            };
        }
    }
    if (draft.countsAsUserTurn || draft.containsCompacted) {
        throw new Error("Malformed transcript: segment missing task_started turn_id");
    }
    return {
        turnId: options.turnId,
        parentTurnId: null,
        kind: "user",
    };
}
function emptyDraft() {
    return {
        countsAsUserTurn: false,
        containsCompacted: false,
    };
}
function updateDraft(draft, record) {
    if (isCompactedRecord(record)) {
        validateCompactedRecord(record);
        draft.containsCompacted = true;
        return;
    }
    if (isUserMessageRecord(record)) {
        draft.countsAsUserTurn = true;
    }
}
function finalizeSegment(draft, record) {
    const payload = readPayload(record);
    const turnId = readString(payload?.turn_id);
    if (turnId === undefined) {
        throw new Error("Malformed transcript: task_started missing turn_id");
    }
    return {
        turnId,
        countsAsUserTurn: draft.countsAsUserTurn,
        containsCompacted: draft.containsCompacted,
    };
}
function parseTranscriptLine(line) {
    try {
        return JSON.parse(line);
    }
    catch (error) {
        throw new Error(`Invalid JSONL transcript record: ${error instanceof Error ? error.message : String(error)}`);
    }
}
function isRollbackRecord(record) {
    const payload = readPayload(record);
    return payload?.type === "thread_rolled_back";
}
function readRollbackTurns(record) {
    const payload = readPayload(record);
    const numTurns = payload?.num_turns;
    if (!Number.isInteger(numTurns) || numTurns < 0) {
        throw new Error("Malformed transcript: thread_rolled_back missing num_turns");
    }
    return numTurns;
}
function isTaskStartedRecord(record) {
    const payload = readPayload(record);
    return payload?.type === "task_started";
}
function isUserMessageRecord(record) {
    const payload = readPayload(record);
    return payload?.type === "user_message";
}
function isCompactedRecord(record) {
    return isObject(record) && record.type === "compacted";
}
function validateCompactedRecord(record) {
    const payload = readPayload(record);
    if (payload === undefined ||
        typeof payload.message !== "string" ||
        !Array.isArray(payload.replacement_history)) {
        throw new Error("Malformed transcript: compacted record has invalid payload");
    }
}
function readPayload(record) {
    if (!isObject(record) || !isObject(record.payload)) {
        return undefined;
    }
    return record.payload;
}
function readString(value) {
    return typeof value === "string" && value.trim().length > 0
        ? value
        : undefined;
}
function isObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function* readJsonlLinesReverse(options) {
    const fd = (0, node_fs_1.openSync)(options.filePath, "r");
    try {
        const size = (0, node_fs_1.fstatSync)(fd).size;
        let position = size;
        let scanned = 0;
        let suffix = Buffer.alloc(0);
        while (position > 0) {
            const bytesToRead = Math.min(DEFAULT_CHUNK_BYTES, position);
            position -= bytesToRead;
            scanned += bytesToRead;
            if (scanned > options.maxScanBytes) {
                throw new Error("Transcript scan limit exhausted");
            }
            const buffer = Buffer.allocUnsafe(bytesToRead);
            const bytesRead = (0, node_fs_1.readSync)(fd, buffer, 0, bytesToRead, position);
            const combined = Buffer.concat([buffer.subarray(0, bytesRead), suffix]);
            const parts = splitBufferLines(combined);
            suffix = parts.first;
            for (let index = parts.complete.length - 1; index >= 0; index -= 1) {
                const line = parts.complete[index]?.toString("utf8");
                if (line !== undefined && line.trim().length > 0) {
                    yield line;
                }
            }
        }
        const firstLine = suffix.toString("utf8");
        if (firstLine.trim().length > 0) {
            yield firstLine;
        }
    }
    finally {
        (0, node_fs_1.closeSync)(fd);
    }
}
function splitBufferLines(buffer) {
    const lines = [];
    let end = buffer.length;
    for (let index = buffer.length - 1; index >= 0; index -= 1) {
        if (buffer[index] !== 0x0a) {
            continue;
        }
        lines.push(buffer.subarray(index + 1, end));
        end = index;
    }
    return {
        first: buffer.subarray(0, end),
        complete: lines.reverse(),
    };
}
