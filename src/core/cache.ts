import { createHash } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  GuidanceDocument,
  GuidanceIssue,
  GuidanceIssueReason,
  GuidanceSource,
} from "./types";

export const GUIDANCE_CACHE_VERSION = 1;

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

export interface GuidanceRootCacheReadOptions extends GuidanceRootCachePathOptions {
  readonly rootTimestamp: string;
  readonly maxBytes: number;
}

export interface GuidanceRootCacheWriteOptions extends GuidanceRootCacheReadOptions {
  readonly documents: readonly GuidanceDocument[];
  readonly issues: readonly GuidanceIssue[];
}

export interface GuidanceRootCacheResult {
  readonly documents: readonly GuidanceDocument[];
  readonly issues: readonly GuidanceIssue[];
}

interface GuidanceRootCacheEntry extends GuidanceRootCacheResult {
  readonly version: number;
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

export function getGuidanceRootCachePath(
  options: GuidanceRootCachePathOptions,
): string {
  const rootKey = stableHash(
    JSON.stringify({
      source: options.source,
      root: path.resolve(options.root),
    }),
  );
  return path.join(
    path.resolve(options.pluginDataDir),
    "cache",
    "guidance",
    `${rootKey}.json`,
  );
}

export async function readGuidanceRootCache(
  options: GuidanceRootCacheReadOptions,
): Promise<GuidanceRootCacheResult | null> {
  let raw = "";
  try {
    raw = await readFile(getGuidanceRootCachePath(options), "utf8");
  } catch {
    return null;
  }

  try {
    return normalizeCacheEntry(JSON.parse(raw), options);
  } catch {
    return null;
  }
}

export async function writeGuidanceRootCache(
  options: GuidanceRootCacheWriteOptions,
): Promise<void> {
  const cachePath = getGuidanceRootCachePath(options);
  const cacheDir = path.dirname(cachePath);
  let tempFile: string | null = null;

  try {
    await mkdir(cacheDir, { recursive: true });
    tempFile = path.join(
      cacheDir,
      `${path.basename(cachePath)}.${process.pid}.${Date.now()}.${Math.random()
        .toString(16)
        .slice(2)}.tmp`,
    );
    const entry: GuidanceRootCacheEntry = {
      version: GUIDANCE_CACHE_VERSION,
      source: options.source,
      root: path.resolve(options.root),
      rootTimestamp: options.rootTimestamp,
      maxBytes: options.maxBytes,
      documents: options.documents,
      issues: options.issues,
    };
    await writeFile(tempFile, `${JSON.stringify(entry, null, 2)}\n`, "utf8");
    await rename(tempFile, cachePath);
  } catch {
    if (tempFile !== null) {
      try {
        await unlink(tempFile);
      } catch {
        // Best effort cleanup; cache writes are strictly an optimization.
      }
    }
  }
}

function normalizeCacheEntry(
  value: unknown,
  options: GuidanceRootCacheReadOptions,
): GuidanceRootCacheResult | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  const payload = value as Record<string, unknown>;
  if (
    payload.version !== GUIDANCE_CACHE_VERSION ||
    payload.source !== options.source ||
    payload.root !== path.resolve(options.root) ||
    payload.rootTimestamp !== options.rootTimestamp ||
    payload.maxBytes !== options.maxBytes ||
    !Array.isArray(payload.documents) ||
    !Array.isArray(payload.issues)
  ) {
    return null;
  }

  const documents = normalizeDocuments(payload.documents, options.source);
  const issues = normalizeIssues(payload.issues, options.source);
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

function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
