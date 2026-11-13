import { KnowledgeError, validateEntry, type KnowledgeEntry } from "./entry.js";
import { commandExists, type References } from "./references.js";

export function stripHidden(text: string): string {
  return text.replace(/[\p{Cf}\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/gu, "");
}
const SECRETS = [
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/u,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{16,})\b/u,
  /\b(?:api[_ -]?key|access[_ -]?token|client[_ -]?secret|password|authorization)\s*[:=]\s*["']?(?:Bearer\s+)?[A-Za-z0-9_+\/.=-]{8,}/iu,
  /https?:\/\/[^\s/@:]+:[^\s/@]+@/iu,
];
export function hasSecret(text: string): boolean { return SECRETS.some(pattern => pattern.test(text)); }

const commandStart = /\b(?:npm|pnpm|yarn|npx|bun|node|python3?|pip3?|git|go|cargo|make|cmake|curl|wget|bash|sh|sudo|rm|chmod|powershell|pwsh|cmd)\s+/u;
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
  text = text.replace(/`([^`\n]+)`/gu, (_all, code: string) => {
    const looksLikeCommand = /\s/u.test(code) || commandStart.test(code) || /^(?:\.\/|\.\.\/)/u.test(code);
    return save(looksLikeCommand && !commandExists(code, source) ? "[unverified command removed]" : `\`${code}\``);
  });
  // Bare shell commands are checked as a whole, including chained suffixes.
  text = text.replace(/(^|\n|\b(?:run|runs|running|execute|executes|using|with|use)\s+)((?:npm|pnpm|yarn|npx|bun|node|python3?|pip3?|git|go|cargo|make|cmake|curl|wget|bash|sh|sudo|rm|chmod|powershell|pwsh|cmd)\s+[^\n\0]+)/giu, (_all, prefix: string, value: string) => {
    const split = value.search(/(?:[.!?](?=\s|$)|\s+(?:because|for which|so that)\b)/u);
    const command = (split < 0 ? value : value.slice(0, split)).trim();
    const rest = split < 0 ? "" : value.slice(split);
    return prefix + (commandExists(command, source) ? command : "[unverified command removed]") + rest;
  });
  return text.replace(/\0(\d+)\0/gu, (_all, index: string) => codes[Number(index)]);
}

/** Gates apply on writes and reads; editing learned files by hand cannot bypass them. */
export function gateEntry(input: KnowledgeEntry, source: References): KnowledgeEntry {
  const clean = (value: unknown): unknown => typeof value === "string" ? stripHidden(value)
    : Array.isArray(value) ? value.map(clean)
      : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clean(v)])) : value;
  const entry = validateEntry(clean(input));
  if (hasSecret(JSON.stringify(entry))) throw new KnowledgeError("SECRET_FOUND", "The entry contains a possible secret and was withheld.");
  entry.text = sanitizeText(entry.text, source);
  entry.mex.one_line = sanitizeText(entry.mex.one_line, source);
  if (entry.mex.source.quote) entry.mex.source.quote = sanitizeText(entry.mex.source.quote, source);
  // source.ref is provenance (for example a reviewed PR), not a payload link.
  // Its source authority is checked by the store/capture boundary.
  entry.mex.checks = entry.mex.checks.filter(check => check.kind === "command" ? commandExists(check.target.run, source)
    : check.kind === "source" && "url" in check.target ? source.links.has(check.target.url) : true);
  return validateEntry(entry);
}
