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
function renderGuidanceBlock(document, generation) {
    return `<guidance id="${document.id}" generation="${generation}">\n${document.content}\n</guidance>`;
}
function renderGuidance(header, documents, generation) {
    const sorted = sortedDocuments(documents);
    if (sorted.length === 0) {
        return "";
    }
    return `${header}\n\n${sorted
        .map((document) => renderGuidanceBlock(document, generation))
        .join("\n\n")}`;
}
function renderGlobalGuidance(documents, generation = 0) {
    return renderGuidance(GLOBAL_HEADER, documents, generation);
}
function renderPathGuidance(documents, generation = 0) {
    return renderGuidance(PATH_HEADER, documents, generation);
}
function renderLoadedStatus(documents) {
    return sortedDocuments(documents)
        .map((document) => `${document.id} loaded`)
        .join("\n");
}
