import { z } from "zod";
import { parseDocument, stringify } from "yaml";
import { ENTRY_KINDS, KNOWLEDGE_LIMITS, KnowledgeError } from "./contract.js";
import { PRODUCER_IDS } from "./producers.js";
export { ENTRY_KINDS, KNOWLEDGE_LIMITS, KnowledgeError } from "./contract.js";

/** Internal entry-file v0 contract. Location, verdicts and usage are not entry fields. */
const line = z.string().min(1).max(2048).refine(s => s.trim().length > 0 && !/[\x00-\x1f\x7f]/u.test(s), "Expected one nonempty line");
export const EntryIdSchema = z.string().regex(/^mx_[a-z0-9]{6,64}$/u);
const relative = (s: string) => !/^(?:\/|[A-Za-z]:)/u.test(s) && !/[\\\x00-\x1f\x7f]/u.test(s)
  && s.split("/").every(part => part !== ".." && part !== "." && part !== "");
const scope = z.string().min(1).max(512).refine(relative, "Expected a repository-relative glob");
const file = scope.refine(s => !/[*?\[\]{}]/u.test(s), "Expected an exact repository-relative file");
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).refine(s => {
  const ms = Date.parse(`${s}T00:00:00.000Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === s;
}, "Expected a calendar date without a time");
const hash = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const pointer = z.string().max(2048).regex(/^(?:\/(?:[^~\x00-\x1f]|~[01])*)*$/u);

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
function boundedJson(value: unknown): value is JsonValue {
  let remaining = 1024;
  function visit(v: unknown, depth: number): boolean {
    if (--remaining < 0 || depth > 12) return false;
    if (v === null || typeof v === "boolean") return true;
    if (typeof v === "number") return Number.isFinite(v);
    if (typeof v === "string") return v.length <= 8192;
    if (Array.isArray(v)) return v.length <= 1024 && v.every(item => visit(item, depth + 1));
    return typeof v === "object" && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null)
      && Object.entries(v).every(([key, item]) => key.length <= 512 && visit(item, depth + 1));
  }
  try { return visit(value, 0) && Buffer.byteLength(JSON.stringify(value), "utf8") <= 8192; }
  catch { return false; }
}
const value = z.custom<JsonValue>(boundedJson, "Expected bounded JSON data");
const phrase = (max: number) => line.refine(s => s.length <= max && s.trim() === s, `Expected a trimmed phrase of at most ${max} characters`);
const unique = (list: string[]) => new Set(list.map(s => s.toLowerCase())).size === list.length;
/** Retrieval aids only: never delivered text and never evidence. */
const aliases = z.array(phrase(KNOWLEDGE_LIMITS.aliasCharacters)).max(KNOWLEDGE_LIMITS.aliases).refine(unique, "Duplicate alias");
const asks = z.array(phrase(KNOWLEDGE_LIMITS.askCharacters)).max(KNOWLEDGE_LIMITS.asks).refine(unique, "Duplicate ask");
const sha = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);
const positiveLine = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const code = (lines: number) => z.string().min(1).refine(s =>
  !s.includes("\0") && s.replace(/(?:\r\n?|\n)$/u, "").split(/\r\n?|\n/u).length <= lines);
const fix = z.object({
  snippet: code(KNOWLEDGE_LIMITS.fixLines).refine(s => s.length <= KNOWLEDGE_LIMITS.fixCharacters),
  path: file, commit: sha,
  lines: z.string().regex(/^[1-9]\d{0,15}-[1-9]\d{0,15}$/u).refine(s => {
    const [start, end] = s.split("-").map(Number);
    return Number.isSafeInteger(start) && Number.isSafeInteger(end) && end >= start && end - start < KNOWLEDGE_LIMITS.fixLines;
  }),
}).strict();
const region = z.object({ start: positiveLine, end: positiveLine, text: code(KNOWLEDGE_LIMITS.fixtureLines), hash })
  .strict().refine(r => r.end >= r.start && r.end - r.start < KNOWLEDGE_LIMITS.fixtureLines);
const version = z.string().max(128).regex(/^v?\d+(?:\.\d+)*(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u);
export const sourceQuoteWordCount = (s: string): number => s.trim().split(/\s+/u).filter(Boolean).length;
export const isLearnedEntry = ({ id, source }: { id: string; source: { producer?: string; type: string } }): boolean =>
  source.producer === "learn-deeper" || (source.type !== "person" &&
    (source.producer === "judge" || source.producer === undefined) && /^mx_deep[a-f0-9]{32}$/u.test(id));
const fixtureSize = (pairs: Array<{ before: { text: string }; after: { text: string } }>) =>
  pairs.reduce((n, pair) => n + Buffer.byteLength(pair.before.text) + Buffer.byteLength(pair.after.text), 0);
/** The commit a decision cites. Patch id, subject and files let a squash or rebase copy match it. */
const commit = z.object({
  sha, patch_id: sha.optional(), subject: phrase(512).optional(),
  files: z.array(file).max(KNOWLEDGE_LIMITS.commitFiles).optional(),
  /** A line of the commit the decision rests on, kept only if found in the commit. */
  quote: phrase(512).optional(),
}).strict();
const checkBase = { role: z.enum(["complete", "supporting"]), files: z.record(file, hash).refine(v => Object.keys(v).length <= 128, "Too many check files") };
const count = z.object({ count: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).strict();
const match = z.enum(["literal", "structural"]);
/** Stored observations only: evaluation belongs to the check evaluator. */
export const CheckSchema = z.discriminatedUnion("kind", [
  z.object({ ...checkBase, kind: z.literal("key"), target: z.object({ file, pointer,
    member: z.string().min(1).max(512).regex(/^\P{Cc}+$/u).refine(s => s === s.trim() && !s.includes("\uFEFF"), "Expected a member name without surrounding whitespace or hidden marks").optional() }).strict(), saw: z.object({ value }).strict() }).strict(),
  z.object({ ...checkBase, kind: z.literal("command"), target: z.object({ run: line, file, pointer }).strict(), saw: z.object({ exists: z.boolean() }).strict() }).strict(),
  z.object({ ...checkBase, kind: z.literal("section"), target: z.object({ file, heading: line }).strict(), saw: z.object({ hash }).strict() }).strict(),
  z.object({ ...checkBase, kind: z.literal("source"), target: z.union([
    z.object({ file }).strict(), z.object({ url: z.string().url().max(2048).refine(s => /^https?:\/\//u.test(s), "Expected HTTP or HTTPS") }).strict(),
  ]), saw: z.object({ hash }).strict() }).strict(),
  z.object({ ...checkBase, kind: z.literal("value"), target: z.object({ file, symbol: line }).strict(), saw: z.object({ value }).strict() }).strict(),
  z.object({ ...checkBase, kind: z.literal("symbol"), target: z.object({ file, symbol: line }).strict(), saw: z.object({ fingerprint: line }).strict() }).strict(),
  // Imported 0.8 evidence only: a new evaluator cannot renew this baseline.
  z.object({ kind: z.literal("legacy-grounding"), role: z.literal("supporting"),
    target: z.object({ node: line.refine(s => /^[A-Za-z_]+:[0-9a-fA-F]{8,}$/u.test(s)), file: file.optional() }).strict(),
    saw: z.object({ fingerprint: line.refine(s => /^(?:[mM][hH]:\d+:(?:[0-9a-fA-F]{2})+|mh2:\d+:[A-Za-z0-9_-]+)$/u.test(s)), bodyHash: line.optional(), codeHash: line.optional() }).strict(),
    files: z.object({}).strict(),
  }).strict(),
  z.object({ ...checkBase, kind: z.literal("pattern"), target: z.object({ scope, pattern: line, match: match.optional(),
    expect: z.enum(["exact", "at-most", "present"]).optional() }).strict(), saw: count }).strict(),
  z.object({ ...checkBase, kind: z.literal("relation"), target: z.object({ query: line, from: scope, to: scope }).strict(), saw: count }).strict(),
  z.object({ ...checkBase, kind: z.literal("fixture"), target: z.object({
    pairs: z.array(z.object({ path: file, commit: sha, before: region, after: region }).strict()).min(1).max(KNOWLEDGE_LIMITS.fixturePairs),
    proves: z.array(z.number().int().min(0).max(31)).min(1).max(32).refine(xs => new Set(xs).size === xs.length),
  }).strict().refine(t => fixtureSize(t.pairs) <= KNOWLEDGE_LIMITS.fixtureBytes), saw: z.object({ ok: z.literal(true) }).strict() }).strict(),
  z.object({ ...checkBase, kind: z.literal("scope"), target: z.object({ glob: scope }).strict(), saw: count }).strict(),
  z.object({ ...checkBase, kind: z.literal("quote"), target: z.object({
    file, exact: z.string().min(1).max(4096).refine(s => !!s.trim() && !s.includes("\0")),
    prefix: z.string().max(128), suffix: z.string().max(128), heading: line.optional(),
  }).strict(), saw: z.object({ hash }).strict() }).strict(),
  z.object({ ...checkBase, kind: z.literal("until"), target: z.object({ file, pointer, version }).strict(),
    saw: z.object({ value: version }).strict() }).strict(),
]).refine(check => check.kind !== "key" || check.target.member === undefined || check.saw.value === true, "Membership checks must record declared presence as true");
const metadata = z.object({
  id: EntryIdSchema, kind: z.enum(ENTRY_KINDS), scope: z.array(scope).min(1).max(32),
  source: z.object({
    type: z.enum(["person", "docs", "review", "ci", "config", "rule-file", "mined", "observed", "agent-memory"]),
    ref: line, quote: z.string().min(1).max(KNOWLEDGE_LIMITS.textCharacters).optional(),
    producer: z.enum(PRODUCER_IDS).optional(),
    model: z.object({ id: phrase(128), version: phrase(128) }).strict().optional(),
    label: phrase(80).optional(),
  }).strict(),
  evidence: z.enum(["person", "docs", "review", "ci", "mined", "observed"]),
  one_line: line.refine(s => s.length <= KNOWLEDGE_LIMITS.oneLineCharacters, "One-line claim is too long"),
  when: z.array(z.object({ type: z.enum(["anti", "required", "rejected", "creates"]), match, pattern: line }).strict()).max(32).optional(),
  checks: z.array(CheckSchema).max(32), companions: z.array(EntryIdSchema).max(32).optional(),
  aliases: aliases.optional(), asks: asks.optional(), commit: commit.optional(), fix: fix.optional(),
  supersedes: z.array(EntryIdSchema).max(KNOWLEDGE_LIMITS.supersedes).optional(),
  // proposed: written by an agent and not yet in force; never delivered as accepted knowledge.
  status: z.enum(["active", "proposed", "retired"]),
  retired: z.object({ reason: line, by: line, at: date }).strict().optional(), created: date,
}).strict().superRefine((m, ctx) => {
  if (m.source.type === "person" && !m.source.quote) ctx.addIssue({ code: "custom", path: ["source", "quote"], message: "A person source requires the exact typed quote" });
  if (m.source.type !== "person" && m.source.quote !== undefined && isLearnedEntry(m)
    && (sourceQuoteWordCount(m.source.quote) === 0 || sourceQuoteWordCount(m.source.quote) > KNOWLEDGE_LIMITS.sourceQuoteWords)) {
    ctx.addIssue({ code: "custom", path: ["source", "quote"], message: "Expected a source quote of at most 25 words" });
  }
  if (m.fix && !["rule", "pitfall", "decision"].includes(m.kind)) {
    ctx.addIssue({ code: "custom", path: ["fix"], message: "Only rules, pitfalls and decisions can carry a fix" });
  }
  const bytes = m.checks.reduce((n, check) => n + (check.kind === "fixture" ? fixtureSize(check.target.pairs) : 0), 0);
  if (bytes > KNOWLEDGE_LIMITS.fixtureBytes) ctx.addIssue({ code: "custom", path: ["checks"], message: "Fixture text exceeds 12 KiB" });
  if ((m.status === "retired") !== (m.retired !== undefined)) ctx.addIssue({ code: "custom", path: ["retired"], message: "A retirement record is required exactly when retired" });
});
export const EntrySchema = z.object({
  mex: metadata,
  text: z.string().min(1).max(KNOWLEDGE_LIMITS.textCharacters).refine(s => s.trim().length > 0 && !s.includes("\0"), "Expected entry text"),
}).strict();
export type KnowledgeEntry = z.infer<typeof EntrySchema>;
export type EntryKind = KnowledgeEntry["mex"]["kind"];
export type EntryCheck = z.infer<typeof CheckSchema>;

export function validateEntry(input: unknown): KnowledgeEntry {
  const result = EntrySchema.safeParse(input);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new KnowledgeError("INVALID_ENTRY", `Invalid entry at ${issue.path.join(".") || "root"}: ${issue.message}`);
  }
  return result.data;
}
export function assertPersonQuote(entry: KnowledgeEntry, typedText: string): void {
  if (entry.mex.source.type === "person" && (!entry.mex.source.quote || !typedText.includes(entry.mex.source.quote))) {
    throw new KnowledgeError("UNVERIFIED_SOURCE", "The person quote was not found in the supplied typed text.");
  }
}
export function serializeEntry(input: KnowledgeEntry): string {
  const entry = validateEntry(input);
  const content = `---\n${stringify({ mex: entry.mex }, { lineWidth: 0, aliasDuplicateObjects: false })}---\n${entry.text.trim()}\n`;
  if (Buffer.byteLength(content, "utf8") > KNOWLEDGE_LIMITS.entryBytes) throw new KnowledgeError("ENTRY_TOO_LARGE", "Entry exceeds the file size limit.");
  return content;
}
export function parseEntry(content: string): KnowledgeEntry {
  if (Buffer.byteLength(content, "utf8") > KNOWLEDGE_LIMITS.entryBytes) throw new KnowledgeError("ENTRY_TOO_LARGE", "Entry exceeds the file size limit.");
  const normalized = content.replace(/\r\n/g, "\n");
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/u.exec(normalized);
  if (!match) throw new KnowledgeError("INVALID_ENTRY", "Entry requires one YAML frontmatter block and its text.");
  let frontmatter: unknown;
  try {
    const document = parseDocument(match[1], { uniqueKeys: true, strict: true });
    if (document.errors.length || document.warnings.length) throw new Error("Invalid YAML");
    frontmatter = document.toJS({ maxAliasCount: 0 });
  } catch { throw new KnowledgeError("INVALID_ENTRY", "Entry frontmatter must be valid YAML without aliases or custom tags."); }
  const envelope = z.object({ mex: metadata }).strict().safeParse(frontmatter);
  if (!envelope.success) throw new KnowledgeError("INVALID_ENTRY", "Entry frontmatter contains invalid or unsupported fields.");
  return validateEntry({ ...envelope.data, text: match[2].trim() });
}
