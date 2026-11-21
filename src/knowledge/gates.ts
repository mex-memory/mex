import { KnowledgeError, validateEntry, type KnowledgeEntry } from "./entry.js";
import { commandExists, ENV_ASSIGNMENTS, withoutEnvironment, type References } from "./references.js";

export function stripHidden(text: string): string {
  return text.replace(/[\p{Cf}\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/gu, "");
}
const SECRETS = [
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/u,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{16,})\b/u,
  /\b(?:glpat|gldt|glrt|glsoat|glagent|glft)-[A-Za-z0-9_-]{12,}\b/u,
  // A name may carry a prefix (DB_PASSWORD, STRIPE_API_KEY); a bare token or
  // secret counts only as such a suffix (GITHUB_TOKEN), not as a plain word.
  /\b(?:[A-Za-z0-9]+_)*(?:api[_ -]?key|secret[_ -]?key|private[_ -]?key|access[_ -]?token|auth[_ -]?token|refresh[_ -]?token|client[_ -]?secret|password|passwd|pgpassword|authorization)["']?\s*[:=]\s*["']?(?:Bearer\s+)?[A-Za-z0-9_+\/.=-]{8,}/iu,
  /\b(?:[A-Za-z0-9]+_)+(?:token|secret|pwd)["']?\s*[:=]\s*["']?[A-Za-z0-9_+\/.=-]{8,}/iu,
  // A password in a URL of any scheme: https, postgres, redis, amqp.
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]*:[^\s/@]+@/iu,
];
export function hasSecret(text: string): boolean { return SECRETS.some(pattern => pattern.test(text)); }
const secretKey = /^(?:api[_ -]?key|access[_ -]?token|client[_ -]?secret|password|authorization|private[_ -]?key|aws_secret_access_key)$/iu;
export function assertNoSecrets(value: unknown): void {
  const visit = (value: unknown, key = ""): boolean => typeof value === "string"
    ? hasSecret(value) || (secretKey.test(key) && value.length >= 8 && !/^\*+$|^\[REDACTED\]$/u.test(value))
    : Array.isArray(value) ? value.some(item => visit(item))
      : !!value && typeof value === "object" && Object.entries(value).some(([key, item]) => visit(item, key));
  if (visit(value)) throw new KnowledgeError("SECRET_FOUND", "The entry contains a possible secret and was withheld.");
}

const commandStart = /\b(?:npm|pnpm|yarn|npx|bun|node|python3?|pip3?|git|go|cargo|make|cmake|curl|wget|bash|sh|sudo|rm|chmod|powershell|pwsh|cmd)\s+/u;
/** Command substitution, or piping into an interpreter: always something to run. */
const runsSomething = /\$\(|`|\|\s*(?:sh|bash|zsh|dash|pwsh|powershell|iex|cmd|python3?|node|perl|ruby)\b/iu;
/**
 * Syntax a shell line does not contain but source code does: calls and
 * literals, arrows, strict or relational comparisons, optional chaining,
 * nullish coalescing, assignment, negation, `instanceof` and object keys.
 * For example `new Hono()`, `a && !b`, `x >= 0`, `strict: true`, `count = 5`.
 */
const codeOnly = /[(){}[\]]|=>|[=!]==?|[<>]=|\?\.|\?\?|\binstanceof\b|\s=\s|^!|\s!\w|^[\w$'"]+\??:\s/u;
/** A program name or a path to one: `make`, `deltree`, `Remove-Item`, `tools\run.exe`, `/usr/bin/env`. */
const program = /^(?:[A-Za-z][\w+-]*(?:\.(?:exe|cmd|bat|com|ps1|sh|py))?|[\w.~-]*[\\/][\w.\\/-]+)$/u;
/** An argument that targets a flag, path, file or drive. */
const target = /^(?:--?\w|[\\/~]|[A-Za-z]:)|[\\/.]\w/u;
/**
 * An inline code span that could be pasted into a shell. Every one of these
 * must match a repository-owned command or it is removed. Source code and
 * prose pass through: a shell never runs `a && !b` or "Could not connect".
 */
export function looksLikeCommand(code: string): boolean {
  const text = withoutEnvironment(code.trim());
  if (commandStart.test(text) || /^(?:\.\/|\.\.\/)/u.test(text) || runsSomething.test(text)) return true;
  // Each part of a chain is judged alone: `check(x); deltree c:` still runs deltree.
  return text.split(/\s*(?:;|&&|\|\||\|)\s*/u).some(part => runnable(part));
}
function runnable(part: string): boolean {
  if (/^(?:\.\/|\.\.\/)/u.test(part)) return true;
  // `${NAME}` is a placeholder word in both a shell and a template string.
  const text = part.replace(/\$\{[^{}]*\}/gu, "X");
  if (!/\s/u.test(text) || codeOnly.test(text)) return false;
  const [first, ...rest] = text.split(/\s+/u);
  // camelCase or dotted names are identifiers; a program name is not.
  if (!program.test(first) || /^[a-z]+[A-Z]/u.test(first)) return false;
  const targets = rest.some(arg => target.test(arg));
  // A sentence: capitalised without targets, or three or more plain words.
  if (!targets && /^[A-Z]/u.test(first) && !first.includes("-")) return false;
  if (!targets && rest.length >= 2 && rest.every(word => /^[a-z]+[.,]?$/u.test(word))) return false;
  return true;
}
export function sanitizeText(value: string, source: References): string {
  let text = stripHidden(value);
  // Check links before shielding code spans: backticks are not a trust boundary.
  text = text.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/gu,
    (all, label: string, url: string) => source.links.has(url) ? all : `${label} [unverified link removed]`);
  text = text.replace(/https?:\/\/[^\s<>"'`]+/gu, value => {
    const url = value.replace(/[.,;)\]]+$/u, "");
    return source.links.has(url) ? value : "[unverified link removed]";
  });
  const codes: string[] = [];
  const save = (value: string): string => { codes.push(value); return `\0${codes.length - 1}\0`; };
  text = text.replace(/```[^\n]*\n([\s\S]*?)```/gu, (_all, body: string) => save(body.split(/\r?\n/u).map(line => {
    const command = line.trim().replace(/^\$\s+/u, "");
    return !command || commandExists(command, source) ? line : "[unverified command removed]";
  }).join("\n")));
  text = text.replace(/`([^`\n]+)`/gu, (_all, code: string) => save(looksLikeCommand(code) && !commandExists(code, source) ? "[unverified command removed]" : `\`${code}\``));
  // Bare shell commands are checked as a whole, including chained suffixes.
  // A command ends where the sentence goes on in plain words ("before
  // pushing", "when CI fails"); whatever follows is checked again, so a
  // command after such a word is never let through unchecked.
  const words = "because|for which|so that|before|after|when|whenever|while|if|unless|until|then|otherwise|instead|since|once";
  const programs = "npm|pnpm|yarn|npx|bun|node|python3?|pip3?|git|go|cargo|make|cmake|curl|wget|bash|sh|sudo|rm|chmod|powershell|pwsh|cmd";
  const end = new RegExp(`(?:[.!?](?=\\s|$)|,\\s|\\s+(?:${words})\\b)`, "u");
  const check = (prefix: string, value: string): string => {
    const split = value.search(end);
    const command = (split < 0 ? value : value.slice(0, split)).trim();
    const rest = split < 0 ? "" : value.slice(split);
    // "use pnpm in this repo", "npm or yarn", "node 22 for builds": a sentence about a
    // tool, not a command. Its next word is prose or a version, never an argument.
    const next = withoutEnvironment(command).split(/\s+/u)[1]?.toLowerCase().replace(/[^a-z0-9.-]/gu, "") ?? "";
    if (!next || PROSE_AFTER_PROGRAM.has(next) || /^\d/u.test(next)) return prefix + value;
    if (commandExists(command, source)) return prefix + command + gateRest(rest);
    // "npm run test from the repo root": a repository command, then the
    // sentence goes on. Keep the command when what follows is plain prose:
    // no shell syntax and no second program anywhere in it.
    for (const match of [...command.matchAll(/\s+(\S+)/gu)].slice(1).reverse()) {
      if (!PROSE_AFTER_PROGRAM.has(match[1].toLowerCase())) continue;
      const head = command.slice(0, match.index);
      const tail = command.slice(match.index);
      if (!/[;&|<>$`]/u.test(tail) && !programWord.test(tail) && commandExists(head, source)) return prefix + head + tail + gateRest(rest);
    }
    return prefix + "[unverified command removed]" + gateRest(rest);
  };
  const programWord = new RegExp(`\\b(?:${programs})\\b`, "iu");
  // After a command, a plain word may lead to another one ("npm test before
  // rm -rf build"): that is checked too, but only a lowercase program name,
  // so prose such as "before Python changes" is left alone.
  const gateRest = (input: string): string => input.replace(new RegExp(`(\\b(?:${words})\\s+)(${ENV_ASSIGNMENTS}(?:${programs})\\s+[^\\n\\0]+)`, "gu"), (_all, prefix: string, value: string) => check(prefix, value));
  text = text.replace(new RegExp(`(^|\\n|\\b(?:run|runs|running|execute|executes|using|with|use)\\s+)(${ENV_ASSIGNMENTS}(?:${programs})\\s+[^\\n\\0]+)`, "giu"), (_all, prefix: string, value: string) => check(prefix, value));
  return text.replace(/\0(\d+)\0/gu, (_all, index: string) => codes[Number(index)]);
}

/** Words that follow a program name in prose ("use pnpm in this repo") but never start its arguments. */
const PROSE_AFTER_PROGRAM = new Set(["in", "on", "at", "for", "to", "from", "with", "without", "and", "or", "nor", "but", "as", "by", "of",
  "the", "a", "an", "instead", "over", "here", "there", "everywhere", "only", "not", "never", "always", "is", "are", "was", "were", "be",
  "it", "this", "that", "these", "those", "we", "you", "our", "your", "its", "so", "also", "too", "rather", "than", "like", "unless",
  "when", "before", "after", "because", "if", "version", "versions", "anymore", "any", "all", "everything"]);

/** Gates apply on writes and reads; editing learned files by hand cannot bypass them. */
export function gateEntry(input: KnowledgeEntry, source: References, keptCheck?: (index: number) => void): KnowledgeEntry {
  const clean = (value: unknown): unknown => typeof value === "string" ? stripHidden(value)
    : Array.isArray(value) ? value.map(clean)
      : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clean(v)])) : value;
  const entry = validateEntry(clean(input));
  assertNoSecrets(entry);
  entry.text = sanitizeText(entry.text, source);
  entry.mex.one_line = sanitizeText(entry.mex.one_line, source);
  if (entry.mex.source.quote) entry.mex.source.quote = sanitizeText(entry.mex.source.quote, source);
  // source.ref is provenance (for example a reviewed PR), not a payload link.
  // Its source authority is checked by the store/capture boundary.
  entry.mex.checks = entry.mex.checks.filter((check, index) => {
    const kept = check.kind === "command" ? commandExists(check.target.run, source)
      : check.kind === "source" && "url" in check.target ? source.links.has(check.target.url) : true;
    if (kept) keptCheck?.(index);
    return kept;
  });
  return validateEntry(entry);
}
