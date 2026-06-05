import { renderPathGuidance } from "../core/render";

import {
  contextResult,
  discoverForHook,
  extractPathsForHook,
  isReadTool,
  markLoadedIfPossible,
  matchingGuidanceForPaths,
  NO_OUTPUT,
  parseHookInput,
  runCli,
  type HookContext,
  type HookResult,
} from "./common";

export async function handlePostToolUse(
  rawInput: string,
  context: HookContext = {},
): Promise<HookResult> {
  const input = parseHookInput(rawInput);
  if (input === null || !isReadTool(input.toolName)) {
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
  return contextResult("PostToolUse", renderPathGuidance(loaded), loaded);
}

if (require.main === module) {
  void runCli(handlePostToolUse);
}
