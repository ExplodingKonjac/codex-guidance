"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeTargetPath = normalizeTargetPath;
exports.guidanceMatchesPath = guidanceMatchesPath;
exports.findMatchingGuidance = findMatchingGuidance;
const node_path_1 = __importDefault(require("node:path"));
function toPosixPath(value) {
    return value.replaceAll("\\", "/");
}
function isRelativeTraversal(value) {
    return value === ".." || value.startsWith("../");
}
function normalizeTargetPath(targetPath, repoRoot) {
    const normalizedInput = toPosixPath(targetPath.trim());
    if (normalizedInput.length === 0) {
        return null;
    }
    if (node_path_1.default.isAbsolute(targetPath)) {
        const relativePath = node_path_1.default.relative(node_path_1.default.resolve(repoRoot), node_path_1.default.resolve(targetPath));
        const posixRelativePath = toPosixPath(relativePath);
        if (posixRelativePath.length === 0 ||
            isRelativeTraversal(posixRelativePath) ||
            node_path_1.default.isAbsolute(relativePath)) {
            return null;
        }
        return posixRelativePath;
    }
    const posixRelativePath = normalizedInput.replace(/^\.\/+/, "");
    if (posixRelativePath.length === 0 ||
        isRelativeTraversal(posixRelativePath) ||
        node_path_1.default.posix.isAbsolute(posixRelativePath)) {
        return null;
    }
    return posixRelativePath;
}
function guidanceMatchesPath(document, normalizedPath) {
    if (document.paths === null) {
        return false;
    }
    return document.paths.some((pattern) => pathMatchesGuidancePattern(normalizedPath, pattern));
}
function findMatchingGuidance(options) {
    const normalizedPath = normalizeTargetPath(options.targetPath, options.repoRoot);
    if (normalizedPath === null) {
        return [];
    }
    return options.documents.filter((document) => guidanceMatchesPath(document, normalizedPath));
}
function pathMatchesGuidancePattern(normalizedPath, pattern) {
    if (node_path_1.default.matchesGlob(normalizedPath, pattern)) {
        return true;
    }
    if (!normalizedPath.includes("/.") && !normalizedPath.startsWith(".")) {
        return false;
    }
    return globToDotRegex(pattern).test(normalizedPath);
}
function globToDotRegex(pattern) {
    let regex = "^";
    for (let index = 0; index < pattern.length; index += 1) {
        const current = pattern[index];
        if (current === undefined) {
            break;
        }
        if (current === "*") {
            const next = pattern[index + 1];
            const afterNext = pattern[index + 2];
            if (next === "*" && afterNext === "/") {
                regex += "(?:[^/]+/)*";
                index += 2;
                continue;
            }
            if (next === "*") {
                regex += ".*";
                index += 1;
                continue;
            }
            regex += "[^/]*";
            continue;
        }
        if (current === "?") {
            regex += "[^/]";
            continue;
        }
        if (current === "[") {
            const characterClassEnd = pattern.indexOf("]", index + 1);
            if (characterClassEnd !== -1) {
                const rawClass = pattern.slice(index + 1, characterClassEnd);
                if (rawClass.length > 0) {
                    const classPrefix = rawClass[0] === "!" ? "^" : rawClass[0] === "^" ? "\\^" : "";
                    const classBody = rawClass[0] === "!" || rawClass[0] === "^"
                        ? rawClass.slice(1)
                        : rawClass;
                    regex += `[${classPrefix}${escapeCharacterClass(classBody)}]`;
                    index = characterClassEnd;
                    continue;
                }
            }
        }
        regex += escapeRegexCharacter(current);
    }
    return new RegExp(`${regex}$`);
}
function escapeCharacterClass(value) {
    return value.replaceAll("\\", "\\\\").replaceAll("]", "\\]");
}
function escapeRegexCharacter(value) {
    return /[\\^$.*+?()[\]{}|]/.test(value) ? `\\${value}` : value;
}
