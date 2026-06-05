"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handlePostToolUse = handlePostToolUse;
const render_1 = require("../core/render");
const common_1 = require("./common");
async function handlePostToolUse(rawInput, context = {}) {
    const input = (0, common_1.parseHookInput)(rawInput);
    if (input === null || !(0, common_1.isReadTool)(input.toolName)) {
        return common_1.NO_OUTPUT;
    }
    const paths = (0, common_1.extractPathsForHook)(input);
    if (paths.length === 0) {
        return common_1.NO_OUTPUT;
    }
    const matchingGuidance = (0, common_1.matchingGuidanceForPaths)(await (0, common_1.discoverForHook)(input, context), paths, input, context);
    const loaded = await (0, common_1.markLoadedIfPossible)(input, context, matchingGuidance);
    return (0, common_1.contextResult)("PostToolUse", (0, render_1.renderPathGuidance)(loaded), loaded);
}
if (require.main === module) {
    void (0, common_1.runCli)(handlePostToolUse);
}
