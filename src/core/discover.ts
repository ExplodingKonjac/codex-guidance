import { readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createGuidanceRootTimestamp,
  readGuidanceRootCache,
  writeGuidanceRootCache,
  type GuidanceRootFileMetadata,
} from "./cache";
import { parseGuidanceFile } from "./parse";
import type { GuidanceDocument, GuidanceIssue, GuidanceRoot } from "./types";

export const DEFAULT_MAX_GUIDANCE_BYTES = 256 * 1024;

interface GuidanceRootsOptions {
  readonly homeDir?: string;
  readonly repoRoot: string;
}

interface DiscoverGuidanceOptions extends GuidanceRootsOptions {
  readonly maxBytes?: number;
  readonly pluginDataDir?: string;
}

export interface DiscoverGuidanceResult {
  readonly documents: readonly GuidanceDocument[];
  readonly issues: readonly GuidanceIssue[];
}

export function getGuidanceRoots(
  options: GuidanceRootsOptions,
): readonly GuidanceRoot[] {
  const homeDir = options.homeDir ?? os.homedir();
  return [
    { source: "user", root: path.join(homeDir, ".codex", "guidance") },
    {
      source: "codex",
      root: path.join(options.repoRoot, ".codex", "guidance"),
    },
    {
      source: "agents",
      root: path.join(options.repoRoot, ".agents", "guidance"),
    },
    { source: "claude", root: path.join(options.repoRoot, ".claude", "rules") },
  ];
}

interface MarkdownFile extends GuidanceRootFileMetadata {
  readonly filePath: string;
}

interface DiscoverGuidanceRootResult {
  readonly documents: readonly GuidanceDocument[];
  readonly issues: readonly GuidanceIssue[];
}

function isMarkdownFile(filePath: string): boolean {
  const extension = path.extname(filePath).toLowerCase();
  return extension === ".md" || extension === ".markdown";
}

async function listMarkdownFiles(root: string): Promise<readonly MarkdownFile[]> {
  return listMarkdownFilesRecursive(root, root);
}

async function listMarkdownFilesRecursive(
  root: string,
  currentDir: string,
): Promise<readonly MarkdownFile[]> {
  let entries;
  try {
    entries = await readdir(currentDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: MarkdownFile[] = [];
  for (const entry of entries) {
    const entryPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listMarkdownFilesRecursive(root, entryPath)));
    } else if (entry.isFile() && isMarkdownFile(entry.name)) {
      const relativePath = path
        .relative(path.resolve(root), path.resolve(entryPath))
        .split(path.sep)
        .join("/");
      files.push({
        filePath: entryPath,
        relativePath,
        ...(await fileMetadata(entryPath)),
      });
    }
  }

  return files.sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  );
}

async function fileMetadata(
  filePath: string,
): Promise<Pick<GuidanceRootFileMetadata, "size" | "mtimeMs">> {
  try {
    const metadata = await stat(filePath);
    return {
      size: metadata.size,
      mtimeMs: metadata.mtimeMs,
    };
  } catch {
    return {
      size: -1,
      mtimeMs: -1,
    };
  }
}

async function discoverGuidanceRoot(
  guidanceRoot: GuidanceRoot,
  options: Required<Pick<DiscoverGuidanceOptions, "maxBytes">> &
    Pick<DiscoverGuidanceOptions, "pluginDataDir">,
): Promise<DiscoverGuidanceRootResult> {
  const files = await listMarkdownFiles(guidanceRoot.root);
  const rootTimestamp = createGuidanceRootTimestamp(files);

  if (
    options.pluginDataDir !== undefined &&
    options.pluginDataDir.trim().length > 0
  ) {
    const cached = await readGuidanceRootCache({
      pluginDataDir: options.pluginDataDir,
      source: guidanceRoot.source,
      root: guidanceRoot.root,
      rootTimestamp,
      maxBytes: options.maxBytes,
    });
    if (cached !== null) {
      return cached;
    }
  }

  const documents: GuidanceDocument[] = [];
  const issues: GuidanceIssue[] = [];
  for (const file of files) {
    const result = await parseGuidanceFile({
      source: guidanceRoot.source,
      root: guidanceRoot.root,
      filePath: file.filePath,
      maxBytes: options.maxBytes,
    });
    if (result.document !== undefined) {
      documents.push(result.document);
    }
    if (result.issue !== undefined) {
      issues.push(result.issue);
    }
  }

  if (
    options.pluginDataDir !== undefined &&
    options.pluginDataDir.trim().length > 0
  ) {
    await writeGuidanceRootCache({
      pluginDataDir: options.pluginDataDir,
      source: guidanceRoot.source,
      root: guidanceRoot.root,
      rootTimestamp,
      maxBytes: options.maxBytes,
      documents,
      issues,
    });
  }

  return { documents, issues };
}

export async function discoverGuidance(
  options: DiscoverGuidanceOptions,
): Promise<DiscoverGuidanceResult> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_GUIDANCE_BYTES;
  const documents: GuidanceDocument[] = [];
  const issues: GuidanceIssue[] = [];

  for (const guidanceRoot of getGuidanceRoots(options)) {
    const result = await discoverGuidanceRoot(guidanceRoot, {
      maxBytes,
      ...(options.pluginDataDir === undefined
        ? {}
        : { pluginDataDir: options.pluginDataDir }),
    });
    documents.push(...result.documents);
    issues.push(...result.issues);
  }

  return { documents, issues };
}
