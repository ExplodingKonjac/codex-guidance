"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.GUIDANCE_CACHE_VERSION = void 0;
exports.createGuidanceRootTimestamp = createGuidanceRootTimestamp;
exports.readGuidanceRootCache = readGuidanceRootCache;
exports.writeGuidanceRootCache = writeGuidanceRootCache;
const node_crypto_1 = require("node:crypto");
const node_path_1 = __importDefault(require("node:path"));
const sqlite_1 = require("./sqlite");
exports.GUIDANCE_CACHE_VERSION = sqlite_1.GUIDANCE_DATABASE_SCHEMA_VERSION;
const ISSUE_REASONS = new Set([
    "invalid-front-matter",
    "invalid-paths-field",
    "outside-root",
    "oversized",
    "read-error",
    "unsupported-front-matter-field",
]);
function createGuidanceRootTimestamp(files) {
    return stableHash(JSON.stringify(files.map((file) => ({
        relativePath: file.relativePath,
        size: file.size,
        mtimeMs: file.mtimeMs,
    }))));
}
async function readGuidanceRootCache(options) {
    return withDatabase(options, (database) => {
        const row = database
            .prepare(`
          SELECT source, root, root_timestamp, max_bytes, documents_json, issues_json
          FROM guidance_root_cache
          WHERE source = ? AND root = ?
        `)
            .get(options.source, node_path_1.default.resolve(options.root));
        if (row === undefined) {
            return null;
        }
        return normalizeCacheRow({
            source: row.source,
            root: row.root,
            rootTimestamp: row.root_timestamp,
            maxBytes: row.max_bytes,
            documents: parseJsonArray(row.documents_json),
            issues: parseJsonArray(row.issues_json),
        }, options);
    });
}
async function writeGuidanceRootCache(options) {
    void withDatabase(options, (database) => {
        database
            .prepare(`
          INSERT INTO guidance_root_cache (
            source,
            root,
            root_timestamp,
            max_bytes,
            documents_json,
            issues_json
          )
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(source, root) DO UPDATE SET
            root_timestamp = excluded.root_timestamp,
            max_bytes = excluded.max_bytes,
            documents_json = excluded.documents_json,
            issues_json = excluded.issues_json
        `)
            .run(options.source, node_path_1.default.resolve(options.root), options.rootTimestamp, options.maxBytes, JSON.stringify(options.documents), JSON.stringify(options.issues));
        return null;
    });
}
function normalizeCacheRow(value, options) {
    if (value.source !== options.source ||
        value.root !== node_path_1.default.resolve(options.root) ||
        value.rootTimestamp !== options.rootTimestamp ||
        value.maxBytes !== options.maxBytes ||
        !Array.isArray(value.documents) ||
        !Array.isArray(value.issues)) {
        return null;
    }
    const documents = normalizeDocuments(value.documents, options.source);
    const issues = normalizeIssues(value.issues, options.source);
    if (documents === null || issues === null) {
        return null;
    }
    return { documents, issues };
}
function normalizeDocuments(values, source) {
    const documents = [];
    for (const value of values) {
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
            return null;
        }
        const payload = value;
        if (typeof payload.id !== "string" ||
            payload.source !== source ||
            typeof payload.root !== "string" ||
            typeof payload.filePath !== "string" ||
            typeof payload.relativePath !== "string" ||
            typeof payload.content !== "string") {
            return null;
        }
        const paths = normalizePaths(payload.paths);
        if (paths === undefined) {
            return null;
        }
        documents.push({
            id: payload.id,
            source,
            root: payload.root,
            filePath: payload.filePath,
            relativePath: payload.relativePath,
            paths,
            content: payload.content,
        });
    }
    return documents;
}
function normalizeIssues(values, source) {
    const issues = [];
    for (const value of values) {
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
            return null;
        }
        const payload = value;
        if (typeof payload.filePath !== "string" ||
            payload.source !== source ||
            typeof payload.reason !== "string" ||
            !ISSUE_REASONS.has(payload.reason) ||
            typeof payload.message !== "string") {
            return null;
        }
        issues.push({
            filePath: payload.filePath,
            source,
            reason: payload.reason,
            message: payload.message,
        });
    }
    return issues;
}
function normalizePaths(value) {
    if (value === null) {
        return null;
    }
    if (Array.isArray(value) &&
        value.every((entry) => typeof entry === "string")) {
        return value;
    }
    return undefined;
}
function parseJsonArray(value) {
    if (typeof value !== "string") {
        return null;
    }
    try {
        return JSON.parse(value);
    }
    catch {
        return null;
    }
}
function withDatabase(options, callback) {
    let database;
    try {
        database = (0, sqlite_1.openGuidanceDatabase)(options);
    }
    catch {
        return null;
    }
    try {
        return callback(database);
    }
    catch {
        return null;
    }
    finally {
        database.close();
    }
}
function stableHash(value) {
    return (0, node_crypto_1.createHash)("sha256").update(value).digest("hex");
}
