import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { handlePostCompact } from "./post_compact";
import { handlePostToolUse } from "./post_tool_use";
import { handlePreToolUse } from "./pre_tool_use";
import { handleSessionStart } from "./session_start";

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

function hookOutput(stdout: string): Record<string, unknown> {
  return JSON.parse(stdout) as Record<string, unknown>;
}

function hookSpecificOutput(stdout: string): Record<string, unknown> {
  return hookOutput(stdout).hookSpecificOutput as Record<string, unknown>;
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
  it("SessionStart injects unloaded global guidance and records it", async () => {
    const workspace = await tempWorkspace();
    await writeGuidance(workspace);

    const result = await handleSessionStart(
      payload(workspace, {
        hook_event_name: "SessionStart",
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

    const state = JSON.parse(
      await readFile(
        path.join(workspace.pluginData, "state", "sessions", "session-1.json"),
        "utf8",
      ),
    );
    expect(state.loaded["0"]).toEqual(["user:preferences.md"]);
    await expect(
      readdir(path.join(workspace.pluginData, "cache", "guidance")),
    ).resolves.toHaveLength(4);
  });

  it("PostToolUse injects matching read guidance once", async () => {
    const workspace = await tempWorkspace();
    await writeGuidance(workspace);

    const first = await handlePostToolUse(
      payload(workspace, {
        hook_event_name: "PostToolUse",
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
        tool_name: "Read",
        tool_input: {
          path: "src/server/api.ts",
        },
      }),
      { env: env(workspace), cwd: workspace.repo },
    );

    expect(second).toEqual({ exitCode: 0, stdout: "", stderr: "" });
  });

  it("PreToolUse injects unloaded edit guidance, records it, and denies once", async () => {
    const workspace = await tempWorkspace();
    await writeGuidance(workspace);
    const raw = payload(workspace, {
      hook_event_name: "PreToolUse",
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

  it("PostCompact increments generation so matching reads reload guidance", async () => {
    const workspace = await tempWorkspace();
    await writeGuidance(workspace);
    const read = payload(workspace, {
      hook_event_name: "PostToolUse",
      tool_name: "Read",
      tool_input: {
        path: "src/server/api.ts",
      },
    });

    await handlePostToolUse(read, { env: env(workspace), cwd: workspace.repo });
    const compact = await handlePostCompact(
      payload(workspace, {
        hook_event_name: "PostCompact",
      }),
      { env: env(workspace), cwd: workspace.repo },
    );
    expect(compact).toEqual({ exitCode: 0, stdout: "", stderr: "" });

    const afterCompact = await handlePostToolUse(read, {
      env: env(workspace),
      cwd: workspace.repo,
    });
    expect(hookSpecificOutput(afterCompact.stdout).additionalContext).toContain(
      '<guidance id="codex:backend.md">',
    );
  });

  it("fails open for malformed JSON and unknown path shapes", async () => {
    const workspace = await tempWorkspace();
    await writeGuidance(workspace);

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
          tool_name: "Read",
          tool_input: {
            query: "src/server/api.ts",
          },
        }),
        { env: env(workspace), cwd: workspace.repo },
      ),
    ).resolves.toEqual({ exitCode: 0, stdout: "", stderr: "" });
  });

  it("fails open instead of denying when the state lock cannot be acquired", async () => {
    const workspace = await tempWorkspace();
    await writeGuidance(workspace);
    await mkdir(path.join(workspace.pluginData, "state", "sessions"), {
      recursive: true,
    });
    await writeFile(
      path.join(workspace.pluginData, "state", "sessions", "session-1.lock"),
      "held",
      "utf8",
    );

    const result = await handlePreToolUse(
      payload(workspace, {
        hook_event_name: "PreToolUse",
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
  });
});
