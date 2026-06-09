import path from "node:path";

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
    pathMatchesGuidancePattern(normalizedPath, pattern),
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

function pathMatchesGuidancePattern(
  normalizedPath: string,
  pattern: string,
): boolean {
  if (path.matchesGlob(normalizedPath, pattern)) {
    return true;
  }

  if (!normalizedPath.includes("/.") && !normalizedPath.startsWith(".")) {
    return false;
  }

  return globToDotRegex(pattern).test(normalizedPath);
}

function globToDotRegex(pattern: string): RegExp {
  let regex = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const current = pattern[index];
    if (current === undefined) {
      break;
    }

    if (current === "*") {
      const next = pattern[index + 1];
      const afterNext = pattern[index + 2];
      if (next === "*" && afterNext === "/") {
        regex += "(?:[^/]+/)*";
        index += 2;
        continue;
      }

      if (next === "*") {
        regex += ".*";
        index += 1;
        continue;
      }

      regex += "[^/]*";
      continue;
    }

    if (current === "?") {
      regex += "[^/]";
      continue;
    }

    if (current === "[") {
      const characterClassEnd = pattern.indexOf("]", index + 1);
      if (characterClassEnd !== -1) {
        const rawClass = pattern.slice(index + 1, characterClassEnd);
        if (rawClass.length > 0) {
          const classPrefix =
            rawClass[0] === "!" ? "^" : rawClass[0] === "^" ? "\\^" : "";
          const classBody =
            rawClass[0] === "!" || rawClass[0] === "^"
              ? rawClass.slice(1)
              : rawClass;
          regex += `[${classPrefix}${escapeCharacterClass(classBody)}]`;
          index = characterClassEnd;
          continue;
        }
      }
    }

    regex += escapeRegexCharacter(current);
  }

  return new RegExp(`${regex}$`);
}

function escapeCharacterClass(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("]", "\\]");
}

function escapeRegexCharacter(value: string): string {
  return /[\\^$.*+?()[\]{}|]/.test(value) ? `\\${value}` : value;
}
