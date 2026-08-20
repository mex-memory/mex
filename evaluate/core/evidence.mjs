export function normalizeRepoPath(path) {
  return typeof path === "string" ? path.replace(/^\.\//, "").replaceAll("\\", "/") : null;
}

export function evidenceSpan(value) {
  const startLine = Number(value?.startLine ?? value?.lineStart ?? value?.line);
  const endLine = Number(value?.endLine ?? value?.lineEnd ?? value?.line);
  return Number.isInteger(startLine) && startLine > 0 && Number.isInteger(endLine) && endLine >= startLine
    ? { startLine, endLine }
    : null;
}

export function evidenceSymbol(value) {
  return typeof value?.name === "string" ? value.name : typeof value?.symbol === "string" ? value.symbol : null;
}

export function evidencePath(value) {
  return normalizeRepoPath(value?.filePath ?? value?.path ?? value?.file);
}

/** Node kind is intentionally advisory; source identity is path + symbol + span. */
export function evidenceMatchesRecord(evidence, record) {
  if (evidenceSymbol(evidence) !== evidenceSymbol(record) || evidencePath(evidence) !== evidencePath(record)) return false;
  const expected = evidenceSpan(evidence);
  const actual = evidenceSpan(record);
  if (!expected) return true;
  if (!actual) return false;
  return actual.startLine <= expected.endLine && actual.endLine >= expected.startLine;
}

export function evidenceIdentity(evidence) {
  const span = evidenceSpan(evidence);
  return `${evidencePath(evidence)}\0${evidenceSymbol(evidence)}\0${span?.startLine ?? ""}:${span?.endLine ?? ""}`;
}

export function uniqueRequiredPaths(gold) {
  return [...new Set((gold ?? []).map(evidencePath).filter(Boolean))];
}
