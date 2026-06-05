import path from "node:path";

import { minimatch } from "minimatch";

import type { GuidanceDocument } from "./types";

export interface FindMatchingGuidanceOptions {
  readonly documents: readonly GuidanceDocument[];
  readonly repoRoot: string;
  readonly targetPath: string;
}

function toPosixPath(value: string): string {
  return value.replaceAll("\\", "/");
}

function isRelativeTraversal(value: string): boolean {
  return value === ".." || value.startsWith("../");
}

export function normalizeTargetPath(
  targetPath: string,
  repoRoot: string,
): string | null {
  const normalizedInput = toPosixPath(targetPath.trim());
  if (normalizedInput.length === 0) {
    return null;
  }

  if (path.isAbsolute(targetPath)) {
    const relativePath = path.relative(
      path.resolve(repoRoot),
      path.resolve(targetPath),
    );
    const posixRelativePath = toPosixPath(relativePath);
    if (
      posixRelativePath.length === 0 ||
      isRelativeTraversal(posixRelativePath) ||
      path.isAbsolute(relativePath)
    ) {
      return null;
    }
    return posixRelativePath;
  }

  const posixRelativePath = normalizedInput.replace(/^\.\/+/, "");
  if (
    posixRelativePath.length === 0 ||
    isRelativeTraversal(posixRelativePath) ||
    path.posix.isAbsolute(posixRelativePath)
  ) {
    return null;
  }

  return posixRelativePath;
}

export function guidanceMatchesPath(
  document: GuidanceDocument,
  normalizedPath: string,
): boolean {
  if (document.paths === null) {
    return false;
  }

  return document.paths.some((pattern) =>
    minimatch(normalizedPath, pattern, {
      dot: true,
      matchBase: false,
      nocase: false,
    }),
  );
}

export function findMatchingGuidance(
  options: FindMatchingGuidanceOptions,
): readonly GuidanceDocument[] {
  const normalizedPath = normalizeTargetPath(
    options.targetPath,
    options.repoRoot,
  );
  if (normalizedPath === null) {
    return [];
  }

  return options.documents.filter((document) =>
    guidanceMatchesPath(document, normalizedPath),
  );
}
