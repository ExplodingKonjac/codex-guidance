"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.renderGlobalGuidance = renderGlobalGuidance;
exports.renderPathGuidance = renderPathGuidance;
exports.renderLoadedStatus = renderLoadedStatus;
const GLOBAL_HEADER = "Below are global guidance for this session. You must follow them in later actions:";
const PATH_HEADER = "Below are guidance related to the current file. You must follow them in later actions:";
function sortedDocuments(documents) {
    return [...documents].sort((left, right) => left.id.localeCompare(right.id));
}
function renderGuidanceBlock(document) {
    return `<guidance id="${document.id}">\n${document.content}\n</guidance>`;
}
function renderGuidance(header, documents) {
    const sorted = sortedDocuments(documents);
    if (sorted.length === 0) {
        return "";
    }
    return `${header}\n\n${sorted.map(renderGuidanceBlock).join("\n\n")}`;
}
function renderGlobalGuidance(documents) {
    return renderGuidance(GLOBAL_HEADER, documents);
}
function renderPathGuidance(documents) {
    return renderGuidance(PATH_HEADER, documents);
}
function renderLoadedStatus(documents) {
    return sortedDocuments(documents)
        .map((document) => `${document.id} loaded`)
        .join("\n");
}
