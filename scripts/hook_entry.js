"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
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
exports.ensureUserTurnForPrompt = ensureUserTurnForPrompt;
exports.ensureCompactForHook = ensureCompactForHook;
exports.markStopTurnIfPossible = markStopTurnIfPossible;
exports.matchingGuidanceForPaths = matchingGuidanceForPaths;
exports.extractPathsForHook = extractPathsForHook;
exports.handleSessionStart = handleSessionStart;
exports.handleUserPromptSubmit = handleUserPromptSubmit;
exports.handlePostToolUse = handlePostToolUse;
exports.handlePreToolUse = handlePreToolUse;
exports.handlePostCompact = handlePostCompact;
exports.handlePreCompact = handlePreCompact;
exports.handleStop = handleStop;
const node_fs_1 = require("node:fs");
const node_path_1 = __importDefault(require("node:path"));
const discover_1 = require("./core/discover");
const match_1 = require("./core/match");
const path_extract_1 = require("./core/path_extract");
const render_1 = require("./core/render");
const state_1 = require("./core/state");
const transcript_1 = require("./core/transcript");
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
    const turnId = readString(payload.turn_id) ?? readString(payload.turnId);
    const transcriptPath = readString(payload.transcript_path) ?? readString(payload.transcriptPath);
    const toolName = readString(payload.tool_name) ?? readString(payload.toolName);
    const toolInput = payload.tool_input ?? payload.toolInput;
    return {
        ...(cwd === undefined ? {} : { cwd }),
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(turnId === undefined ? {} : { turnId }),
        ...(transcriptPath === undefined ? {} : { transcriptPath }),
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
    const stateMarkOptions = stateUpdateOptions(input, context);
    if (stateMarkOptions === null) {
        return [];
    }
    let turnId;
    let unloaded;
    try {
        turnId = await currentTurnId(input, context);
        if (turnId === null) {
            return [];
        }
        unloaded = await (0, state_1.selectUnloadedGuidanceForTurn)({
            ...stateMarkOptions,
            turnId,
            documents,
        });
    }
    catch {
        return [];
    }
    if (unloaded.length === 0) {
        return [];
    }
    const result = await (0, state_1.markGuidanceLoadedOnTurn)({
        ...stateMarkOptions,
        turnId,
        guidanceIds: unloaded.map((document) => document.id),
    });
    return result.ok ? unloaded : [];
}
async function ensureUserTurnForPrompt(input, context) {
    const options = stateUpdateOptions(input, context);
    if (options === null || input.turnId === undefined) {
        return null;
    }
    const resolved = (0, transcript_1.resolveTurnFromTranscript)({
        transcriptPath: transcriptPathForInput(input, context),
        turnId: input.turnId,
    });
    const result = await (0, state_1.ensureTurnNode)({
        ...options,
        turnId: resolved.turnId,
        parentTurnId: resolved.parentTurnId,
    });
    if (!result.ok) {
        throw new Error(`Failed to record user turn: ${result.reason}`);
    }
    return options;
}
async function ensureCompactForHook(input, context, complete) {
    const options = stateUpdateOptions(input, context);
    if (options === null || input.turnId === undefined) {
        return;
    }
    const parentTurnId = await (0, state_1.resolveCurrentTurnId)(options);
    if (parentTurnId === null) {
        throw new Error("Cannot record compact turn without an active parent turn");
    }
    const result = await (0, state_1.ensureCompactTurnNode)({
        ...options,
        turnId: input.turnId,
        parentTurnId,
        complete,
        advanceCursor: complete,
    });
    if (!result.ok) {
        throw new Error(`Failed to record compact turn: ${result.reason}`);
    }
}
async function markStopTurnIfPossible(input, context) {
    const options = stateUpdateOptions(input, context);
    if (options === null) {
        return;
    }
    const turnId = await currentTurnId(input, context);
    if (turnId === null) {
        return;
    }
    const result = await (0, state_1.markTurnCompleted)({
        ...options,
        turnId,
    });
    if (!result.ok) {
        throw new Error(`Failed to complete turn: ${result.reason}`);
    }
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
async function handleUserPromptSubmit(rawInput, context = {}) {
    const input = parseHookInput(rawInput);
    if (input === null) {
        return exports.NO_OUTPUT;
    }
    await ensureUserTurnForPrompt(input, context);
    return exports.NO_OUTPUT;
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
    await ensureCompactForHook(input, context, true);
    return exports.NO_OUTPUT;
}
async function handlePreCompact(rawInput, context = {}) {
    const input = parseHookInput(rawInput);
    if (input === null) {
        return exports.NO_OUTPUT;
    }
    await ensureCompactForHook(input, context, false);
    return exports.NO_OUTPUT;
}
async function handleStop(rawInput, context = {}) {
    const input = parseHookInput(rawInput);
    if (input === null) {
        return exports.NO_OUTPUT;
    }
    await markStopTurnIfPossible(input, context);
    return exports.NO_OUTPUT;
}
const HOOK_HANDLERS = {
    session_start: handleSessionStart,
    user_prompt_submit: handleUserPromptSubmit,
    post_tool_use: handlePostToolUse,
    pre_tool_use: handlePreToolUse,
    pre_compact: handlePreCompact,
    post_compact: handlePostCompact,
    stop: handleStop,
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
async function currentTurnId(input, context) {
    if (input.turnId !== undefined) {
        return input.turnId;
    }
    const options = stateOptions(input, context);
    if (options === null) {
        return null;
    }
    return (0, state_1.resolveCurrentTurnId)(options);
}
function transcriptPathForInput(input, context) {
    if (input.transcriptPath !== undefined) {
        return input.transcriptPath;
    }
    if (input.sessionId === undefined) {
        throw new Error("transcript_path is required when session_id is missing");
    }
    const homeDir = context.env?.HOME;
    if (homeDir === undefined || homeDir.trim().length === 0) {
        throw new Error("transcript_path is required when HOME is unavailable");
    }
    const sessionRoot = node_path_1.default.join(homeDir, ".codex", "sessions");
    const matches = findFilesContainingName(sessionRoot, input.sessionId);
    if (matches.length !== 1) {
        throw new Error(`Unable to resolve transcript_path for session ${input.sessionId}: found ${matches.length} matches`);
    }
    return matches[0];
}
function findFilesContainingName(root, needle) {
    const matches = [];
    const stack = [root];
    while (stack.length > 0) {
        const entry = stack.pop();
        if (entry === undefined) {
            continue;
        }
        let stat;
        try {
            stat = (0, node_fs_1.statSync)(entry);
        }
        catch {
            continue;
        }
        if (stat.isDirectory()) {
            for (const child of (0, node_fs_1.readdirSync)(entry)) {
                stack.push(node_path_1.default.join(entry, child));
            }
            continue;
        }
        if (stat.isFile() && node_path_1.default.basename(entry).includes(needle)) {
            matches.push(entry);
        }
    }
    return matches;
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
