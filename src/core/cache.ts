import { createHash } from "node:crypto";
import path from "node:path";

import {
  GUIDANCE_DATABASE_SCHEMA_VERSION,
  openGuidanceDatabase,
  type GuidanceDatabaseOptions,
} from "./sqlite";
import type {
  GuidanceDocument,
  GuidanceIssue,
  GuidanceIssueReason,
  GuidanceSource,
} from "./types";

export const GUIDANCE_CACHE_VERSION = GUIDANCE_DATABASE_SCHEMA_VERSION;

export interface GuidanceRootFileMetadata {
  readonly relativePath: string;
  readonly size: number;
  readonly mtimeMs: number;
}

export interface GuidanceRootCachePathOptions {
  readonly pluginDataDir: string;
  readonly source: GuidanceSource;
  readonly root: string;
}

export interface GuidanceRootCacheReadOptions
  extends GuidanceRootCachePathOptions {}

export interface GuidanceRootCacheWriteOptions
  extends GuidanceRootCacheReadOptions {
  readonly rootTimestamp: string;
  readonly maxBytes: number;
  readonly documents: readonly GuidanceDocument[];
  readonly issues: readonly GuidanceIssue[];
}

export interface GuidanceRootCacheResult {
  readonly documents: readonly GuidanceDocument[];
  readonly issues: readonly GuidanceIssue[];
}

interface GuidanceRootCacheRow extends GuidanceRootCacheResult {
  readonly source: GuidanceSource;
  readonly root: string;
  readonly rootTimestamp: string;
  readonly maxBytes: number;
}

const ISSUE_REASONS = new Set<GuidanceIssueReason>([
  "invalid-front-matter",
  "invalid-paths-field",
  "outside-root",
  "oversized",
  "read-error",
  "unsupported-front-matter-field",
]);

export function createGuidanceRootTimestamp(
  files: readonly GuidanceRootFileMetadata[],
): string {
  return stableHash(
    JSON.stringify(
      files.map((file) => ({
        relativePath: file.relativePath,
        size: file.size,
        mtimeMs: file.mtimeMs,
      })),
    ),
  );
}

export async function readGuidanceRootCache(
  options: GuidanceRootCacheReadOptions & {
    readonly rootTimestamp: string;
    readonly maxBytes: number;
  },
): Promise<GuidanceRootCacheResult | null> {
  return withDatabase(options, (database) => {
    const row = database
      .prepare(
        `
          SELECT source, root, root_timestamp, max_bytes, documents_json, issues_json
          FROM guidance_root_cache
          WHERE source = ? AND root = ?
        `,
      )
      .get(options.source, path.resolve(options.root)) as
      | {
          source?: unknown;
          root?: unknown;
          root_timestamp?: unknown;
          max_bytes?: unknown;
          documents_json?: unknown;
          issues_json?: unknown;
        }
      | undefined;

    if (row === undefined) {
      return null;
    }

    return normalizeCacheRow(
      {
        source: row.source,
        root: row.root,
        rootTimestamp: row.root_timestamp,
        maxBytes: row.max_bytes,
        documents: parseJsonArray(row.documents_json),
        issues: parseJsonArray(row.issues_json),
      },
      options,
    );
  });
}

export async function writeGuidanceRootCache(
  options: GuidanceRootCacheWriteOptions,
): Promise<void> {
  void withDatabase(options, (database) => {
    database
      .prepare(
        `
          INSERT INTO guidance_root_cache (
            source,
            root,
            root_timestamp,
            max_bytes,
            documents_json,
            issues_json
          )
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(source, root) DO UPDATE SET
            root_timestamp = excluded.root_timestamp,
            max_bytes = excluded.max_bytes,
            documents_json = excluded.documents_json,
            issues_json = excluded.issues_json
        `,
      )
      .run(
        options.source,
        path.resolve(options.root),
        options.rootTimestamp,
        options.maxBytes,
        JSON.stringify(options.documents),
        JSON.stringify(options.issues),
      );
    return null;
  });
}

function normalizeCacheRow(
  value: {
    readonly source: unknown;
    readonly root: unknown;
    readonly rootTimestamp: unknown;
    readonly maxBytes: unknown;
    readonly documents: unknown;
    readonly issues: unknown;
  },
  options: GuidanceRootCacheReadOptions & {
    readonly rootTimestamp: string;
    readonly maxBytes: number;
  },
): GuidanceRootCacheResult | null {
  if (
    value.source !== options.source ||
    value.root !== path.resolve(options.root) ||
    value.rootTimestamp !== options.rootTimestamp ||
    value.maxBytes !== options.maxBytes ||
    !Array.isArray(value.documents) ||
    !Array.isArray(value.issues)
  ) {
    return null;
  }

  const documents = normalizeDocuments(value.documents, options.source);
  const issues = normalizeIssues(value.issues, options.source);
  if (documents === null || issues === null) {
    return null;
  }

  return { documents, issues };
}

function normalizeDocuments(
  values: readonly unknown[],
  source: GuidanceSource,
): readonly GuidanceDocument[] | null {
  const documents: GuidanceDocument[] = [];
  for (const value of values) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return null;
    }

    const payload = value as Record<string, unknown>;
    if (
      typeof payload.id !== "string" ||
      payload.source !== source ||
      typeof payload.root !== "string" ||
      typeof payload.filePath !== "string" ||
      typeof payload.relativePath !== "string" ||
      typeof payload.content !== "string"
    ) {
      return null;
    }

    const paths = normalizePaths(payload.paths);
    if (paths === undefined) {
      return null;
    }

    documents.push({
      id: payload.id,
      source,
      root: payload.root,
      filePath: payload.filePath,
      relativePath: payload.relativePath,
      paths,
      content: payload.content,
    });
  }
  return documents;
}

function normalizeIssues(
  values: readonly unknown[],
  source: GuidanceSource,
): readonly GuidanceIssue[] | null {
  const issues: GuidanceIssue[] = [];
  for (const value of values) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return null;
    }

    const payload = value as Record<string, unknown>;
    if (
      typeof payload.filePath !== "string" ||
      payload.source !== source ||
      typeof payload.reason !== "string" ||
      !ISSUE_REASONS.has(payload.reason as GuidanceIssueReason) ||
      typeof payload.message !== "string"
    ) {
      return null;
    }

    issues.push({
      filePath: payload.filePath,
      source,
      reason: payload.reason as GuidanceIssueReason,
      message: payload.message,
    });
  }
  return issues;
}

function normalizePaths(value: unknown): readonly string[] | null | undefined {
  if (value === null) {
    return null;
  }
  if (
    Array.isArray(value) &&
    value.every((entry) => typeof entry === "string")
  ) {
    return value;
  }
  return undefined;
}

function parseJsonArray(value: unknown): unknown {
  if (typeof value !== "string") {
    return null;
  }

  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function withDatabase<T>(
  options: GuidanceDatabaseOptions,
  callback: (database: ReturnType<typeof openGuidanceDatabase>) => T,
): T | null {
  let database;
  try {
    database = openGuidanceDatabase(options);
  } catch {
    return null;
  }

  try {
    return callback(database);
  } catch {
    return null;
  } finally {
    database.close();
  }
}

function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
