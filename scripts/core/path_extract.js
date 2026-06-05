"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.extractToolPaths = extractToolPaths;
const PATH_FIELD_NAMES = new Set([
    "path",
    "filePath",
    "filepath",
    "file_path",
    "file",
]);
const PATH_ARRAY_FIELD_NAMES = new Set(["paths", "files"]);
const NESTED_INPUT_FIELD_NAMES = new Set(["arguments", "params", "input"]);
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function normalizePathValue(value) {
    if (typeof value !== "string") {
        return null;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}
function addPath(paths, seen, value) {
    const normalized = normalizePathValue(value);
    if (normalized === null || seen.has(normalized)) {
        return;
    }
    seen.add(normalized);
    paths.push(normalized);
}
function looksLikeReadWriteEditTool(toolName) {
    const normalized = toolName.toLowerCase();
    if (normalized === "bash" || normalized.includes("bash")) {
        return false;
    }
    return (normalized === "read" ||
        normalized === "write" ||
        normalized === "edit" ||
        normalized === "multiedit" ||
        normalized.includes("read") ||
        normalized.includes("write") ||
        normalized.includes("edit"));
}
function extractKnownPathFields(value, paths, seen, depth = 0) {
    if (!isRecord(value) || depth > 4) {
        return;
    }
    for (const [key, entry] of Object.entries(value)) {
        if (PATH_FIELD_NAMES.has(key)) {
            addPath(paths, seen, entry);
            continue;
        }
        if (PATH_ARRAY_FIELD_NAMES.has(key) && Array.isArray(entry)) {
            for (const item of entry) {
                if (typeof item === "string") {
                    addPath(paths, seen, item);
                }
                else {
                    extractKnownPathFields(item, paths, seen, depth + 1);
                }
            }
            continue;
        }
        if (NESTED_INPUT_FIELD_NAMES.has(key)) {
            extractKnownPathFields(entry, paths, seen, depth + 1);
        }
    }
}
function extractPatchText(toolInput) {
    if (!isRecord(toolInput)) {
        return null;
    }
    const value = toolInput.command;
    if (typeof value === "string" && value.includes("*** Begin Patch")) {
        return value;
    }
    return null;
}
function extractApplyPatchPaths(toolInput) {
    const patchText = extractPatchText(toolInput);
    if (patchText === null) {
        return [];
    }
    const paths = [];
    const seen = new Set();
    const headerPattern = /^\*\*\* (?:Add File|Update File|Delete File|Move to):\s+(.+)$/gm;
    let match;
    while ((match = headerPattern.exec(patchText)) !== null) {
        addPath(paths, seen, match[1]);
    }
    return paths;
}
function extractToolPaths(options) {
    if (options.toolName.toLowerCase() === "apply_patch") {
        return extractApplyPatchPaths(options.toolInput);
    }
    if (!looksLikeReadWriteEditTool(options.toolName)) {
        return [];
    }
    const paths = [];
    const seen = new Set();
    extractKnownPathFields(options.toolInput, paths, seen);
    return paths;
}
