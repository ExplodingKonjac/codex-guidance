import { renderGlobalGuidance } from "../core/render";

import {
  contextResult,
  discoverForHook,
  markLoadedIfPossible,
  NO_OUTPUT,
  parseHookInput,
  runCli,
  type HookContext,
  type HookResult,
} from "./common";

export async function handleSessionStart(
  rawInput: string,
  context: HookContext = {},
): Promise<HookResult> {
  const input = parseHookInput(rawInput);
  if (input === null) {
    return NO_OUTPUT;
  }

  const globalGuidance = (await discoverForHook(input, context)).filter(
    (document) => document.paths === null,
  );
  const loaded = await markLoadedIfPossible(input, context, globalGuidance);
  return contextResult("SessionStart", renderGlobalGuidance(loaded), loaded);
}

if (require.main === module) {
  void runCli(handleSessionStart);
}
