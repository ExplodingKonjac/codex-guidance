import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  compactSessionState,
  getStatePaths,
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

describe("getStatePaths", () => {
  it("uses PLUGIN_DATA for session state and lock files", async () => {
    const pluginDataDir = await tempDir("codex-guidance-plugin-data-");

    expect(
      getStatePaths({
        sessionId: "session-1",
        pluginDataDir,
      }),
    ).toEqual({
      sessionId: "session-1",
      stateDir: path.join(pluginDataDir, "state", "sessions"),
      stateFile: path.join(
        pluginDataDir,
        "state",
        "sessions",
        "session-1.json",
      ),
      lockFile: path.join(pluginDataDir, "state", "sessions", "session-1.lock"),
    });
  });

  it("sanitizes session IDs when PLUGIN_DATA is available", async () => {
    const pluginDataDir = await tempDir("codex-guidance-plugin-data-");

    const paths = getStatePaths({
      sessionId: "../unsafe/session",
      pluginDataDir,
    });

    expect(paths.sessionId).toBe("unsafe-session");
    expect(paths.stateDir).toBe(path.join(pluginDataDir, "state", "sessions"));
  });

  it("throws when PLUGIN_DATA is unavailable", () => {
    const previousPluginData = process.env.PLUGIN_DATA;
    delete process.env.PLUGIN_DATA;
    try {
      expect(() => getStatePaths({ sessionId: "session-1" })).toThrow(
        "PLUGIN_DATA is required",
      );
    } finally {
      if (previousPluginData === undefined) {
        delete process.env.PLUGIN_DATA;
      } else {
        process.env.PLUGIN_DATA = previousPluginData;
      }
    }
  });
});

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

  it("increments generation during compact and initializes an empty loaded set", async () => {
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

  it("writes state atomically and leaves no temp files after success", async () => {
    const pluginDataDir = await tempDir("codex-guidance-state-");
    const paths = getStatePaths({ sessionId: "atomic-session", pluginDataDir });

    await markGuidanceLoaded({
      sessionId: "atomic-session",
      pluginDataDir,
      guidanceIds: ["codex:a.md"],
    });

    expect(JSON.parse(await readFile(paths.stateFile, "utf8"))).toEqual({
      generation: 0,
      loaded: {
        "0": ["codex:a.md"],
      },
    });
    expect(
      (await readdir(paths.stateDir)).filter((name) => name.includes(".tmp")),
    ).toEqual([]);
  });

  it("recovers safely from corrupted state files", async () => {
    const pluginDataDir = await tempDir("codex-guidance-state-");
    const paths = getStatePaths({
      sessionId: "corrupt-session",
      pluginDataDir,
    });
    await mkdir(paths.stateDir, { recursive: true });
    await writeFile(paths.stateFile, "{not json", "utf8");

    const result = await markGuidanceLoaded({
      sessionId: "corrupt-session",
      pluginDataDir,
      guidanceIds: ["codex:a.md"],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.reason);
    }
    expect(result.state).toEqual({
      generation: 0,
      loaded: {
        "0": ["codex:a.md"],
      },
    });
  });

  it("fails open when the lock cannot be acquired quickly", async () => {
    const pluginDataDir = await tempDir("codex-guidance-state-");
    const paths = getStatePaths({ sessionId: "locked-session", pluginDataDir });
    await mkdir(paths.stateDir, { recursive: true });
    await writeFile(paths.lockFile, "held", "utf8");

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
  });
});
