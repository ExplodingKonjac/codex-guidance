export type GuidanceSource = "user" | "codex" | "agents" | "claude";

export interface GuidanceRoot {
  readonly source: GuidanceSource;
  readonly root: string;
}

export interface GuidanceDocument {
  readonly id: string;
  readonly source: GuidanceSource;
  readonly root: string;
  readonly filePath: string;
  readonly relativePath: string;
  readonly paths: readonly string[] | null;
  readonly content: string;
}

export type GuidanceIssueReason =
  | "invalid-front-matter"
  | "invalid-paths-field"
  | "outside-root"
  | "oversized"
  | "read-error"
  | "unsupported-front-matter-field";

export interface GuidanceIssue {
  readonly filePath: string;
  readonly source: GuidanceSource;
  readonly reason: GuidanceIssueReason;
  readonly message: string;
}

export interface GuidanceParseResult {
  readonly document?: GuidanceDocument;
  readonly issue?: GuidanceIssue;
}
