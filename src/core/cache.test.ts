import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "../test_support";

import { discoverGuidance, getGuidanceRoots } from "./discover";
import { getDatabasePath } from "./sqlite";

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

function openDatabase(pluginDataDir: string): DatabaseSync {
  return new DatabaseSync(getDatabasePath({ pluginDataDir }));
}

function readCacheRow(
  workspace: Awaited<ReturnType<typeof tempWorkspace>>,
  source: "user" | "codex" | "agents" | "claude",
): {
  readonly root_timestamp: string;
  readonly max_bytes: number;
  readonly documents_json: string;
  readonly issues_json: string;
} {
  const root = guidanceRoot(workspace, source);
  const database = openDatabase(workspace.pluginData);
  try {
    const row = database
      .prepare(
        `
          SELECT root_timestamp, max_bytes, documents_json, issues_json
          FROM guidance_root_cache
          WHERE source = ? AND root = ?
        `,
      )
      .get(root.source, root.root) as
      | {
          root_timestamp?: unknown;
          max_bytes?: unknown;
          documents_json?: unknown;
          issues_json?: unknown;
        }
      | undefined;
    if (
      row === undefined ||
      typeof row.root_timestamp !== "string" ||
      typeof row.max_bytes !== "number" ||
      typeof row.documents_json !== "string" ||
      typeof row.issues_json !== "string"
    ) {
      throw new Error(`missing cache row for ${source}`);
    }
    return row as {
      readonly root_timestamp: string;
      readonly max_bytes: number;
      readonly documents_json: string;
      readonly issues_json: string;
    };
  } finally {
    database.close();
  }
}

function writeCachePayload(
  workspace: Awaited<ReturnType<typeof tempWorkspace>>,
  source: "user" | "codex" | "agents" | "claude",
  payload: {
    readonly documents_json: string;
    readonly issues_json: string;
  },
): void {
  const root = guidanceRoot(workspace, source);
  const database = openDatabase(workspace.pluginData);
  try {
    const existing = readCacheRow(workspace, source);
    database
      .prepare(
        `
          UPDATE guidance_root_cache
          SET documents_json = ?, issues_json = ?
          WHERE source = ? AND root = ?
            AND root_timestamp = ? AND max_bytes = ?
        `,
      )
      .run(
        payload.documents_json,
        payload.issues_json,
        root.source,
        root.root,
        existing.root_timestamp,
        existing.max_bytes,
      );
  } finally {
    database.close();
  }
}

describe("guidance discovery cache", () => {
  it("writes one cache row per guidance root on first discovery", async () => {
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

    const database = openDatabase(workspace.pluginData);
    try {
      const row = database
        .prepare("SELECT COUNT(*) AS count FROM guidance_root_cache")
        .get() as { count?: unknown } | undefined;
      expect(row?.count).toBe(4);
    } finally {
      database.close();
    }
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

    const userCache = readCacheRow(workspace, "user");
    const cachedDocuments = JSON.parse(userCache.documents_json) as Array<
      Record<string, unknown>
    >;
    if (cachedDocuments[0] === undefined) {
      throw new Error("expected cached user document");
    }
    cachedDocuments[0].content = "# Cached Preferences";
    writeCachePayload(workspace, "user", {
      documents_json: JSON.stringify(cachedDocuments),
      issues_json: userCache.issues_json,
    });

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

    const codexCache = readCacheRow(workspace, "codex");
    const cachedDocuments = JSON.parse(codexCache.documents_json) as Array<
      Record<string, unknown>
    >;
    if (cachedDocuments[0] === undefined) {
      throw new Error("expected cached codex document");
    }
    cachedDocuments[0].content = "# Cached Backend";
    writeCachePayload(workspace, "codex", {
      documents_json: JSON.stringify(cachedDocuments),
      issues_json: codexCache.issues_json,
    });

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

  it("falls back to fresh discovery for corrupted and stale cache rows", async () => {
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

    const userRoot = guidanceRoot(workspace, "user");
    const database = openDatabase(workspace.pluginData);
    try {
      database.exec("PRAGMA user_version = 999");
    } finally {
      database.close();
    }

    let result = await discoverGuidance({
      homeDir: workspace.home,
      repoRoot: workspace.repo,
      pluginDataDir: workspace.pluginData,
    });
    expect(result.documents[0]?.content).toBe("# Preferences");

    const repaired = openDatabase(workspace.pluginData);
    try {
      repaired.exec("PRAGMA user_version = 1");
      repaired
        .prepare(
          `
            UPDATE guidance_root_cache
            SET documents_json = ?, issues_json = ?
            WHERE source = ? AND root = ?
          `,
        )
        .run("{not json", "[]", userRoot.source, userRoot.root);
    } finally {
      repaired.close();
    }

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

    const claudeCache = readCacheRow(workspace, "claude");
    const cachedIssues = JSON.parse(claudeCache.issues_json) as Array<
      Record<string, unknown>
    >;
    if (cachedIssues[0] === undefined) {
      throw new Error("expected cached claude issue");
    }
    cachedIssues[0].message = "cached oversized issue";
    writeCachePayload(workspace, "claude", {
      documents_json: claudeCache.documents_json,
      issues_json: JSON.stringify(cachedIssues),
    });

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

    const userCache = readCacheRow(workspace, "user");
    writeCachePayload(workspace, "user", {
      documents_json: JSON.stringify([{ source: "user", paths: 7 }]),
      issues_json: userCache.issues_json,
    });
    let result = await discoverGuidance({
      homeDir: workspace.home,
      repoRoot: workspace.repo,
      pluginDataDir: workspace.pluginData,
    });
    expect(result.documents[0]?.content).toBe("# Preferences");

    writeCachePayload(workspace, "user", {
      documents_json: userCache.documents_json,
      issues_json: JSON.stringify([
        { source: "user", reason: "not-real", message: "bad" },
      ]),
    });
    result = await discoverGuidance({
      homeDir: workspace.home,
      repoRoot: workspace.repo,
      pluginDataDir: workspace.pluginData,
    });
    expect(result.documents[0]?.content).toBe("# Preferences");
  });

  it("returns fresh discovery when the database path is unusable or PLUGIN_DATA is absent", async () => {
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
