import { describe, expect, it } from "vitest";

import { extractToolPaths } from "./path-extract";

describe("extractToolPaths", () => {
  it("extracts paths from common Codex read/write/edit tool fields", () => {
    expect(
      extractToolPaths({
        toolName: "Read",
        toolInput: {
          path: "src/core/parse.ts",
        },
      }),
    ).toEqual(["src/core/parse.ts"]);

    expect(
      extractToolPaths({
        toolName: "Edit",
        toolInput: {
          file_path: "src/core/state.ts",
        },
      }),
    ).toEqual(["src/core/state.ts"]);

    expect(
      extractToolPaths({
        toolName: "Write",
        toolInput: {
          filePath: "src/core/render.ts",
        },
      }),
    ).toEqual(["src/core/render.ts"]);

    expect(
      extractToolPaths({
        toolName: "Read",
        toolInput: {
          filepath: "src/core/match.ts",
        },
      }),
    ).toEqual(["src/core/match.ts"]);
  });

  it("extracts arrays from paths and files while dropping invalid values", () => {
    expect(
      extractToolPaths({
        toolName: "Read",
        toolInput: {
          paths: ["src/a.ts", "", 7, "src/b.ts"],
          files: [
            { path: "src/c.ts" },
            { file: "src/d.ts" },
            { nope: "ignored.ts" },
          ],
        },
      }),
    ).toEqual(["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"]);
  });

  it("extracts paths from obvious MCP read/write/edit input shapes", () => {
    expect(
      extractToolPaths({
        toolName: "mcp__filesystem__read_file",
        toolInput: {
          arguments: {
            path: "src/from-arguments.ts",
          },
        },
      }),
    ).toEqual(["src/from-arguments.ts"]);

    expect(
      extractToolPaths({
        toolName: "mcp__filesystem__edit_file",
        toolInput: {
          params: {
            files: [{ filePath: "src/from-params.ts" }],
          },
        },
      }),
    ).toEqual(["src/from-params.ts"]);
  });

  it("extracts changed files from apply_patch headers", () => {
    const patch = `*** Begin Patch
*** Add File: src/new.ts
+export {};
*** Update File: src/existing.ts
@@
-old
+new
*** Delete File: src/old.ts
*** Update File: src/moved.ts
*** Move to: src/renamed.ts
*** End Patch
`;

    expect(
      extractToolPaths({
        toolName: "apply_patch",
        toolInput: {
          command: patch,
        },
      }),
    ).toEqual([
      "src/new.ts",
      "src/existing.ts",
      "src/old.ts",
      "src/moved.ts",
      "src/renamed.ts",
    ]);
  });

  it("ignores non-official apply_patch payload fields", () => {
    expect(
      extractToolPaths({
        toolName: "apply_patch",
        toolInput: {
          input:
            "*** Begin Patch\n*** Update File: src/input.ts\n*** End Patch\n",
        },
      }),
    ).toEqual([]);

    expect(
      extractToolPaths({
        toolName: "apply_patch",
        toolInput: {
          patch:
            "*** Begin Patch\n*** Update File: src/patch.ts\n*** End Patch\n",
        },
      }),
    ).toEqual([]);

    expect(
      extractToolPaths({
        toolName: "apply_patch",
        toolInput: "*** Begin Patch\n*** Update File: src/raw.ts\n*** End Patch\n",
      }),
    ).toEqual([]);
  });

  it("deduplicates paths while preserving first-seen order", () => {
    expect(
      extractToolPaths({
        toolName: "Write",
        toolInput: {
          path: "src/a.ts",
          files: ["src/a.ts", "src/b.ts"],
        },
      }),
    ).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("keeps Bash extraction disabled for the MVP", () => {
    expect(
      extractToolPaths({
        toolName: "Bash",
        toolInput: {
          command: "cat src/core/state.ts",
          path: "src/core/state.ts",
        },
      }),
    ).toEqual([]);
  });

  it("returns no paths for unknown or ambiguous tool shapes", () => {
    expect(
      extractToolPaths({
        toolName: "Search",
        toolInput: {
          query: "src/core/state.ts",
        },
      }),
    ).toEqual([]);

    expect(
      extractToolPaths({
        toolName: "Read",
        toolInput: "src/core/state.ts",
      }),
    ).toEqual([]);
  });
});
