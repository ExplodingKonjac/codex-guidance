"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_MAX_GUIDANCE_BYTES = void 0;
exports.getGuidanceRoots = getGuidanceRoots;
exports.discoverGuidance = discoverGuidance;
const promises_1 = require("node:fs/promises");
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
const cache_1 = require("./cache");
const parse_1 = require("./parse");
exports.DEFAULT_MAX_GUIDANCE_BYTES = 256 * 1024;
function getGuidanceRoots(options) {
    const homeDir = options.homeDir ?? node_os_1.default.homedir();
    return [
        { source: "user", root: node_path_1.default.join(homeDir, ".codex", "guidance") },
        {
            source: "codex",
            root: node_path_1.default.join(options.repoRoot, ".codex", "guidance"),
        },
        {
            source: "agents",
            root: node_path_1.default.join(options.repoRoot, ".agents", "guidance"),
        },
        { source: "claude", root: node_path_1.default.join(options.repoRoot, ".claude", "rules") },
    ];
}
function isMarkdownFile(filePath) {
    const extension = node_path_1.default.extname(filePath).toLowerCase();
    return extension === ".md" || extension === ".markdown";
}
async function listMarkdownFiles(root) {
    return listMarkdownFilesRecursive(root, root);
}
async function listMarkdownFilesRecursive(root, currentDir) {
    let entries;
    try {
        entries = await (0, promises_1.readdir)(currentDir, { withFileTypes: true });
    }
    catch {
        return [];
    }
    const files = [];
    for (const entry of entries) {
        const entryPath = node_path_1.default.join(currentDir, entry.name);
        if (entry.isDirectory()) {
            files.push(...(await listMarkdownFilesRecursive(root, entryPath)));
        }
        else if (entry.isFile() && isMarkdownFile(entry.name)) {
            const relativePath = node_path_1.default
                .relative(node_path_1.default.resolve(root), node_path_1.default.resolve(entryPath))
                .split(node_path_1.default.sep)
                .join("/");
            files.push({
                filePath: entryPath,
                relativePath,
                ...(await fileMetadata(entryPath)),
            });
        }
    }
    return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}
async function fileMetadata(filePath) {
    try {
        const metadata = await (0, promises_1.stat)(filePath);
        return {
            size: metadata.size,
            mtimeMs: metadata.mtimeMs,
        };
    }
    catch {
        return {
            size: -1,
            mtimeMs: -1,
        };
    }
}
async function discoverGuidanceRoot(guidanceRoot, options) {
    const files = await listMarkdownFiles(guidanceRoot.root);
    const rootTimestamp = (0, cache_1.createGuidanceRootTimestamp)(files);
    if (options.pluginDataDir !== undefined &&
        options.pluginDataDir.trim().length > 0) {
        const cached = await (0, cache_1.readGuidanceRootCache)({
            pluginDataDir: options.pluginDataDir,
            source: guidanceRoot.source,
            root: guidanceRoot.root,
            rootTimestamp,
            maxBytes: options.maxBytes,
        });
        if (cached !== null) {
            return cached;
        }
    }
    const documents = [];
    const issues = [];
    for (const file of files) {
        const result = await (0, parse_1.parseGuidanceFile)({
            source: guidanceRoot.source,
            root: guidanceRoot.root,
            filePath: file.filePath,
            maxBytes: options.maxBytes,
        });
        if (result.document !== undefined) {
            documents.push(result.document);
        }
        if (result.issue !== undefined) {
            issues.push(result.issue);
        }
    }
    if (options.pluginDataDir !== undefined &&
        options.pluginDataDir.trim().length > 0) {
        await (0, cache_1.writeGuidanceRootCache)({
            pluginDataDir: options.pluginDataDir,
            source: guidanceRoot.source,
            root: guidanceRoot.root,
            rootTimestamp,
            maxBytes: options.maxBytes,
            documents,
            issues,
        });
    }
    return { documents, issues };
}
async function discoverGuidance(options) {
    const maxBytes = options.maxBytes ?? exports.DEFAULT_MAX_GUIDANCE_BYTES;
    const documents = [];
    const issues = [];
    for (const guidanceRoot of getGuidanceRoots(options)) {
        const result = await discoverGuidanceRoot(guidanceRoot, {
            maxBytes,
            ...(options.pluginDataDir === undefined
                ? {}
                : { pluginDataDir: options.pluginDataDir }),
        });
        documents.push(...result.documents);
        issues.push(...result.issues);
    }
    return { documents, issues };
}
