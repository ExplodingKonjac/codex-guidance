import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "../test_support";

import { getDatabasePath } from "./sqlite";
import {
  compactSessionState,
  loadSessionState,
  markGuidanceLoaded,
  selectUnloadedGuidance,
} from "./state";
import type { GuidanceDocument } from "./types";

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

function doc(id: string): GuidanceDocument {
  return {
    id,
    source: "codex",
    root: "/repo/.codex/guidance",
    filePath: `/repo/.codex/guidance/${id}.md`,
    relativePath: `${id}.md`,
    paths: null,
    content: `# ${id}`,
  };
}

function openDatabase(pluginDataDir: string): DatabaseSync {
  return new DatabaseSync(getDatabasePath({ pluginDataDir }));
}

describe("session state", () => {
  it("creates a default state for new sessions", async () => {
    const pluginDataDir = await tempDir("codex-guidance-state-");

    const state = await loadSessionState({
      sessionId: "new-session",
      pluginDataDir,
    });

    expect(state).toEqual({
      generation: 0,
      loaded: {
        "0": [],
      },
    });
  });

  it("sanitizes session IDs before storing them in SQLite", async () => {
    const pluginDataDir = await tempDir("codex-guidance-state-");

    const result = await markGuidanceLoaded({
      sessionId: "../unsafe/session",
      pluginDataDir,
      guidanceIds: ["codex:a.md"],
    });

    expect(result.ok).toBe(true);
    const database = openDatabase(pluginDataDir);
    try {
      const sessions = database
        .prepare("SELECT session_id FROM session_state")
        .all() as Array<{ session_id?: unknown }>;
      expect(sessions).toEqual([{ session_id: "unsafe-session" }]);
    } finally {
      database.close();
    }
  });

  it("throws when PLUGIN_DATA is unavailable", () => {
    const previousPluginData = process.env.PLUGIN_DATA;
    delete process.env.PLUGIN_DATA;
    try {
      expect(() => getDatabasePath({})).toThrow("PLUGIN_DATA is required");
    } finally {
      if (previousPluginData === undefined) {
        delete process.env.PLUGIN_DATA;
      } else {
        process.env.PLUGIN_DATA = previousPluginData;
      }
    }
  });

  it("records loaded guidance only for the current generation", async () => {
    const pluginDataDir = await tempDir("codex-guidance-state-");
    const documents = [doc("codex:a.md"), doc("codex:b.md")];

    expect(
      selectUnloadedGuidance({
        state: { generation: 0, loaded: { "0": ["codex:a.md"] } },
        documents,
      }).map((guidance) => guidance.id),
    ).toEqual(["codex:b.md"]);

    const result = await markGuidanceLoaded({
      sessionId: "loaded-session",
      pluginDataDir,
      guidanceIds: ["codex:a.md", "codex:b.md", "codex:a.md"],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.reason);
    }
    expect(result.state).toEqual({
      generation: 0,
      loaded: {
        "0": ["codex:a.md", "codex:b.md"],
      },
    });
  });

  it("increments generation during compact and treats missing current-generation rows as empty", async () => {
    const pluginDataDir = await tempDir("codex-guidance-state-");
    await markGuidanceLoaded({
      sessionId: "compact-session",
      pluginDataDir,
      guidanceIds: ["codex:a.md"],
    });

    const result = await compactSessionState({
      sessionId: "compact-session",
      pluginDataDir,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.reason);
    }
    expect(result.state).toEqual({
      generation: 1,
      loaded: {
        "0": ["codex:a.md"],
        "1": [],
      },
    });
  });

  it("persists state into SQLite without temp-file bookkeeping", async () => {
    const pluginDataDir = await tempDir("codex-guidance-state-");

    await markGuidanceLoaded({
      sessionId: "atomic-session",
      pluginDataDir,
      guidanceIds: ["codex:a.md"],
    });

    const database = openDatabase(pluginDataDir);
    try {
      const session = database
        .prepare(
          "SELECT generation FROM session_state WHERE session_id = 'atomic-session'",
        )
        .get() as { generation?: unknown } | undefined;
      const loaded = database
        .prepare(
          `
            SELECT guidance_id
            FROM session_loaded_guidance
            WHERE session_id = 'atomic-session' AND generation = 0
          `,
        )
        .all() as Array<{ guidance_id?: unknown }>;

      expect(session).toEqual({ generation: 0 });
      expect(loaded).toEqual([{ guidance_id: "codex:a.md" }]);
    } finally {
      database.close();
    }
  });

  it("fails open when the database cannot be opened", async () => {
    const pluginDataDir = await tempDir("codex-guidance-state-");

    const load = await loadSessionState({
      sessionId: "broken-session",
      pluginDataDir: path.join(pluginDataDir, "missing", "child"),
    });
    expect(load).toEqual({
      generation: 0,
      loaded: {
        "0": [],
      },
    });
  });

  it("returns lock-timeout when a write transaction cannot acquire the SQLite lock quickly", async () => {
    const pluginDataDir = await tempDir("codex-guidance-state-");
    await markGuidanceLoaded({
      sessionId: "locked-session",
      pluginDataDir,
      guidanceIds: ["codex:init.md"],
    });

    const holder = openDatabase(pluginDataDir);
    try {
      holder.exec("BEGIN IMMEDIATE");

      const result = await markGuidanceLoaded({
        sessionId: "locked-session",
        pluginDataDir,
        guidanceIds: ["codex:a.md"],
        lockTimeoutMs: 20,
        lockRetryMs: 1,
      });

      expect(result).toEqual({
        ok: false,
        reason: "lock-timeout",
      });
    } finally {
      holder.exec("ROLLBACK");
      holder.close();
    }
  });
});
