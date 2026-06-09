import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "../test_support";

import { resolveTurnFromTranscript } from "../../src/core/transcript";

async function transcript(lines: readonly unknown[]): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "codex-guidance-transcript-"));
  const filePath = path.join(dir, "rollout-session-1.jsonl");
  await writeFile(
    filePath,
    `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
    "utf8",
  );
  return filePath;
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

function prompt(content = "hello"): unknown {
  return {
    type: "event_msg",
    payload: {
      type: "user_message",
      message: content,
    },
  };
}

function userShellMessage(): unknown {
  return {
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "date" }],
    },
  };
}

function compacted(): unknown {
  return {
    type: "compacted",
    payload: {
      message: "summary",
      replacement_history: [
        {
          type: "message",
          role: "user",
          content: "previous prompt",
        },
      ],
    },
  };
}

function rollback(numTurns: number): unknown {
  return {
    type: "event_msg",
    payload: {
      type: "thread_rolled_back",
      num_turns: numTurns,
    },
  };
}

describe("transcript turn resolution", () => {
  it("resolves a normal prompt to the previous user turn", async () => {
    const transcriptPath = await transcript([
      started("turn-a"),
      prompt("first"),
      complete(),
      started("turn-b"),
      prompt("second"),
      complete(),
      started("turn-c"),
      prompt("current"),
    ]);

    const resolved = resolveTurnFromTranscript({
      transcriptPath,
      turnId: "turn-c",
    });

    expect(resolved).toEqual({
      turnId: "turn-c",
      parentTurnId: "turn-b",
      kind: "user",
    });
  });

  it("resolves from the transcript tail when the current turn is not appended yet", async () => {
    const transcriptPath = await transcript([
      started("turn-a"),
      prompt("first"),
      complete(),
      started("turn-b"),
      prompt("second"),
      complete(),
    ]);

    const resolved = resolveTurnFromTranscript({
      transcriptPath,
      turnId: "turn-c",
    });

    expect(resolved).toEqual({
      turnId: "turn-c",
      parentTurnId: "turn-b",
      kind: "user",
    });
  });

  it("applies tail rollback when the current turn is not appended yet", async () => {
    const transcriptPath = await transcript([
      started("turn-a"),
      prompt("first"),
      complete(),
      started("compact-1"),
      compacted(),
      complete(),
      started("turn-b"),
      prompt("after compact"),
      complete(),
      rollback(2),
    ]);

    const resolved = resolveTurnFromTranscript({
      transcriptPath,
      turnId: "turn-c",
    });

    expect(resolved.parentTurnId).toBe("compact-1");
  });

  it("ignores user response-item shell command segments as turn parents", async () => {
    const transcriptPath = await transcript([
      started("turn-a"),
      prompt("first"),
      complete(),
      started("turn-shell"),
      userShellMessage(),
      complete(),
      started("turn-c"),
      prompt("current"),
    ]);

    const resolved = resolveTurnFromTranscript({
      transcriptPath,
      turnId: "turn-c",
    });

    expect(resolved.parentTurnId).toBe("turn-a");
  });

  it("does not spend rollback debt on user response-item shell command segments", async () => {
    const transcriptPath = await transcript([
      started("turn-hello"),
      prompt("hello?"),
      complete(),
      started("turn-a"),
      prompt("Write a random, small, standalone C++ source code."),
      complete(),
      started("turn-b"),
      prompt("Write another one."),
      complete(),
      started("turn-shell"),
      userShellMessage(),
      complete(),
      rollback(2),
      started("turn-replay"),
      prompt("Write a random, small, standalone C++ source code."),
    ]);

    const resolved = resolveTurnFromTranscript({
      transcriptPath,
      turnId: "turn-replay",
    });

    expect(resolved).toEqual({
      turnId: "turn-replay",
      parentTurnId: "turn-hello",
      kind: "user",
    });
  });

  it("returns the compact segment as parent when rollback removes later user turns", async () => {
    const transcriptPath = await transcript([
      started("turn-a"),
      prompt("first"),
      complete(),
      started("compact-1"),
      compacted(),
      complete(),
      started("turn-b"),
      prompt("after compact"),
      complete(),
      rollback(2),
      started("turn-c"),
      prompt("current"),
    ]);

    const resolved = resolveTurnFromTranscript({
      transcriptPath,
      turnId: "turn-c",
    });

    expect(resolved).toEqual({
      turnId: "turn-c",
      parentTurnId: "compact-1",
      kind: "user",
    });
  });

  it("keeps a surviving later user turn after rollback debt is consumed", async () => {
    const transcriptPath = await transcript([
      started("turn-a"),
      prompt("first"),
      complete(),
      started("compact-1"),
      compacted(),
      complete(),
      started("turn-b"),
      prompt("after compact"),
      complete(),
      started("turn-c"),
      prompt("survives"),
      complete(),
      rollback(1),
      started("turn-d"),
      prompt("current"),
    ]);

    const resolved = resolveTurnFromTranscript({
      transcriptPath,
      turnId: "turn-d",
    });

    expect(resolved.parentTurnId).toBe("turn-b");
  });

  it("fails loudly on malformed relevant transcript records", async () => {
    const transcriptPath = await transcript([
      started("turn-a"),
      prompt(),
      complete(),
      {
        type: "event_msg",
        payload: {
          type: "task_started",
        },
      },
      prompt("current"),
    ]);

    expect(() =>
      resolveTurnFromTranscript({
        transcriptPath,
        turnId: "turn-b",
      }),
    ).toThrow("missing turn_id");
  });
});
