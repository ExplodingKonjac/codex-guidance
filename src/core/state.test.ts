import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "../test_support";

import { getDatabasePath } from "./sqlite";
import {
  ensureCompactTurnNode,
  ensureTurnNode,
  markGuidanceLoadedOnTurn,
  markTurnCompleted,
  resolveCurrentTurnId,
  selectLoadedGuidanceForTurn,
  selectUnloadedGuidanceForTurn,
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

describe("turn-tree state", () => {
  it("sanitizes session IDs before storing cursors in SQLite", async () => {
    const pluginDataDir = await tempDir("codex-guidance-state-");

    const result = await ensureTurnNode({
      sessionId: "../unsafe/session",
      pluginDataDir,
      turnId: "turn-a",
      parentTurnId: null,
    });

    expect(result.ok).toBe(true);
    const database = openDatabase(pluginDataDir);
    try {
      const cursors = database
        .prepare("SELECT session_id, current_turn_id FROM session_cursor")
        .all() as Array<{ session_id?: unknown; current_turn_id?: unknown }>;
      expect(cursors).toEqual([
        { session_id: "unsafe-session", current_turn_id: "turn-a" },
      ]);
    } finally {
      database.close();
    }
  });

  it("creates user turns that inherit parent generation", async () => {
    const pluginDataDir = await tempDir("codex-guidance-state-");

    const root = await ensureTurnNode({
      sessionId: "session-1",
      pluginDataDir,
      turnId: "turn-a",
      parentTurnId: null,
    });
    const child = await ensureTurnNode({
      sessionId: "session-1",
      pluginDataDir,
      turnId: "turn-b",
      parentTurnId: "turn-a",
    });

    expect(root).toMatchObject({ ok: true });
    expect(child).toMatchObject({
      ok: true,
      turn: {
        turnId: "turn-b",
        parentTurnId: "turn-a",
        generation: 0,
        kind: "user",
        status: "active",
      },
    });
    expect(
      await resolveCurrentTurnId({
        sessionId: "session-1",
        pluginDataDir,
      }),
    ).toBe("turn-b");
  });

  it("increments generation at compact boundaries and inherits it afterward", async () => {
    const pluginDataDir = await tempDir("codex-guidance-state-");
    await ensureTurnNode({
      sessionId: "session-1",
      pluginDataDir,
      turnId: "turn-a",
      parentTurnId: null,
    });

    const compact = await ensureCompactTurnNode({
      sessionId: "session-1",
      pluginDataDir,
      turnId: "compact-1",
      parentTurnId: "turn-a",
      complete: true,
    });
    const afterCompact = await ensureTurnNode({
      sessionId: "session-1",
      pluginDataDir,
      turnId: "turn-b",
      parentTurnId: "compact-1",
    });

    expect(compact).toMatchObject({
      ok: true,
      turn: {
        generation: 1,
        kind: "compact",
        status: "completed",
      },
    });
    expect(afterCompact).toMatchObject({
      ok: true,
      turn: {
        generation: 1,
        kind: "user",
      },
    });
  });

  it("loads guidance from same-generation ancestors only", async () => {
    const pluginDataDir = await tempDir("codex-guidance-state-");
    await ensureTurnNode({
      sessionId: "session-1",
      pluginDataDir,
      turnId: "turn-a",
      parentTurnId: null,
    });
    await markGuidanceLoadedOnTurn({
      sessionId: "session-1",
      pluginDataDir,
      turnId: "turn-a",
      guidanceIds: ["codex:before.md"],
    });
    await ensureCompactTurnNode({
      sessionId: "session-1",
      pluginDataDir,
      turnId: "compact-1",
      parentTurnId: "turn-a",
      complete: true,
    });
    await ensureTurnNode({
      sessionId: "session-1",
      pluginDataDir,
      turnId: "turn-b",
      parentTurnId: "compact-1",
    });
    await markGuidanceLoadedOnTurn({
      sessionId: "session-1",
      pluginDataDir,
      turnId: "turn-b",
      guidanceIds: ["codex:after.md"],
    });
    await ensureTurnNode({
      sessionId: "session-1",
      pluginDataDir,
      turnId: "turn-c",
      parentTurnId: "turn-b",
    });

    expect(
      await selectLoadedGuidanceForTurn({
        sessionId: "session-1",
        pluginDataDir,
        turnId: "turn-c",
      }),
    ).toEqual(["codex:after.md"]);
    expect(
      await selectUnloadedGuidanceForTurn({
        sessionId: "session-1",
        pluginDataDir,
        turnId: "turn-c",
        documents: [doc("codex:before.md"), doc("codex:after.md")],
      }),
    ).toEqual([doc("codex:before.md")]);
  });

  it("does not inherit guidance from rolled-back sibling turns", async () => {
    const pluginDataDir = await tempDir("codex-guidance-state-");
    await ensureTurnNode({
      sessionId: "source-session",
      pluginDataDir,
      turnId: "turn-a",
      parentTurnId: null,
    });
    await ensureTurnNode({
      sessionId: "source-session",
      pluginDataDir,
      turnId: "turn-b",
      parentTurnId: "turn-a",
    });
    await markGuidanceLoadedOnTurn({
      sessionId: "source-session",
      pluginDataDir,
      turnId: "turn-b",
      guidanceIds: ["codex:sibling.md"],
    });
    await ensureTurnNode({
      sessionId: "fork-session",
      pluginDataDir,
      turnId: "turn-c",
      parentTurnId: "turn-a",
    });

    expect(
      await selectLoadedGuidanceForTurn({
        sessionId: "fork-session",
        pluginDataDir,
        turnId: "turn-c",
      }),
    ).toEqual([]);
  });

  it("marks turns complete without changing the session cursor", async () => {
    const pluginDataDir = await tempDir("codex-guidance-state-");
    await ensureTurnNode({
      sessionId: "session-1",
      pluginDataDir,
      turnId: "turn-a",
      parentTurnId: null,
    });

    const result = await markTurnCompleted({
      sessionId: "session-1",
      pluginDataDir,
      turnId: "turn-a",
    });

    expect(result).toMatchObject({
      ok: true,
      turn: {
        status: "completed",
      },
    });
    expect(
      await resolveCurrentTurnId({
        sessionId: "session-1",
        pluginDataDir,
      }),
    ).toBe("turn-a");
  });

  it("returns lock-timeout when a write transaction cannot acquire the SQLite lock quickly", async () => {
    const pluginDataDir = await tempDir("codex-guidance-state-");
    await ensureTurnNode({
      sessionId: "session-1",
      pluginDataDir,
      turnId: "turn-a",
      parentTurnId: null,
    });

    const holder = openDatabase(pluginDataDir);
    try {
      holder.exec("BEGIN IMMEDIATE");

      const result = await markGuidanceLoadedOnTurn({
        sessionId: "session-1",
        pluginDataDir,
        turnId: "turn-a",
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
