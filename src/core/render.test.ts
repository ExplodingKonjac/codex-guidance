import { describe, expect, it } from "../test_support";

import {
  renderGlobalGuidance,
  renderLoadedStatus,
  renderPathGuidance,
} from "./render";
import type { GuidanceDocument } from "./types";

function doc(id: string, content: string): GuidanceDocument {
  return {
    id,
    source: "codex",
    root: "/repo/.codex/guidance",
    filePath: `/repo/.codex/guidance/${id}.md`,
    relativePath: `${id}.md`,
    paths: null,
    content,
  };
}

describe("renderGlobalGuidance", () => {
  it("renders global guidance with the exact design header and tags", () => {
    expect(
      renderGlobalGuidance([doc("user:preferences.md", "# Preferences")]),
    ).toBe(
      `Below are global guidance for this session. You must follow them in later actions:

<guidance id="user:preferences.md">
# Preferences
</guidance>`,
    );
  });
});

describe("renderPathGuidance", () => {
  it("renders file-related guidance with the exact design header and tags", () => {
    expect(
      renderPathGuidance([doc("codex:backend/api.md", "Use schemas.")]),
    ).toBe(
      `Below are guidance related to the current file. You must follow them in later actions:

<guidance id="codex:backend/api.md">
Use schemas.
</guidance>`,
    );
  });

  it("renders documents in deterministic ID order", () => {
    expect(
      renderPathGuidance([doc("codex:z.md", "Z"), doc("codex:a.md", "A")]),
    ).toContain(
      `<guidance id="codex:a.md">\nA\n</guidance>\n\n<guidance id="codex:z.md">`,
    );
  });

  it("returns an empty string when there is no guidance to render", () => {
    expect(renderPathGuidance([])).toBe("");
    expect(renderGlobalGuidance([])).toBe("");
  });
});

describe("renderLoadedStatus", () => {
  it("renders concise loaded status lines in deterministic order", () => {
    expect(
      renderLoadedStatus([doc("codex:z.md", "Z"), doc("codex:a.md", "A")]),
    ).toBe("codex:a.md loaded\ncodex:z.md loaded");
  });
});
