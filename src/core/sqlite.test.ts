import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { handlePostToolUse } from "../hooks/post_tool_use";
import { handleSessionStart } from "../hooks/session_start";
import { getDatabasePath } from "./sqlite";

interface Workspace {
  readonly home: string;
  readonly pluginData: string;
  readonly repo: string;
}

async function tempWorkspace(): Promise<Workspace> {
  const base = await mkdtemp(path.join(tmpdir(), "codex-guidance-sqlite-"));
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

function env(workspace: Workspace): NodeJS.ProcessEnv {
  return {
    HOME: workspace.home,
    PLUGIN_DATA: workspace.pluginData,
  };
}

function payload(workspace: Workspace, extra: Record<string, unknown>): string {
  return JSON.stringify({
    hook_event_name: "Test",
    session_id: "session-1",
    cwd: workspace.repo,
    ...extra,
  });
}

function openDatabase(pluginDataDir: string): DatabaseSync {
  const databasePath = getDatabasePath({ pluginDataDir });
  return new DatabaseSync(databasePath, { open: true });
}

describe("SQLite storage", () => {
  it("initializes the schema on a brand-new PLUGIN_DATA directory", async () => {
    const workspace = await tempWorkspace();

    await handleSessionStart(
      payload(workspace, {
        hook_event_name: "SessionStart",
      }),
      {
        env: env(workspace),
        cwd: workspace.repo,
      },
    );

    const database = openDatabase(workspace.pluginData);
    try {
      const version = database
        .prepare("PRAGMA user_version")
        .get() as { user_version?: unknown } | undefined;
      const tables = database
        .prepare(
          `
            SELECT name
            FROM sqlite_master
            WHERE type = 'table' AND name IN (
              'session_state',
              'session_loaded_guidance',
              'guidance_root_cache'
            )
            ORDER BY name
          `,
        )
        .all() as Array<{ name?: unknown }>;

      expect(version?.user_version).toBe(1);
      expect(tables).toEqual([
        { name: "guidance_root_cache" },
        { name: "session_loaded_guidance" },
        { name: "session_state" },
      ]);
    } finally {
      database.close();
    }
  });

  it("skips DB usage when user_version is unsupported and leaves the file unchanged", async () => {
    const workspace = await tempWorkspace();
    await writeEnsured(
      path.join(workspace.home, ".codex", "guidance", "preferences.md"),
      "# Preferences\n",
    );

    await mkdir(path.dirname(getDatabasePath({ pluginDataDir: workspace.pluginData })), {
      recursive: true,
    });

    const database = openDatabase(workspace.pluginData);
    try {
      database.exec("PRAGMA user_version = 999");
    } finally {
      database.close();
    }

    const result = await handleSessionStart(
      payload(workspace, {
        hook_event_name: "SessionStart",
      }),
      {
        env: env(workspace),
        cwd: workspace.repo,
      },
    );

    expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });

    const reopened = openDatabase(workspace.pluginData);
    try {
      const version = reopened
        .prepare("PRAGMA user_version")
        .get() as { user_version?: unknown } | undefined;
      const table = reopened
        .prepare(
          `
            SELECT name
            FROM sqlite_master
            WHERE type = 'table' AND name = 'session_state'
          `,
        )
        .get() as { name?: unknown } | undefined;

      expect(version?.user_version).toBe(999);
      expect(table).toBeUndefined();
    } finally {
      reopened.close();
    }
  });

  it("supports multiple sequential hook invocations against the same database file", async () => {
    const workspace = await tempWorkspace();
    await writeEnsured(
      path.join(workspace.home, ".codex", "guidance", "preferences.md"),
      "# Preferences\n",
    );
    await writeEnsured(
      path.join(workspace.repo, ".codex", "guidance", "backend.md"),
      '---\npaths:\n  - "src/**/*.ts"\n---\n# Backend\n',
    );

    const sessionStart = await handleSessionStart(
      payload(workspace, {
        hook_event_name: "SessionStart",
      }),
      {
        env: env(workspace),
        cwd: workspace.repo,
      },
    );
    const read = await handlePostToolUse(
      payload(workspace, {
        hook_event_name: "PostToolUse",
        tool_name: "Read",
        tool_input: {
          path: "src/server/api.ts",
        },
      }),
      {
        env: env(workspace),
        cwd: workspace.repo,
      },
    );

    expect(sessionStart.stdout).not.toBe("");
    expect(read.stdout).not.toBe("");

    const database = openDatabase(workspace.pluginData);
    try {
      const loaded = database
        .prepare(
          `
            SELECT guidance_id
            FROM session_loaded_guidance
            WHERE session_id = 'session-1' AND generation = 0
            ORDER BY guidance_id
          `,
        )
        .all() as Array<{ guidance_id?: unknown }>;
      expect(loaded).toEqual([
        { guidance_id: "codex:backend.md" },
        { guidance_id: "user:preferences.md" },
      ]);
    } finally {
      database.close();
    }
  });
});
