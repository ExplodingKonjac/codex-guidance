import { accessSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "./test_support";

import { getDatabasePath } from "./core/sqlite";
import {
  handlePostCompact,
  handlePostToolUse,
  handlePreCompact,
  handlePreToolUse,
  handleSessionStart,
  handleStop,
  handleUserPromptSubmit,
} from "./hook_entry";

interface Workspace {
  readonly home: string;
  readonly pluginData: string;
  readonly repo: string;
}

async function tempWorkspace(): Promise<Workspace> {
  const base = await mkdtemp(path.join(tmpdir(), "codex-guidance-hooks-"));
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

async function writeTranscript(
  workspace: Workspace,
  sessionId: string,
  records: readonly unknown[],
): Promise<string> {
  const transcriptPath = path.join(
    workspace.home,
    ".codex",
    "sessions",
    "2026",
    "06",
    "08",
    `rollout-${sessionId}.jsonl`,
  );
  await writeEnsured(
    transcriptPath,
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
  );
  return transcriptPath;
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

function started(turnId: string): unknown {
  return {
    type: "event_msg",
    payload: {
      type: "task_started",
      turn_id: turnId,
    },
  };
}

function complete(): unknown {
  return {
    type: "event_msg",
    payload: {
      type: "task_complete",
    },
  };
}

function prompt(message = "hello"): unknown {
  return {
    type: "event_msg",
    payload: {
      type: "user_message",
      message,
    },
  };
}

function compacted(): unknown {
  return {
    type: "compacted",
    payload: {
      message: "summary",
      replacement_history: [],
    },
  };
}

async function submitTurn(
  workspace: Workspace,
  turnId: string,
  transcriptPath: string,
): Promise<void> {
  const result = await handleUserPromptSubmit(
    payload(workspace, {
      hook_event_name: "UserPromptSubmit",
      turn_id: turnId,
      transcript_path: transcriptPath,
    }),
    { env: env(workspace), cwd: workspace.repo },
  );
  expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
}

function hookOutput(stdout: string): Record<string, unknown> {
  return JSON.parse(stdout) as Record<string, unknown>;
}

function hookSpecificOutput(stdout: string): Record<string, unknown> {
  return hookOutput(stdout).hookSpecificOutput as Record<string, unknown>;
}

function openDatabase(pluginDataDir: string): DatabaseSync {
  return new DatabaseSync(getDatabasePath({ pluginDataDir }));
}

async function writeGuidance(workspace: Workspace): Promise<void> {
  await writeEnsured(
    path.join(workspace.home, ".codex", "guidance", "preferences.md"),
    "# Preferences\n\nUse the user's style.\n",
  );
  await writeEnsured(
    path.join(workspace.repo, ".codex", "guidance", "backend.md"),
    '---\npaths:\n  - "src/**/*.ts"\n---\n# Backend\n\nUse schemas.\n',
  );
}

describe("hook handlers", () => {
  it("keeps the committed script entrypoints wired to the compiled runtime tree", () => {
    accessSync(path.join(process.cwd(), "scripts", "hook_entry.js"));

    const hookEntryModule = require(path.join(
      process.cwd(),
      "scripts",
      "hook_entry.js",
    )) as Record<string, unknown>;

    expect(typeof hookEntryModule.handleSessionStart).toBe("function");
    expect(typeof hookEntryModule.handleUserPromptSubmit).toBe("function");
    expect(typeof hookEntryModule.handlePostToolUse).toBe("function");
    expect(typeof hookEntryModule.handlePreToolUse).toBe("function");
    expect(typeof hookEntryModule.handlePreCompact).toBe("function");
    expect(typeof hookEntryModule.handlePostCompact).toBe("function");
    expect(typeof hookEntryModule.handleStop).toBe("function");
  });

  it("dispatches through the unified CLI by --hook option", async () => {
    const workspace = await tempWorkspace();
    await writeGuidance(workspace);

    const result = spawnSync(
      process.execPath,
      [
        path.join(process.cwd(), "scripts", "hook_entry.js"),
        "--hook",
        "session_start",
      ],
      {
        cwd: workspace.repo,
        env: {
          ...process.env,
          ...env(workspace),
        },
        input: payload(workspace, {
          hook_event_name: "SessionStart",
          source: "startup",
        }),
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('"hookEventName":"SessionStart"');
  });

  it("SessionStart injects global guidance for startup without a current turn", async () => {
    const workspace = await tempWorkspace();
    await writeGuidance(workspace);

    const result = await handleSessionStart(
      payload(workspace, {
        hook_event_name: "SessionStart",
        source: "startup",
      }),
      { env: env(workspace), cwd: workspace.repo },
    );

    const output = hookSpecificOutput(result.stdout);
    expect(output).toMatchObject({
      hookEventName: "SessionStart",
    });
    expect(output.additionalContext).toContain(
      "Below are global guidance for this session.",
    );
    expect(output.additionalContext).toContain(
      '<guidance id="user:preferences.md">',
    );
    expect(output.additionalContext).not.toContain("codex:backend.md");
    expect(result.stderr).toBe("user:preferences.md loaded\n");

    const database = openDatabase(workspace.pluginData);
    try {
      const cacheRows = database
        .prepare("SELECT COUNT(*) AS count FROM guidance_root_cache")
        .get() as { count?: unknown } | undefined;
      expect(cacheRows?.count).toBe(4);
    } finally {
      database.close();
    }
  });

  it("SessionStart injects global guidance for clear, compact, and missing source", async () => {
    const workspace = await tempWorkspace();
    await writeGuidance(workspace);

    for (const source of ["clear", "compact", undefined]) {
      const result = await handleSessionStart(
        payload(workspace, {
          hook_event_name: "SessionStart",
          ...(source === undefined ? {} : { source }),
        }),
        { env: env(workspace), cwd: workspace.repo },
      );

      expect(hookSpecificOutput(result.stdout).additionalContext).toContain(
        '<guidance id="user:preferences.md">',
      );
    }
  });

  it("SessionStart does not inject global guidance on resume", async () => {
    const workspace = await tempWorkspace();
    await writeGuidance(workspace);

    const result = await handleSessionStart(
      payload(workspace, {
        hook_event_name: "SessionStart",
        source: "resume",
      }),
      { env: env(workspace), cwd: workspace.repo },
    );

    expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
  });

  it("PostToolUse injects matching read guidance once", async () => {
    const workspace = await tempWorkspace();
    await writeGuidance(workspace);
    const transcriptPath = await writeTranscript(workspace, "session-1", [
      started("turn-a"),
      prompt(),
    ]);
    await submitTurn(workspace, "turn-a", transcriptPath);

    const first = await handlePostToolUse(
      payload(workspace, {
        hook_event_name: "PostToolUse",
        turn_id: "turn-a",
        tool_name: "Read",
        tool_input: {
          path: "src/server/api.ts",
        },
      }),
      { env: env(workspace), cwd: workspace.repo },
    );

    expect(hookSpecificOutput(first.stdout)).toMatchObject({
      hookEventName: "PostToolUse",
    });
    expect(hookSpecificOutput(first.stdout).additionalContext).toContain(
      '<guidance id="codex:backend.md">',
    );
    expect(first.stderr).toBe("codex:backend.md loaded\n");

    const second = await handlePostToolUse(
      payload(workspace, {
        hook_event_name: "PostToolUse",
        turn_id: "turn-a",
        tool_name: "Read",
        tool_input: {
          path: "src/server/api.ts",
        },
      }),
      { env: env(workspace), cwd: workspace.repo },
    );

    expect(second).toEqual({ exitCode: 0, stdout: "", stderr: "" });
  });

  it("PostToolUse recognizes MCP-style read tool names", async () => {
    const workspace = await tempWorkspace();
    await writeGuidance(workspace);
    const transcriptPath = await writeTranscript(workspace, "session-1", [
      started("turn-a"),
      prompt(),
    ]);
    await submitTurn(workspace, "turn-a", transcriptPath);

    const result = await handlePostToolUse(
      payload(workspace, {
        hook_event_name: "PostToolUse",
        turn_id: "turn-a",
        tool_name: "mcp__fs__read",
        tool_input: {
          path: "src/server/api.ts",
        },
      }),
      { env: env(workspace), cwd: workspace.repo },
    );

    expect(hookSpecificOutput(result.stdout)).toMatchObject({
      hookEventName: "PostToolUse",
    });
    expect(hookSpecificOutput(result.stdout).additionalContext).toContain(
      '<guidance id="codex:backend.md">',
    );
    expect(result.stderr).toBe("codex:backend.md loaded\n");
  });

  it("PreToolUse injects unloaded edit guidance, records it, and denies once", async () => {
    const workspace = await tempWorkspace();
    await writeGuidance(workspace);
    const transcriptPath = await writeTranscript(workspace, "session-1", [
      started("turn-a"),
      prompt(),
    ]);
    await submitTurn(workspace, "turn-a", transcriptPath);
    const raw = payload(workspace, {
      hook_event_name: "PreToolUse",
      turn_id: "turn-a",
      tool_name: "Edit",
      tool_input: {
        file_path: "src/server/api.ts",
      },
    });

    const first = await handlePreToolUse(raw, {
      env: env(workspace),
      cwd: workspace.repo,
    });
    expect(hookSpecificOutput(first.stdout)).toMatchObject({
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
    });
    expect(hookSpecificOutput(first.stdout).permissionDecisionReason).toContain(
      "Retry the edit",
    );
    expect(hookSpecificOutput(first.stdout).additionalContext).toContain(
      '<guidance id="codex:backend.md">',
    );

    const second = await handlePreToolUse(raw, {
      env: env(workspace),
      cwd: workspace.repo,
    });
    expect(second).toEqual({ exitCode: 0, stdout: "", stderr: "" });
  });

  it("PreCompact prepares a compact node without advancing the cursor", async () => {
    const workspace = await tempWorkspace();
    const transcriptPath = await writeTranscript(workspace, "session-1", [
      started("turn-a"),
      prompt(),
    ]);
    await submitTurn(workspace, "turn-a", transcriptPath);

    const result = await handlePreCompact(
      payload(workspace, {
        hook_event_name: "PreCompact",
        turn_id: "compact-1",
      }),
      { env: env(workspace), cwd: workspace.repo },
    );

    expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    const database = openDatabase(workspace.pluginData);
    try {
      const cursor = database
        .prepare("SELECT current_turn_id FROM session_cursor")
        .get() as { current_turn_id?: unknown } | undefined;
      const compact = database
        .prepare(
          "SELECT parent_turn_id, generation, kind, status FROM turn_node WHERE turn_id = 'compact-1'",
        )
        .get() as Record<string, unknown> | undefined;

      expect(cursor).toEqual({ current_turn_id: "turn-a" });
      expect(compact).toEqual({
        parent_turn_id: "turn-a",
        generation: 1,
        kind: "compact",
        status: "active",
      });
    } finally {
      database.close();
    }
  });

  it("PostCompact creates a generation boundary so matching reads reload guidance", async () => {
    const workspace = await tempWorkspace();
    await writeGuidance(workspace);
    const firstTranscript = await writeTranscript(workspace, "session-1", [
      started("turn-a"),
      prompt(),
    ]);
    await submitTurn(workspace, "turn-a", firstTranscript);
    const read = payload(workspace, {
      hook_event_name: "PostToolUse",
      turn_id: "turn-a",
      tool_name: "Read",
      tool_input: {
        path: "src/server/api.ts",
      },
    });

    await handlePostToolUse(read, { env: env(workspace), cwd: workspace.repo });
    const preCompact = await handlePostCompact(
      payload(workspace, {
        hook_event_name: "PostCompact",
        turn_id: "compact-1",
      }),
      { env: env(workspace), cwd: workspace.repo },
    );
    expect(preCompact).toEqual({ exitCode: 0, stdout: "", stderr: "" });

    const secondTranscript = await writeTranscript(workspace, "session-1", [
      started("turn-a"),
      prompt(),
      complete(),
      started("compact-1"),
      compacted(),
      complete(),
      started("turn-b"),
      prompt("after compact"),
    ]);
    await submitTurn(workspace, "turn-b", secondTranscript);

    const afterCompact = await handlePostToolUse(
      payload(workspace, {
        hook_event_name: "PostToolUse",
        turn_id: "turn-b",
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
    expect(hookSpecificOutput(afterCompact.stdout).additionalContext).toContain(
      '<guidance id="codex:backend.md">',
    );
  });

  it("fails open for malformed JSON and unknown path shapes", async () => {
    const workspace = await tempWorkspace();
    await writeGuidance(workspace);
    const transcriptPath = await writeTranscript(workspace, "session-1", [
      started("turn-a"),
      prompt(),
    ]);
    await submitTurn(workspace, "turn-a", transcriptPath);

    await expect(
      handlePreToolUse("not json", {
        env: env(workspace),
        cwd: workspace.repo,
      }),
    ).resolves.toEqual({ exitCode: 0, stdout: "", stderr: "" });

    await expect(
      handlePostToolUse(
        payload(workspace, {
          hook_event_name: "PostToolUse",
          turn_id: "turn-a",
          tool_name: "Read",
          tool_input: {
            query: "src/server/api.ts",
          },
        }),
        { env: env(workspace), cwd: workspace.repo },
      ),
    ).resolves.toEqual({ exitCode: 0, stdout: "", stderr: "" });
  });

  it("fails open instead of denying when the SQLite write lock cannot be acquired", async () => {
    const workspace = await tempWorkspace();
    await writeGuidance(workspace);
    const transcriptPath = await writeTranscript(workspace, "session-1", [
      started("turn-a"),
      prompt(),
    ]);
    await submitTurn(workspace, "turn-a", transcriptPath);

    await handleSessionStart(
      payload(workspace, {
        hook_event_name: "SessionStart",
        turn_id: "turn-a",
      }),
      { env: env(workspace), cwd: workspace.repo },
    );

    const holder = openDatabase(workspace.pluginData);
    try {
      holder.exec("PRAGMA foreign_keys = ON");
      holder.exec("BEGIN IMMEDIATE");

      const result = await handlePreToolUse(
        payload(workspace, {
          hook_event_name: "PreToolUse",
          turn_id: "turn-a",
          tool_name: "Edit",
          tool_input: {
            file_path: "src/server/api.ts",
          },
        }),
        {
          env: {
            ...env(workspace),
            CODEX_GUIDANCE_LOCK_TIMEOUT_MS: "10",
            CODEX_GUIDANCE_LOCK_RETRY_MS: "1",
          },
          cwd: workspace.repo,
        },
      );

      expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    } finally {
      holder.exec("ROLLBACK");
      holder.close();
    }
  });

  it("UserPromptSubmit fails visibly when transcript resolution fails", async () => {
    const workspace = await tempWorkspace();

    let error: unknown;
    try {
      await handleUserPromptSubmit(
        payload(workspace, {
          hook_event_name: "UserPromptSubmit",
          turn_id: "turn-a",
        }),
        { env: env(workspace), cwd: workspace.repo },
      );
    } catch (caught) {
      error = caught;
    }

    expect(error instanceof Error ? error.message : "").toContain(
      "Unable to resolve transcript_path",
    );
  });

  it("Stop marks the active turn completed", async () => {
    const workspace = await tempWorkspace();
    const transcriptPath = await writeTranscript(workspace, "session-1", [
      started("turn-a"),
      prompt(),
    ]);
    await submitTurn(workspace, "turn-a", transcriptPath);

    const result = await handleStop(
      payload(workspace, {
        hook_event_name: "Stop",
        turn_id: "turn-a",
      }),
      { env: env(workspace), cwd: workspace.repo },
    );

    expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    const database = openDatabase(workspace.pluginData);
    try {
      const row = database
        .prepare("SELECT status FROM turn_node WHERE turn_id = 'turn-a'")
        .get() as { status?: unknown } | undefined;
      expect(row).toEqual({ status: "completed" });
    } finally {
      database.close();
    }
  });
});
