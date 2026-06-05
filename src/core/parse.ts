import { stat, readFile } from "node:fs/promises";
import path from "node:path";

import { parse as parseYaml } from "yaml";

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
  readonly data: unknown;
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
    data: parseYaml(yamlText) ?? {},
    content: content.trim(),
  };
}

function parsePaths(data: unknown): readonly string[] | null {
  if (data === null) {
    return null;
  }

  if (typeof data !== "object" || Array.isArray(data)) {
    throw new Error("front matter must be an object");
  }

  const payload = data as Record<string, unknown>;
  const keys = Object.keys(payload);
  const unsupportedKey = keys.find((key) => key !== "paths");
  if (unsupportedKey !== undefined) {
    throw new Error(`unsupported:${unsupportedKey}`);
  }

  if (!Object.prototype.hasOwnProperty.call(payload, "paths")) {
    return null;
  }

  const rawPaths = payload.paths;
  if (
    !Array.isArray(rawPaths) ||
    !rawPaths.every(
      (value) => typeof value === "string" && value.trim().length > 0,
    )
  ) {
    throw new Error("invalid paths");
  }

  return rawPaths.map((value) => value.trim());
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
    return issue(
      options,
      "invalid-front-matter",
      error instanceof Error ? error.message : "Invalid YAML front matter.",
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
