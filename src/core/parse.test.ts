import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "../test_support";

import { parseGuidanceFile } from "./parse";

async function tempRoot(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "codex-guidance-parse-"));
}

async function write(
  root: string,
  relativePath: string,
  content: string,
): Promise<string> {
  const filePath = path.join(root, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
  return filePath;
}

describe("parseGuidanceFile", () => {
  it("parses path-scoped guidance and strips YAML front matter", async () => {
    const root = await tempRoot();
    const filePath = await write(
      root,
      "backend/api.md",
      '---\npaths:\n  - "src/**/*.ts"\n  - "test/**/*.ts"\n---\n# API Guidance\n\nUse schemas.\n',
    );

    const result = await parseGuidanceFile({
      source: "codex",
      root,
      filePath,
      maxBytes: 1024,
    });

    expect(result.document).toMatchObject({
      id: "codex:backend/api.md",
      source: "codex",
      relativePath: "backend/api.md",
      paths: ["src/**/*.ts", "test/**/*.ts"],
      content: "# API Guidance\n\nUse schemas.",
    });
    expect(result.issue).toBeUndefined();
  });

  it("accepts quoted and unquoted block-list path items", async () => {
    const root = await tempRoot();
    const filePath = await write(
      root,
      "quoted.md",
      "---\npaths:\n  - src/**/*.ts\n  - 'test/**/*.ts'\n  - \"docs/**/*.md\"\n---\n# Quoted\n",
    );

    const result = await parseGuidanceFile({
      source: "codex",
      root,
      filePath,
      maxBytes: 1024,
    });

    expect(result.document?.paths).toEqual([
      "src/**/*.ts",
      "test/**/*.ts",
      "docs/**/*.md",
    ]);
  });

  it("treats files without front matter paths as global guidance", async () => {
    const root = await tempRoot();
    const filePath = await write(
      root,
      "preferences.md",
      "# Preferences\n\nBe concise.\n",
    );

    const result = await parseGuidanceFile({
      source: "user",
      root,
      filePath,
      maxBytes: 1024,
    });

    expect(result.document?.id).toBe("user:preferences.md");
    expect(result.document?.paths).toBeNull();
    expect(result.document?.content).toBe("# Preferences\n\nBe concise.");
  });

  it("skips guidance with unsupported front matter fields", async () => {
    const root = await tempRoot();
    const filePath = await write(
      root,
      "bad.md",
      '---\npaths:\n  - "src/**"\ntags:\n  - backend\n---\n# Bad\n',
    );

    const result = await parseGuidanceFile({
      source: "agents",
      root,
      filePath,
      maxBytes: 1024,
    });

    expect(result.document).toBeUndefined();
    expect(result.issue).toMatchObject({
      filePath,
      source: "agents",
      reason: "unsupported-front-matter-field",
    });
  });

  it("skips invalid YAML front matter", async () => {
    const root = await tempRoot();
    const filePath = await write(
      root,
      "invalid.md",
      "---\npaths: [unterminated\n---\n# Bad\n",
    );

    const result = await parseGuidanceFile({
      source: "claude",
      root,
      filePath,
      maxBytes: 1024,
    });

    expect(result.document).toBeUndefined();
    expect(result.issue).toMatchObject({
      filePath,
      reason: "invalid-front-matter",
    });
  });

  it("rejects inline-array path syntax to keep front matter narrow", async () => {
    const root = await tempRoot();
    const filePath = await write(
      root,
      "inline-array.md",
      '---\npaths: ["src/**/*.ts"]\n---\n# Bad\n',
    );

    const result = await parseGuidanceFile({
      source: "claude",
      root,
      filePath,
      maxBytes: 1024,
    });

    expect(result.document).toBeUndefined();
    expect(result.issue).toMatchObject({
      filePath,
      reason: "invalid-paths-field",
    });
  });

  it("skips files larger than the configured maximum", async () => {
    const root = await tempRoot();
    const filePath = await write(
      root,
      "large.md",
      "# Large\n\nThis file is too large.\n",
    );

    const result = await parseGuidanceFile({
      source: "user",
      root,
      filePath,
      maxBytes: 8,
    });

    expect(result.document).toBeUndefined();
    expect(result.issue).toMatchObject({
      filePath,
      reason: "oversized",
    });
  });

  it("skips files outside the configured root", async () => {
    const root = await tempRoot();
    const otherRoot = await tempRoot();
    const filePath = await write(otherRoot, "outside.md", "# Outside\n");

    const result = await parseGuidanceFile({
      source: "codex",
      root,
      filePath,
      maxBytes: 1024,
    });

    expect(result.document).toBeUndefined();
    expect(result.issue).toMatchObject({
      filePath,
      reason: "outside-root",
    });
  });
});
