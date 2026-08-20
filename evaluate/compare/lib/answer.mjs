import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { evidencePath, evidenceSpan } from "../../core/evidence.mjs";

export const MIN_SUBSTANTIVE_ANSWER_LENGTH = 40;

export const ANSWER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    answer: {
      type: "string",
      minLength: MIN_SUBSTANTIVE_ANSWER_LENGTH,
      description: `Required. A substantive, source-grounded explanatory answer of at least ${MIN_SUBSTANTIVE_ANSWER_LENGTH} characters; never a placeholder.`,
    },
    symbols: {
      type: "array",
      minItems: 1,
      description: "Required and non-empty. Exact source declaration names as written in the repository; never graph node IDs.",
      items: { type: "string", minLength: 1 },
    },
    evidence: {
      type: "array",
      minItems: 1,
      description: "Required and non-empty. Repository-relative source citations that support the answer.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: { path: { type: "string", minLength: 1 }, line: { type: "integer", minimum: 1 } },
        required: ["path", "line"],
      },
    },
    complete: {
      type: "boolean",
      description: "Required. True only when the substantive answer covers the question.",
    },
  },
  required: ["answer", "symbols", "evidence", "complete"],
};

export function parseStructuredAnswer(value) {
  let answer = value;
  if (typeof answer === "string") {
    const trimmed = answer.trim();
    try { answer = JSON.parse(trimmed); }
    catch {
      const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
      if (!fenced) return { ok: false, error: "assistant result is not JSON" };
      try { answer = JSON.parse(fenced[1]); }
      catch { return { ok: false, error: "assistant JSON fence is malformed" }; }
    }
  }
  if (!answer || typeof answer !== "object" || Array.isArray(answer)) return { ok: false, error: "answer must be an object" };
  const requiredKeys = ANSWER_SCHEMA.required;
  const keys = Object.keys(answer);
  const missingKeys = requiredKeys.filter((key) => !Object.hasOwn(answer, key));
  const extraKeys = keys.filter((key) => !requiredKeys.includes(key));
  if (missingKeys.length > 0) return { ok: false, error: `answer is missing required keys: ${missingKeys.join(", ")}` };
  if (extraKeys.length > 0) return { ok: false, error: `answer has unsupported keys: ${extraKeys.join(", ")}` };
  if (typeof answer.answer !== "string" || Array.from(answer.answer).length < MIN_SUBSTANTIVE_ANSWER_LENGTH) {
    return { ok: false, error: `answer must be a substantive string of at least ${MIN_SUBSTANTIVE_ANSWER_LENGTH} characters` };
  }
  if (!Array.isArray(answer.symbols) || answer.symbols.length === 0
    || answer.symbols.some((value) => typeof value !== "string" || value.length === 0)) {
    return { ok: false, error: "symbols must be a non-empty array of non-empty strings" };
  }
  if (!Array.isArray(answer.evidence) || answer.evidence.length === 0 || answer.evidence.some((evidence) => {
    if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) return true;
    const evidenceKeys = Object.keys(evidence);
    if (evidenceKeys.length !== 2 || !Object.hasOwn(evidence, "path") || !Object.hasOwn(evidence, "line")) return true;
    return typeof evidence.path !== "string" || evidence.path.length === 0
      || !Number.isInteger(evidence.line) || evidence.line < 1;
  })) {
    return { ok: false, error: "evidence must contain path and positive integer line" };
  }
  if (typeof answer.complete !== "boolean") return { ok: false, error: "complete must be boolean" };
  return { ok: true, value: answer };
}

export function gradeAnswer(answer, taskOrSymbols, subjectRoot = null) {
  const expected = Array.isArray(taskOrSymbols)
    ? taskOrSymbols
    : (taskOrSymbols.gold?.map((entry) => entry.symbol) ?? taskOrSymbols.expectedSymbols ?? []);
  const ranks = expected.map((symbol) => answer.symbols.indexOf(symbol));
  const matched = expected.filter((symbol) => answer.symbols.includes(symbol));
  const missing = expected.filter((symbol) => !answer.symbols.includes(symbol));
  const gold = Array.isArray(taskOrSymbols) ? [] : (taskOrSymbols.gold ?? []);
  const expectedPaths = gold.map(evidencePath);
  const citedPaths = new Set(answer.evidence.map(evidencePath));
  const missingEvidencePaths = expectedPaths.filter((path) => !citedPaths.has(path));
  const missingEvidenceSpans = gold.filter((entry) => {
    const span = evidenceSpan(entry);
    return span && !answer.evidence.some((citation) => evidencePath(citation) === evidencePath(entry)
      && citation.line >= span.startLine && citation.line <= span.endLine);
  }).map((entry) => ({ symbol: entry.symbol, path: evidencePath(entry), ...evidenceSpan(entry) }));
  const invalidEvidence = [];
  if (!Array.isArray(taskOrSymbols) && taskOrSymbols.gold?.length && subjectRoot) {
    const root = resolve(subjectRoot);
    for (const evidence of answer.evidence) {
      const path = resolve(root, evidence.path);
      const rel = relative(root, path);
      if (rel.startsWith("..") || isAbsolute(rel)) { invalidEvidence.push(`${evidence.path}:${evidence.line} escapes repository`); continue; }
      if (!existsSync(path)) { invalidEvidence.push(`${evidence.path}:${evidence.line} does not exist`); continue; }
      const lines = readFileSync(path, "utf8").split(/\r?\n/);
      if (evidence.line > lines.length) invalidEvidence.push(`${evidence.path}:${evidence.line} is past end of file`);
    }
  }
  return {
    correct: expected.length > 0 && missing.length === 0 && missingEvidencePaths.length === 0 && missingEvidenceSpans.length === 0 && invalidEvidence.length === 0 && answer.complete === true,
    matchedSymbols: matched,
    missingSymbols: missing,
    missingEvidencePaths,
    missingEvidenceSpans,
    invalidEvidence,
    answerSymbolRank: ranks.filter((rank) => rank >= 0).length ? Math.min(...ranks.filter((rank) => rank >= 0)) + 1 : null,
  };
}
