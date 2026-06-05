import { renderPathGuidance } from "../core/render";

import {
  contextResult,
  discoverForHook,
  extractPathsForHook,
  isEditTool,
  markLoadedIfPossible,
  matchingGuidanceForPaths,
  NO_OUTPUT,
  parseHookInput,
  runCli,
  type HookContext,
  type HookResult,
} from "./common";

const RETRY_REASON =
  "Codex Guidance loaded matching guidance. Retry the edit after applying the loaded guidance.";

export async function handlePreToolUse(
  rawInput: string,
  context: HookContext = {},
): Promise<HookResult> {
  const input = parseHookInput(rawInput);
  if (input === null || !isEditTool(input.toolName)) {
    return NO_OUTPUT;
  }

  const paths = extractPathsForHook(input);
  if (paths.length === 0) {
    return NO_OUTPUT;
  }

  const matchingGuidance = matchingGuidanceForPaths(
    await discoverForHook(input, context),
    paths,
    input,
    context,
  );
  const loaded = await markLoadedIfPossible(input, context, matchingGuidance);
  return contextResult(
    "PreToolUse",
    renderPathGuidance(loaded),
    loaded,
    loaded.length === 0
      ? {}
      : {
          permissionDecision: "deny",
          permissionDecisionReason: RETRY_REASON,
        },
  );
}

if (require.main === module) {
  void runCli(handlePreToolUse);
}
