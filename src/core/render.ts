import type { GuidanceDocument } from "./types";

const GLOBAL_HEADER =
  "Below are global guidance for this session. You must follow them in later actions:";
const PATH_HEADER =
  "Below are guidance related to the current file. You must follow them in later actions:";

function sortedDocuments(
  documents: readonly GuidanceDocument[],
): readonly GuidanceDocument[] {
  return [...documents].sort((left, right) => left.id.localeCompare(right.id));
}

function renderGuidanceBlock(document: GuidanceDocument): string {
  return `<guidance id="${document.id}">\n${document.content}\n</guidance>`;
}

function renderGuidance(
  header: string,
  documents: readonly GuidanceDocument[],
): string {
  const sorted = sortedDocuments(documents);
  if (sorted.length === 0) {
    return "";
  }
  return `${header}\n\n${sorted.map(renderGuidanceBlock).join("\n\n")}`;
}

export function renderGlobalGuidance(
  documents: readonly GuidanceDocument[],
): string {
  return renderGuidance(GLOBAL_HEADER, documents);
}

export function renderPathGuidance(
  documents: readonly GuidanceDocument[],
): string {
  return renderGuidance(PATH_HEADER, documents);
}

export function renderLoadedStatus(
  documents: readonly GuidanceDocument[],
): string {
  return sortedDocuments(documents)
    .map((document) => `${document.id} loaded`)
    .join("\n");
}
