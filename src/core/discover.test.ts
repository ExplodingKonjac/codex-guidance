import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_MAX_GUIDANCE_BYTES,
  discoverGuidance,
  getGuidanceRoots,
} from "./discover";

async function tempWorkspace(): Promise<{ home: string; repo: string }> {
  const base = await mkdtemp(path.join(tmpdir(), "codex-guidance-discover-"));
  return {
    home: path.join(base, "home"),
    repo: path.join(base, "repo"),
  };
}

async function writeFileEnsured(
  filePath: string,
  content: string,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

describe("getGuidanceRoots", () => {
  it("returns all user and repository guidance roots", async () => {
    const { home, repo } = await tempWorkspace();

    expect(getGuidanceRoots({ homeDir: home, repoRoot: repo })).toEqual([
      { source: "user", root: path.join(home, ".codex", "guidance") },
      { source: "codex", root: path.join(repo, ".codex", "guidance") },
      { source: "agents", root: path.join(repo, ".agents", "guidance") },
      { source: "claude", root: path.join(repo, ".claude", "rules") },
    ]);
  });
});

describe("discoverGuidance", () => {
  it("loads Markdown guidance recursively from all configured roots with stable IDs", async () => {
    const { home, repo } = await tempWorkspace();
    await writeFileEnsured(
      path.join(home, ".codex/guidance/preferences.md"),
      "# Preferences\n",
    );
    await writeFileEnsured(
      path.join(repo, ".codex/guidance/backend/api.md"),
      "# API\n",
    );
    await writeFileEnsured(
      path.join(repo, ".agents/guidance/frontend/react.md"),
      "# React\n",
    );
    await writeFileEnsured(
      path.join(repo, ".claude/rules/testing.md"),
      "# Testing\n",
    );

    const result = await discoverGuidance({ homeDir: home, repoRoot: repo });

    expect(result.issues).toEqual([]);
    expect(result.documents.map((doc) => doc.id)).toEqual([
      "user:preferences.md",
      "codex:backend/api.md",
      "agents:frontend/react.md",
      "claude:testing.md",
    ]);
  });

  it("loads global and path-scoped files while ignoring non-Markdown files", async () => {
    const { home, repo } = await tempWorkspace();
    await writeFileEnsured(
      path.join(home, ".codex/guidance/global.md"),
      "# Global\n",
    );
    await writeFileEnsured(
      path.join(repo, ".codex/guidance/scoped.markdown"),
      '---\npaths:\n  - "src/**/*.ts"\n---\n# Scoped\n',
    );
    await writeFileEnsured(
      path.join(repo, ".codex/guidance/notes.txt"),
      "# Not guidance\n",
    );

    const result = await discoverGuidance({ homeDir: home, repoRoot: repo });

    expect(result.documents).toHaveLength(2);
    expect(result.documents.map((doc) => [doc.id, doc.paths])).toEqual([
      ["user:global.md", null],
      ["codex:scoped.markdown", ["src/**/*.ts"]],
    ]);
  });

  it("reports skipped invalid and oversized guidance files without failing discovery", async () => {
    const { home, repo } = await tempWorkspace();
    await writeFileEnsured(
      path.join(home, ".codex/guidance/good.md"),
      "# Good\n",
    );
    await writeFileEnsured(
      path.join(repo, ".agents/guidance/invalid.md"),
      "---\npaths: 7\n---\n# Bad\n",
    );
    await writeFileEnsured(
      path.join(repo, ".claude/rules/large.md"),
      `# Large\n\n${"x".repeat(80)}\n`,
    );

    const result = await discoverGuidance({
      homeDir: home,
      repoRoot: repo,
      maxBytes: 64,
    });

    expect(result.documents.map((doc) => doc.id)).toEqual(["user:good.md"]);
    expect(result.issues.map((issue) => issue.reason)).toEqual([
      "invalid-paths-field",
      "oversized",
    ]);
  });

  it("uses a documented default maximum file size", () => {
    expect(DEFAULT_MAX_GUIDANCE_BYTES).toBe(256 * 1024);
  });
});
