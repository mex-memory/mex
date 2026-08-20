import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { repositoryIdentity } from "../../core/hash.mjs";

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function symbolPattern(symbol) {
  const name = escapeRegExp(symbol);
  return new RegExp(`(^|[^A-Za-z0-9_$#])${name}(?![A-Za-z0-9_$#])`);
}

function declarationPattern(symbol) {
  const name = escapeRegExp(symbol);
  return new RegExp(
    `(?:\\b(?:function|class|interface|type|enum|const|let|var|def|fn|func|struct|trait|module|sub|proc)\\s+${name}(?![A-Za-z0-9_$#]))`
      + `|(?:^\\s*(?:pub(?:\\([^)]*\\))?\\s+)?(?:async\\s+)?${name}\\s*(?:<[^>]*>)?\\s*(?:\\(|[:=]))`,
  );
}

function insideRoot(root, path) {
  const rel = relative(root, path);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !resolve(path).startsWith(`${resolve(root)}${sep}..${sep}`);
}

export function validateEvidenceInSource(root, evidence, label = "evidence") {
  const absoluteRoot = resolve(root);
  const absolute = resolve(absoluteRoot, evidence.path);
  if (!insideRoot(absoluteRoot, absolute)) throw new Error(`${label}.path escapes the subject repository: ${evidence.path}`);
  if (!existsSync(absolute)) throw new Error(`${label}.path does not exist: ${evidence.path}`);
  const lines = readFileSync(absolute, "utf8").split(/\r?\n/);
  const exactSymbol = symbolPattern(evidence.symbol);
  const explicitStart = evidence.startLine ?? evidence.line;
  const explicitEnd = evidence.endLine ?? explicitStart;
  if (explicitStart !== undefined) {
    if (!Number.isInteger(explicitStart) || explicitStart < 1 || !Number.isInteger(explicitEnd) || explicitEnd < explicitStart || explicitEnd > lines.length) {
      throw new Error(`${label} has an invalid source span ${evidence.path}:${explicitStart}-${explicitEnd}`);
    }
    const spanText = lines.slice(explicitStart - 1, explicitEnd).join("\n");
    if (!exactSymbol.test(spanText)) {
      throw new Error(`${label} symbol ${evidence.symbol} was not found in source span ${evidence.path}:${explicitStart}-${explicitEnd}`);
    }
    return {
      ...evidence,
      line: explicitStart,
      startLine: explicitStart,
      endLine: explicitEnd,
      sourceSpanSha256: createHash("sha256").update(spanText).digest("hex"),
      sourceValidated: true,
    };
  }
  const declaration = declarationPattern(evidence.symbol);
  let matches = [];
  lines.forEach((line, index) => { if (declaration.test(line)) matches.push(index + 1); });
  if (matches.length === 0) lines.forEach((line, index) => { if (exactSymbol.test(line)) matches.push(index + 1); });
  if (matches.length === 0) throw new Error(`${label} symbol ${evidence.symbol} was not found in ${evidence.path}`);
  if (matches.length > 1) {
    throw new Error(`${label} symbol ${evidence.symbol} is ambiguous in ${evidence.path}; add a source span (${matches.join(", ")})`);
  }
  const line = matches[0];
  return {
    ...evidence,
    line,
    startLine: line,
    endLine: line,
    sourceSpanSha256: createHash("sha256").update(lines[line - 1]).digest("hex"),
    sourceValidated: true,
  };
}

export function validateSubjectFixture(suite, subjectRoot) {
  const subject = repositoryIdentity(subjectRoot);
  if (suite.subject.revision && subject.sha !== suite.subject.revision) {
    throw new Error(`subject revision mismatch: expected ${suite.subject.revision}, found ${subject.sha ?? "non-git subject"}`);
  }
  if (suite.subject.requireClean && subject.dirty !== false) {
    throw new Error(`subject must be a clean checkout: ${subject.dirtyEntries.join(", ") || "not a git checkout"}`);
  }
  const tasks = suite.tasks.map((task, taskIndex) => ({
    taskId: task.id,
    gold: (task.gold ?? []).map((evidence, index) => validateEvidenceInSource(subjectRoot, evidence, `tasks[${taskIndex}].gold[${index}]`)),
    acceptableAlternates: (task.acceptableAlternates ?? []).map((evidence, index) => validateEvidenceInSource(subjectRoot, evidence, `tasks[${taskIndex}].acceptableAlternates[${index}]`)),
    mustNotReturn: (task.mustNotReturn ?? []).map((evidence, index) => validateEvidenceInSource(subjectRoot, evidence, `tasks[${taskIndex}].mustNotReturn[${index}]`)),
  }));
  return { subject, tasks };
}
