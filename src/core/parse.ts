import { stat, readFile } from "node:fs/promises";
import path from "node:path";

import type {
  GuidanceIssue,
  GuidanceParseResult,
  GuidanceSource,
} from "./types";

interface ParseGuidanceFileOptions {
  readonly source: GuidanceSource;
  readonly root: string;
  readonly filePath: string;
  readonly maxBytes: number;
}

interface FrontMatter {
  readonly data: readonly string[] | null;
  readonly content: string;
}

function issue(
  options: Pick<ParseGuidanceFileOptions, "filePath" | "source">,
  reason: GuidanceIssue["reason"],
  message: string,
): GuidanceParseResult {
  return {
    issue: {
      filePath: options.filePath,
      source: options.source,
      reason,
      message,
    },
  };
}

function normalizeRelativePath(root: string, filePath: string): string | null {
  const relativePath = path.relative(
    path.resolve(root),
    path.resolve(filePath),
  );
  if (
    !relativePath ||
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    return null;
  }
  return relativePath.split(path.sep).join("/");
}

function splitFrontMatter(raw: string): FrontMatter {
  if (!raw.startsWith("---\n") && !raw.startsWith("---\r\n")) {
    return { data: null, content: raw.trim() };
  }

  const newline = raw.startsWith("---\r\n") ? "\r\n" : "\n";
  const closingMarker = `${newline}---${newline}`;
  const closingIndex = raw.indexOf(closingMarker, 4);
  if (closingIndex === -1) {
    throw new Error("missing closing front matter marker");
  }

  const yamlText = raw.slice(4, closingIndex);
  const content = raw.slice(closingIndex + closingMarker.length);
  return {
    data: parseFrontMatter(yamlText),
    content: content.trim(),
  };
}

function parsePaths(data: readonly string[] | null): readonly string[] | null {
  if (data === null) {
    return null;
  }

  if (
    !data.every((value) => typeof value === "string" && value.trim().length > 0)
  ) {
    throw new Error("invalid paths");
  }

  return data.map((value) => value.trim());
}

export async function parseGuidanceFile(
  options: ParseGuidanceFileOptions,
): Promise<GuidanceParseResult> {
  const relativePath = normalizeRelativePath(options.root, options.filePath);
  if (relativePath === null) {
    return issue(
      options,
      "outside-root",
      "Guidance file is outside its configured root.",
    );
  }

  let size = 0;
  try {
    size = (await stat(options.filePath)).size;
  } catch (error) {
    return issue(
      options,
      "read-error",
      error instanceof Error ? error.message : "Unable to stat guidance file.",
    );
  }

  if (size > options.maxBytes) {
    return issue(
      options,
      "oversized",
      `Guidance file exceeds ${options.maxBytes} bytes.`,
    );
  }

  let raw = "";
  try {
    raw = await readFile(options.filePath, "utf8");
  } catch (error) {
    return issue(
      options,
      "read-error",
      error instanceof Error ? error.message : "Unable to read guidance file.",
    );
  }

  let frontMatter: FrontMatter;
  try {
    frontMatter = splitFrontMatter(raw);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Invalid front matter.";
    if (message.startsWith("unsupported:")) {
      return issue(options, "unsupported-front-matter-field", message);
    }
    if (message === "invalid paths") {
      return issue(
        options,
        "invalid-paths-field",
        "`paths` must be an array of non-empty strings.",
      );
    }
    return issue(
      options,
      "invalid-front-matter",
      message,
    );
  }

  let paths: readonly string[] | null;
  try {
    paths = parsePaths(frontMatter.data);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Invalid front matter.";
    if (message.startsWith("unsupported:")) {
      return issue(options, "unsupported-front-matter-field", message);
    }
    if (message === "invalid paths") {
      return issue(
        options,
        "invalid-paths-field",
        "`paths` must be an array of non-empty strings.",
      );
    }
    return issue(options, "invalid-front-matter", message);
  }

  return {
    document: {
      id: `${options.source}:${relativePath}`,
      source: options.source,
      root: path.resolve(options.root),
      filePath: path.resolve(options.filePath),
      relativePath,
      paths,
      content: frontMatter.content,
    },
  };
}

function parseFrontMatter(raw: string): readonly string[] | null {
  const lines = raw.split(/\r?\n/);
  if (lines.every((line) => line.trim().length === 0)) {
    return null;
  }

  let index = 0;
  while (index < lines.length && lines[index]?.trim().length === 0) {
    index += 1;
  }

  const firstLine = lines[index];
  if (firstLine === undefined) {
    return null;
  }

  if (!/^paths\s*:\s*$/.test(firstLine.trim())) {
    const keyMatch = /^([A-Za-z0-9_-]+)\s*:(.*)$/.exec(firstLine.trim());
    if (keyMatch !== null) {
      if (keyMatch[1] !== "paths") {
        throw new Error(`unsupported:${keyMatch[1]}`);
      }

      const trailingValue = keyMatch[2]?.trim() ?? "";
      if (
        trailingValue.startsWith("[") &&
        trailingValue.endsWith("]") &&
        trailingValue.length >= 2
      ) {
        throw new Error("invalid paths");
      }
      if (trailingValue.length > 0 && !trailingValue.startsWith("[")) {
        throw new Error("invalid paths");
      }
      throw new Error("invalid-front-matter-line");
    }
    throw new Error("front matter must be a top-level object");
  }

  const paths: string[] = [];
  index += 1;
  for (; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) {
      break;
    }

    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }

    const itemMatch = /^\-\s+(.+)$/.exec(trimmed);
    if (itemMatch !== null) {
      const rawValue = itemMatch[1];
      if (rawValue === undefined) {
        throw new Error("invalid paths");
      }
      const value = parsePathItem(rawValue);
      if (value.length === 0) {
        throw new Error("invalid paths");
      }
      paths.push(value);
      continue;
    }

    const keyMatch = /^([A-Za-z0-9_-]+)\s*:/.exec(trimmed);
    if (keyMatch !== null) {
      throw new Error(`unsupported:${keyMatch[1]}`);
    }

    throw new Error("invalid-front-matter-line");
  }

  return paths;
}

function parsePathItem(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new Error("invalid paths");
  }

  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return unquotePath(trimmed);
  }

  if (
    trimmed.startsWith("[") ||
    trimmed.startsWith("{") ||
    trimmed.includes(": ")
  ) {
    throw new Error("invalid paths");
  }

  return trimmed;
}

function unquotePath(value: string): string {
  const quote = value[0];
  const inner = value.slice(1, -1);
  if (quote === "'") {
    return inner.replaceAll("\\'", "'");
  }

  return inner
    .replaceAll('\\"', '"')
    .replaceAll("\\\\", "\\")
    .replaceAll("\\n", "\n")
    .replaceAll("\\r", "\r")
    .replaceAll("\\t", "\t");
}
