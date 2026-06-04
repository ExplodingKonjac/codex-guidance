import {
  compactIfPossible,
  NO_OUTPUT,
  parseHookInput,
  runCli,
  type HookContext,
  type HookResult,
} from "./common";

export async function handlePostCompact(
  rawInput: string,
  context: HookContext = {},
): Promise<HookResult> {
  const input = parseHookInput(rawInput);
  if (input === null) {
    return NO_OUTPUT;
  }

  await compactIfPossible(input, context);
  return NO_OUTPUT;
}

void runCli;
