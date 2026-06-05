import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { getGuidanceRootCachePath } from "./cache";
import { discoverGuidance, getGuidanceRoots } from "./discover";

async function tempWorkspace(): Promise<{
  readonly home: string;
  readonly pluginData: string;
  readonly repo: string;
}> {
  const base = await mkdtemp(path.join(tmpdir(), "codex-guidance-cache-"));
  return {
    home: path.join(base, "home"),
    pluginData: path.join(base, "plugin-data"),
    repo: path.join(base, "repo"),
  };
}

async function writeEnsured(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

async function touchFuture(filePath: string, seconds: number): Promise<void> {
  const time = new Date(Date.now() + seconds * 1000);
  await utimes(filePath, time, time);
}

async function readCache(
  workspace: Awaited<ReturnType<typeof tempWorkspace>>,
  source: "user" | "codex" | "agents" | "claude",
): Promise<Record<string, unknown>> {
  const root = guidanceRoot(workspace, source);

  return JSON.parse(
    await readFile(
      getGuidanceRootCachePath({
        pluginDataDir: workspace.pluginData,
        source: root.source,
        root: root.root,
      }),
      "utf8",
    ),
  ) as Record<string, unknown>;
}

async function writeCache(
  workspace: Awaited<ReturnType<typeof tempWorkspace>>,
  source: "user" | "codex" | "agents" | "claude",
  cache: Record<string, unknown>,
): Promise<void> {
  const root = guidanceRoot(workspace, source);

  const cachePath = getGuidanceRootCachePath({
    pluginDataDir: workspace.pluginData,
    source: root.source,
    root: root.root,
  });
  await mkdir(path.dirname(cachePath), { recursive: true });
  await writeFile(cachePath, `${JSON.stringify(cache)}\n`, "utf8");
}

function guidanceRoot(
  workspace: Awaited<ReturnType<typeof tempWorkspace>>,
  source: "user" | "codex" | "agents" | "claude",
) {
  const root = getGuidanceRoots({
    homeDir: workspace.home,
    repoRoot: workspace.repo,
  }).find((candidate) => candidate.source === source);
  if (root === undefined) {
    throw new Error(`missing root ${source}`);
  }
  return root;
}

describe("guidance discovery cache", () => {
  it("writes one cache entry per guidance root on first discovery", async () => {
    const workspace = await tempWorkspace();
    await writeEnsured(
      path.join(workspace.home, ".codex/guidance/preferences.md"),
      "# Preferences\n",
    );

    await discoverGuidance({
      homeDir: workspace.home,
      repoRoot: workspace.repo,
      pluginDataDir: workspace.pluginData,
    });

    expect(
      (await readdir(path.join(workspace.pluginData, "cache", "guidance")))
        .filter((name) => name.endsWith(".json"))
        .sort(),
    ).toHaveLength(4);
  });

  it("reuses unchanged root cache and invalidates only the changed root", async () => {
    const workspace = await tempWorkspace();
    await writeEnsured(
      path.join(workspace.home, ".codex/guidance/preferences.md"),
      "# Preferences\n",
    );
    const claudeFile = path.join(workspace.repo, ".claude/rules/testing.md");
    await writeEnsured(claudeFile, "# Testing\n");

    await discoverGuidance({
      homeDir: workspace.home,
      repoRoot: workspace.repo,
      pluginDataDir: workspace.pluginData,
    });

    const userCache = await readCache(workspace, "user");
    const cachedDocuments = userCache.documents as Array<
      Record<string, unknown>
    >;
    if (cachedDocuments[0] === undefined) {
      throw new Error("expected cached user document");
    }
    cachedDocuments[0].content = "# Cached Preferences";
    await writeCache(workspace, "user", userCache);

    await writeFile(claudeFile, "# Testing\n\nFresh rules.\n", "utf8");
    await touchFuture(claudeFile, 10);

    const result = await discoverGuidance({
      homeDir: workspace.home,
      repoRoot: workspace.repo,
      pluginDataDir: workspace.pluginData,
    });

    expect(
      result.documents.find((document) => document.id === "user:preferences.md")
        ?.content,
    ).toBe("# Cached Preferences");
    expect(
      result.documents.find((document) => document.id === "claude:testing.md")
        ?.content,
    ).toBe("# Testing\n\nFresh rules.");
  });

  it("invalidates nested markdown edits, additions, and removals", async () => {
    const workspace = await tempWorkspace();
    const nestedFile = path.join(
      workspace.repo,
      ".agents/guidance/backend/api.md",
    );
    await writeEnsured(nestedFile, "# API\n");

    await discoverGuidance({
      homeDir: workspace.home,
      repoRoot: workspace.repo,
      pluginDataDir: workspace.pluginData,
    });

    await writeFile(nestedFile, "# API\n\nFresh content.\n", "utf8");
    await touchFuture(nestedFile, 20);
    let result = await discoverGuidance({
      homeDir: workspace.home,
      repoRoot: workspace.repo,
      pluginDataDir: workspace.pluginData,
    });
    expect(result.documents.map((document) => document.id)).toContain(
      "agents:backend/api.md",
    );
    expect(result.documents[0]?.content).toBe("# API\n\nFresh content.");

    await writeEnsured(
      path.join(workspace.repo, ".agents/guidance/backend/model.md"),
      "# Model\n",
    );
    result = await discoverGuidance({
      homeDir: workspace.home,
      repoRoot: workspace.repo,
      pluginDataDir: workspace.pluginData,
    });
    expect(result.documents.map((document) => document.id)).toEqual([
      "agents:backend/api.md",
      "agents:backend/model.md",
    ]);

    await rm(nestedFile);
    result = await discoverGuidance({
      homeDir: workspace.home,
      repoRoot: workspace.repo,
      pluginDataDir: workspace.pluginData,
    });
    expect(result.documents.map((document) => document.id)).toEqual([
      "agents:backend/model.md",
    ]);
  });

  it("does not invalidate a root when only non-Markdown files change", async () => {
    const workspace = await tempWorkspace();
    await writeEnsured(
      path.join(workspace.repo, ".codex/guidance/backend.md"),
      "# Backend\n",
    );
    await discoverGuidance({
      homeDir: workspace.home,
      repoRoot: workspace.repo,
      pluginDataDir: workspace.pluginData,
    });

    const codexCache = await readCache(workspace, "codex");
    const cachedDocuments = codexCache.documents as Array<
      Record<string, unknown>
    >;
    if (cachedDocuments[0] === undefined) {
      throw new Error("expected cached codex document");
    }
    cachedDocuments[0].content = "# Cached Backend";
    await writeCache(workspace, "codex", codexCache);

    await writeEnsured(
      path.join(workspace.repo, ".codex/guidance/notes.txt"),
      "not guidance\n",
    );

    const result = await discoverGuidance({
      homeDir: workspace.home,
      repoRoot: workspace.repo,
      pluginDataDir: workspace.pluginData,
    });

    expect(result.documents.map((document) => document.content)).toEqual([
      "# Cached Backend",
    ]);
  });

  it("falls back to fresh discovery for corrupted and stale cache files", async () => {
    const workspace = await tempWorkspace();
    await writeEnsured(
      path.join(workspace.home, ".codex/guidance/preferences.md"),
      "# Preferences\n",
    );
    await discoverGuidance({
      homeDir: workspace.home,
      repoRoot: workspace.repo,
      pluginDataDir: workspace.pluginData,
    });

    const userCache = await readCache(workspace, "user");
    await writeCache(workspace, "user", { ...userCache, version: 0 });
    let result = await discoverGuidance({
      homeDir: workspace.home,
      repoRoot: workspace.repo,
      pluginDataDir: workspace.pluginData,
    });
    expect(result.documents[0]?.content).toBe("# Preferences");

    const root = guidanceRoot(workspace, "user");
    await writeFile(
      getGuidanceRootCachePath({
        pluginDataDir: workspace.pluginData,
        source: root.source,
        root: root.root,
      }),
      "{not json",
      "utf8",
    );
    result = await discoverGuidance({
      homeDir: workspace.home,
      repoRoot: workspace.repo,
      pluginDataDir: workspace.pluginData,
    });
    expect(result.documents[0]?.content).toBe("# Preferences");
  });

  it("reuses cached discovery issues", async () => {
    const workspace = await tempWorkspace();
    await writeEnsured(
      path.join(workspace.repo, ".claude/rules/large.md"),
      `# Large\n\n${"x".repeat(80)}\n`,
    );

    await discoverGuidance({
      homeDir: workspace.home,
      repoRoot: workspace.repo,
      pluginDataDir: workspace.pluginData,
      maxBytes: 16,
    });

    const claudeCache = await readCache(workspace, "claude");
    const cachedIssues = claudeCache.issues as Array<Record<string, unknown>>;
    if (cachedIssues[0] === undefined) {
      throw new Error("expected cached claude issue");
    }
    cachedIssues[0].message = "cached oversized issue";
    await writeCache(workspace, "claude", claudeCache);

    const result = await discoverGuidance({
      homeDir: workspace.home,
      repoRoot: workspace.repo,
      pluginDataDir: workspace.pluginData,
      maxBytes: 16,
    });

    expect(result.documents).toEqual([]);
    expect(result.issues).toMatchObject([
      {
        source: "claude",
        reason: "oversized",
        message: "cached oversized issue",
      },
    ]);
  });

  it("ignores malformed cached documents and issues", async () => {
    const workspace = await tempWorkspace();
    await writeEnsured(
      path.join(workspace.home, ".codex/guidance/preferences.md"),
      "# Preferences\n",
    );
    await discoverGuidance({
      homeDir: workspace.home,
      repoRoot: workspace.repo,
      pluginDataDir: workspace.pluginData,
    });

    const userCache = await readCache(workspace, "user");
    await writeCache(workspace, "user", {
      ...userCache,
      documents: [{ source: "user", paths: 7 }],
    });
    let result = await discoverGuidance({
      homeDir: workspace.home,
      repoRoot: workspace.repo,
      pluginDataDir: workspace.pluginData,
    });
    expect(result.documents[0]?.content).toBe("# Preferences");

    await writeCache(workspace, "user", {
      ...userCache,
      issues: [{ source: "user", reason: "not-real", message: "bad" }],
    });
    result = await discoverGuidance({
      homeDir: workspace.home,
      repoRoot: workspace.repo,
      pluginDataDir: workspace.pluginData,
    });
    expect(result.documents[0]?.content).toBe("# Preferences");
  });

  it("returns fresh discovery when cache cannot be written or PLUGIN_DATA is absent", async () => {
    const workspace = await tempWorkspace();
    await writeEnsured(
      path.join(workspace.home, ".codex/guidance/preferences.md"),
      "# Preferences\n",
    );
    await writeEnsured(workspace.pluginData, "not a directory\n");

    await expect(
      discoverGuidance({
        homeDir: workspace.home,
        repoRoot: workspace.repo,
        pluginDataDir: workspace.pluginData,
      }),
    ).resolves.toMatchObject({
      documents: [
        {
          id: "user:preferences.md",
          content: "# Preferences",
        },
      ],
    });

    await expect(
      discoverGuidance({
        homeDir: workspace.home,
        repoRoot: workspace.repo,
      }),
    ).resolves.toMatchObject({
      documents: [
        {
          id: "user:preferences.md",
          content: "# Preferences",
        },
      ],
    });
  });
});
