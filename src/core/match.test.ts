import path from "node:path";

import { describe, expect, it } from "../test_support";

import {
  findMatchingGuidance,
  guidanceMatchesPath,
  normalizeTargetPath,
} from "./match";
import type { GuidanceDocument } from "./types";

function doc(id: string, paths: readonly string[] | null): GuidanceDocument {
  return {
    id,
    source: "codex",
    root: "/repo/.codex/guidance",
    filePath: `/repo/.codex/guidance/${id}.md`,
    relativePath: `${id}.md`,
    paths,
    content: `# ${id}`,
  };
}

describe("normalizeTargetPath", () => {
  it("normalizes absolute paths inside the repo to POSIX relative paths", () => {
    const repoRoot = path.join("/tmp", "repo");
    const targetPath = path.join(repoRoot, "src", "core", "match.ts");

    expect(normalizeTargetPath(targetPath, repoRoot)).toBe("src/core/match.ts");
  });

  it("normalizes simple relative paths and Windows separators", () => {
    expect(normalizeTargetPath("src\\core\\match.ts", "/tmp/repo")).toBe(
      "src/core/match.ts",
    );
  });

  it("rejects absolute paths outside the repo", () => {
    expect(
      normalizeTargetPath("/tmp/other/src/file.ts", "/tmp/repo"),
    ).toBeNull();
  });

  it("rejects relative traversal outside the repo", () => {
    expect(normalizeTargetPath("../other/file.ts", "/tmp/repo")).toBeNull();
  });
});

describe("guidanceMatchesPath", () => {
  it("matches Claude-style glob patterns against normalized paths", () => {
    expect(
      guidanceMatchesPath(doc("api", ["src/**/*.ts"]), "src/server/api.ts"),
    ).toBe(true);
    expect(
      guidanceMatchesPath(doc("api", ["src/**/*.ts"]), "test/server/api.ts"),
    ).toBe(false);
  });

  it("treats global guidance as non path-scoped for matching", () => {
    expect(guidanceMatchesPath(doc("global", null), "src/server/api.ts")).toBe(
      false,
    );
  });

  it("continues matching dot-prefixed path segments", () => {
    expect(
      guidanceMatchesPath(doc("api", ["src/**/*.ts"]), "src/.hidden/api.ts"),
    ).toBe(true);
    expect(
      guidanceMatchesPath(doc("api", ["src/**/*.ts"]), "src/server/.api.ts"),
    ).toBe(true);
  });
});

describe("findMatchingGuidance", () => {
  it("returns all path-scoped documents matching a target path", () => {
    const documents = [
      doc("global", null),
      doc("backend", ["src/**/*.ts"]),
      doc("tests", ["test/**/*.ts"]),
      doc("specific", ["src/server/*.ts"]),
    ];

    expect(
      findMatchingGuidance({
        documents,
        repoRoot: "/tmp/repo",
        targetPath: "/tmp/repo/src/server/api.ts",
      }).map((guidance) => guidance.id),
    ).toEqual(["backend", "specific"]);
  });

  it("returns an empty list when the target path is unsafe or unmatched", () => {
    expect(
      findMatchingGuidance({
        documents: [doc("backend", ["src/**/*.ts"])],
        repoRoot: "/tmp/repo",
        targetPath: "/tmp/other/src/api.ts",
      }),
    ).toEqual([]);

    expect(
      findMatchingGuidance({
        documents: [doc("backend", ["src/**/*.ts"])],
        repoRoot: "/tmp/repo",
        targetPath: "docs/readme.md",
      }),
    ).toEqual([]);
  });
});
