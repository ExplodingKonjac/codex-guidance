"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handlePostCompact = handlePostCompact;
const common_1 = require("./common");
async function handlePostCompact(rawInput, context = {}) {
    const input = (0, common_1.parseHookInput)(rawInput);
    if (input === null) {
        return common_1.NO_OUTPUT;
    }
    await (0, common_1.compactIfPossible)(input, context);
    return common_1.NO_OUTPUT;
}
if (require.main === module) {
    void (0, common_1.runCli)(handlePostCompact);
}
