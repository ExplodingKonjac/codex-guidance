import { closeSync, fstatSync, openSync, readSync } from "node:fs";

export interface ResolveTurnFromTranscriptOptions {
  readonly transcriptPath: string;
  readonly turnId: string;
  readonly maxScanBytes?: number;
}

export interface ResolvedTranscriptTurn {
  readonly turnId: string;
  readonly parentTurnId: string | null;
  readonly kind: "user";
}

interface Segment {
  readonly turnId: string;
  readonly countsAsUserTurn: boolean;
  readonly containsCompacted: boolean;
}

interface SegmentDraft {
  countsAsUserTurn: boolean;
  containsCompacted: boolean;
}

const DEFAULT_CHUNK_BYTES = 64 * 1024;
const DEFAULT_MAX_SCAN_BYTES = 16 * 1024 * 1024;

export function resolveTurnFromTranscript(
  options: ResolveTurnFromTranscriptOptions,
): ResolvedTranscriptTurn {
  if (options.transcriptPath.trim().length === 0) {
    throw new Error("transcript_path is required to resolve turn parent");
  }
  if (options.turnId.trim().length === 0) {
    throw new Error("turn_id is required to resolve turn parent");
  }

  let pendingRollbackUserTurns = 0;
  let draft: SegmentDraft = emptyDraft();

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
    throw new Error(
      "Malformed transcript: segment missing task_started turn_id",
    );
  }

  return {
    turnId: options.turnId,
    parentTurnId: null,
    kind: "user",
  };
}

function emptyDraft(): SegmentDraft {
  return {
    countsAsUserTurn: false,
    containsCompacted: false,
  };
}

function updateDraft(draft: SegmentDraft, record: unknown): void {
  if (isCompactedRecord(record)) {
    validateCompactedRecord(record);
    draft.containsCompacted = true;
    return;
  }

  if (isUserMessageRecord(record)) {
    draft.countsAsUserTurn = true;
    return;
  }

  if (isUserResponseMessageRecord(record)) {
    draft.countsAsUserTurn = true;
  }
}

function finalizeSegment(draft: SegmentDraft, record: unknown): Segment {
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

function parseTranscriptLine(line: string): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch (error) {
    throw new Error(
      `Invalid JSONL transcript record: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function isRollbackRecord(record: unknown): boolean {
  const payload = readPayload(record);
  return payload?.type === "thread_rolled_back";
}

function readRollbackTurns(record: unknown): number {
  const payload = readPayload(record);
  const numTurns = payload?.num_turns;
  if (!Number.isInteger(numTurns) || (numTurns as number) < 0) {
    throw new Error(
      "Malformed transcript: thread_rolled_back missing num_turns",
    );
  }
  return numTurns as number;
}

function isTaskStartedRecord(record: unknown): boolean {
  const payload = readPayload(record);
  return payload?.type === "task_started";
}

function isUserMessageRecord(record: unknown): boolean {
  const payload = readPayload(record);
  return payload?.type === "user_message";
}

function isUserResponseMessageRecord(record: unknown): boolean {
  if (!isObject(record) || record.type !== "response_item") {
    return false;
  }
  const payload = readPayload(record);
  return payload?.type === "message" && payload.role === "user";
}

function isCompactedRecord(record: unknown): boolean {
  return isObject(record) && record.type === "compacted";
}

function validateCompactedRecord(record: unknown): void {
  const payload = readPayload(record);
  if (
    payload === undefined ||
    typeof payload.message !== "string" ||
    !Array.isArray(payload.replacement_history)
  ) {
    throw new Error(
      "Malformed transcript: compacted record has invalid payload",
    );
  }
}

function readPayload(record: unknown): Record<string, unknown> | undefined {
  if (!isObject(record) || !isObject(record.payload)) {
    return undefined;
  }
  return record.payload;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function* readJsonlLinesReverse(options: {
  readonly filePath: string;
  readonly maxScanBytes: number;
}): Generator<string> {
  const fd = openSync(options.filePath, "r");
  try {
    const size = fstatSync(fd).size;
    let position = size;
    let scanned = 0;
    let suffix: Buffer<ArrayBufferLike> = Buffer.alloc(0);

    while (position > 0) {
      const bytesToRead = Math.min(DEFAULT_CHUNK_BYTES, position);
      position -= bytesToRead;
      scanned += bytesToRead;
      if (scanned > options.maxScanBytes) {
        throw new Error("Transcript scan limit exhausted");
      }

      const buffer = Buffer.allocUnsafe(bytesToRead);
      const bytesRead = readSync(fd, buffer, 0, bytesToRead, position);
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
  } finally {
    closeSync(fd);
  }
}

function splitBufferLines(buffer: Buffer<ArrayBufferLike>): {
  readonly first: Buffer<ArrayBufferLike>;
  readonly complete: readonly Buffer<ArrayBufferLike>[];
} {
  const lines: Buffer<ArrayBufferLike>[] = [];
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
