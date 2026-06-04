import { readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { parseGuidanceFile } from "./parse";
import type { GuidanceDocument, GuidanceIssue, GuidanceRoot } from "./types";

export const DEFAULT_MAX_GUIDANCE_BYTES = 256 * 1024;

interface GuidanceRootsOptions {
  readonly homeDir?: string;
  readonly repoRoot: string;
}

interface DiscoverGuidanceOptions extends GuidanceRootsOptions {
  readonly maxBytes?: number;
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

function isMarkdownFile(filePath: string): boolean {
  const extension = path.extname(filePath).toLowerCase();
  return extension === ".md" || extension === ".markdown";
}

async function listMarkdownFiles(root: string): Promise<readonly string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listMarkdownFiles(entryPath)));
    } else if (entry.isFile() && isMarkdownFile(entry.name)) {
      files.push(entryPath);
    }
  }

  return files.sort((left, right) => left.localeCompare(right));
}

export async function discoverGuidance(
  options: DiscoverGuidanceOptions,
): Promise<DiscoverGuidanceResult> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_GUIDANCE_BYTES;
  const documents: GuidanceDocument[] = [];
  const issues: GuidanceIssue[] = [];

  for (const guidanceRoot of getGuidanceRoots(options)) {
    const filePaths = await listMarkdownFiles(guidanceRoot.root);
    for (const filePath of filePaths) {
      const result = await parseGuidanceFile({
        source: guidanceRoot.source,
        root: guidanceRoot.root,
        filePath,
        maxBytes,
      });
      if (result.document !== undefined) {
        documents.push(result.document);
      }
      if (result.issue !== undefined) {
        issues.push(result.issue);
      }
    }
  }

  return { documents, issues };
}
