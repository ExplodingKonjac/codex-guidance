"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NO_OUTPUT = void 0;
exports.parseHookInput = parseHookInput;
exports.isReadTool = isReadTool;
exports.isEditTool = isEditTool;
exports.hookJson = hookJson;
exports.contextResult = contextResult;
exports.runCli = runCli;
exports.discoverForHook = discoverForHook;
exports.repoRoot = repoRoot;
exports.stateOptions = stateOptions;
exports.stateUpdateOptions = stateUpdateOptions;
exports.markLoadedIfPossible = markLoadedIfPossible;
exports.compactIfPossible = compactIfPossible;
exports.matchingGuidanceForPaths = matchingGuidanceForPaths;
exports.extractPathsForHook = extractPathsForHook;
exports.handleSessionStart = handleSessionStart;
exports.handlePostToolUse = handlePostToolUse;
exports.handlePreToolUse = handlePreToolUse;
exports.handlePostCompact = handlePostCompact;
const node_fs_1 = require("node:fs");
const discover_1 = require("./core/discover");
const match_1 = require("./core/match");
const path_extract_1 = require("./core/path_extract");
const render_1 = require("./core/render");
const state_1 = require("./core/state");
exports.NO_OUTPUT = {
    exitCode: 0,
    stdout: "",
    stderr: "",
};
const RETRY_REASON = "Codex Guidance loaded matching guidance. Retry the edit after applying the loaded guidance.";
function parseHookInput(rawInput) {
    let parsed;
    try {
        parsed = JSON.parse(rawInput);
    }
    catch {
        return null;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return null;
    }
    const payload = parsed;
    const cwd = readString(payload.cwd);
    const sessionId = readString(payload.session_id) ?? readString(payload.sessionId);
    const toolName = readString(payload.tool_name) ?? readString(payload.toolName);
    const toolInput = payload.tool_input ?? payload.toolInput;
    return {
        ...(cwd === undefined ? {} : { cwd }),
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(toolName === undefined ? {} : { toolName }),
        ...(toolInput === undefined ? {} : { toolInput }),
    };
}
function isReadTool(toolName) {
    if (toolName === undefined) {
        return false;
    }
    const normalized = toolName.toLowerCase();
    if (normalized === "bash" || normalized.includes("bash")) {
        return false;
    }
    return normalized === "read" || normalized.includes("read");
}
function isEditTool(toolName) {
    if (toolName === undefined) {
        return false;
    }
    const normalized = toolName.toLowerCase();
    return (normalized === "write" ||
        normalized === "edit" ||
        normalized === "multiedit" ||
        normalized === "apply_patch" ||
        normalized.includes("write") ||
        normalized.includes("edit"));
}
function hookJson(hookEventName, payload) {
    return JSON.stringify({
        hookSpecificOutput: {
            hookEventName,
            ...payload,
        },
    });
}
function contextResult(hookEventName, additionalContext, documents, extra = {}) {
    if (additionalContext.length === 0) {
        return exports.NO_OUTPUT;
    }
    const status = (0, render_1.renderLoadedStatus)(documents);
    return {
        exitCode: 0,
        stdout: hookJson(hookEventName, {
            additionalContext,
            ...extra,
        }),
        stderr: status.length > 0 ? `${status}\n` : "",
    };
}
async function runCli(handler) {
    try {
        const rawInput = (0, node_fs_1.readFileSync)(0, "utf8");
        const result = await handler(rawInput, {
            env: process.env,
            cwd: process.cwd(),
        });
        if (result.stdout.length > 0) {
            process.stdout.write(result.stdout);
        }
        if (result.stderr.length > 0) {
            process.stderr.write(result.stderr);
        }
        process.exitCode = result.exitCode;
    }
    catch (error) {
        process.stderr.write(error instanceof Error ? `${error.message}\n` : `${String(error)}\n`);
        process.exitCode = 1;
    }
}
async function discoverForHook(input, context = {}) {
    const homeDir = context.env?.HOME;
    const pluginDataDir = context.env?.PLUGIN_DATA;
    return (await (0, discover_1.discoverGuidance)({
        repoRoot: repoRoot(input, context),
        ...(homeDir === undefined || homeDir.trim().length === 0
            ? {}
            : { homeDir }),
        ...(pluginDataDir === undefined || pluginDataDir.trim().length === 0
            ? {}
            : { pluginDataDir }),
    })).documents;
}
function repoRoot(input, context = {}) {
    return input.cwd ?? context.cwd ?? process.cwd();
}
function stateOptions(input, context = {}) {
    if (input.sessionId === undefined) {
        return null;
    }
    const pluginDataDir = context.env?.PLUGIN_DATA;
    return pluginDataDir === undefined || pluginDataDir.trim().length === 0
        ? { sessionId: input.sessionId }
        : { sessionId: input.sessionId, pluginDataDir };
}
function stateUpdateOptions(input, context = {}) {
    const baseOptions = stateOptions(input, context);
    if (baseOptions === null) {
        return null;
    }
    const lockTimeoutMs = readPositiveInteger(context.env?.CODEX_GUIDANCE_LOCK_TIMEOUT_MS);
    const lockRetryMs = readPositiveInteger(context.env?.CODEX_GUIDANCE_LOCK_RETRY_MS);
    return {
        ...baseOptions,
        ...(lockTimeoutMs === undefined ? {} : { lockTimeoutMs }),
        ...(lockRetryMs === undefined ? {} : { lockRetryMs }),
    };
}
async function markLoadedIfPossible(input, context, documents) {
    if (documents.length === 0) {
        return [];
    }
    const stateLoadOptions = stateOptions(input, context);
    const stateMarkOptions = stateUpdateOptions(input, context);
    if (stateLoadOptions === null || stateMarkOptions === null) {
        return [];
    }
    const unloaded = (0, state_1.selectUnloadedGuidance)({
        state: await (0, state_1.loadSessionState)(stateLoadOptions),
        documents,
    });
    if (unloaded.length === 0) {
        return [];
    }
    const result = await (0, state_1.markGuidanceLoaded)({
        ...stateMarkOptions,
        guidanceIds: unloaded.map((document) => document.id),
    });
    return result.ok ? unloaded : [];
}
async function compactIfPossible(input, context) {
    const options = stateUpdateOptions(input, context);
    if (options === null) {
        return;
    }
    await (0, state_1.compactSessionState)(options);
}
function matchingGuidanceForPaths(documents, paths, input, context) {
    const byId = new Map();
    for (const targetPath of paths) {
        for (const document of (0, match_1.findMatchingGuidance)({
            documents,
            repoRoot: repoRoot(input, context),
            targetPath,
        })) {
            byId.set(document.id, document);
        }
    }
    return [...byId.values()];
}
function extractPathsForHook(input) {
    if (input.toolName === undefined) {
        return [];
    }
    return (0, path_extract_1.extractToolPaths)({
        toolName: input.toolName,
        toolInput: input.toolInput,
    });
}
async function handleSessionStart(rawInput, context = {}) {
    const input = parseHookInput(rawInput);
    if (input === null) {
        return exports.NO_OUTPUT;
    }
    const globalGuidance = (await discoverForHook(input, context)).filter((document) => document.paths === null);
    const loaded = await markLoadedIfPossible(input, context, globalGuidance);
    return contextResult("SessionStart", (0, render_1.renderGlobalGuidance)(loaded), loaded);
}
async function handlePostToolUse(rawInput, context = {}) {
    const input = parseHookInput(rawInput);
    if (input === null || !isReadTool(input.toolName)) {
        return exports.NO_OUTPUT;
    }
    const paths = extractPathsForHook(input);
    if (paths.length === 0) {
        return exports.NO_OUTPUT;
    }
    const matchingGuidance = matchingGuidanceForPaths(await discoverForHook(input, context), paths, input, context);
    const loaded = await markLoadedIfPossible(input, context, matchingGuidance);
    return contextResult("PostToolUse", (0, render_1.renderPathGuidance)(loaded), loaded);
}
async function handlePreToolUse(rawInput, context = {}) {
    const input = parseHookInput(rawInput);
    if (input === null || !isEditTool(input.toolName)) {
        return exports.NO_OUTPUT;
    }
    const paths = extractPathsForHook(input);
    if (paths.length === 0) {
        return exports.NO_OUTPUT;
    }
    const matchingGuidance = matchingGuidanceForPaths(await discoverForHook(input, context), paths, input, context);
    const loaded = await markLoadedIfPossible(input, context, matchingGuidance);
    return contextResult("PreToolUse", (0, render_1.renderPathGuidance)(loaded), loaded, loaded.length === 0
        ? {}
        : {
            permissionDecision: "deny",
            permissionDecisionReason: RETRY_REASON,
        });
}
async function handlePostCompact(rawInput, context = {}) {
    const input = parseHookInput(rawInput);
    if (input === null) {
        return exports.NO_OUTPUT;
    }
    await compactIfPossible(input, context);
    return exports.NO_OUTPUT;
}
const HOOK_HANDLERS = {
    "session_start": handleSessionStart,
    "post_tool_use": handlePostToolUse,
    "pre_tool_use": handlePreToolUse,
    "post_compact": handlePostCompact,
};
function selectedHookHandler(argv) {
    const hookName = readHookName(argv);
    const handler = HOOK_HANDLERS[hookName];
    if (handler !== undefined) {
        return handler;
    }
    throw new Error(`Unknown or missing --hook value. Expected one of: ${Object.keys(HOOK_HANDLERS).join(", ")}`);
}
function readHookName(argv) {
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === undefined) {
            continue;
        }
        if (arg === "--hook") {
            return argv[index + 1] ?? "";
        }
        if (arg.startsWith("--hook=")) {
            return arg.slice("--hook=".length);
        }
    }
    return "";
}
function readString(value) {
    return typeof value === "string" && value.trim().length > 0
        ? value
        : undefined;
}
function readPositiveInteger(value) {
    if (typeof value !== "string") {
        return undefined;
    }
    const parsed = Number.parseInt(value, 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}
if (require.main === module) {
    void runCli(selectedHookHandler(process.argv.slice(2)));
}
