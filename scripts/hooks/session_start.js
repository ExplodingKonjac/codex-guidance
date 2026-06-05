"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleSessionStart = handleSessionStart;
const render_1 = require("../core/render");
const common_1 = require("./common");
async function handleSessionStart(rawInput, context = {}) {
    const input = (0, common_1.parseHookInput)(rawInput);
    if (input === null) {
        return common_1.NO_OUTPUT;
    }
    const globalGuidance = (await (0, common_1.discoverForHook)(input, context)).filter((document) => document.paths === null);
    const loaded = await (0, common_1.markLoadedIfPossible)(input, context, globalGuidance);
    return (0, common_1.contextResult)("SessionStart", (0, render_1.renderGlobalGuidance)(loaded), loaded);
}
if (require.main === module) {
    void (0, common_1.runCli)(handleSessionStart);
}
