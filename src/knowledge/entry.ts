import { z } from "zod";
import { parseDocument, stringify } from "yaml";
import { ENTRY_KINDS, KNOWLEDGE_LIMITS, KnowledgeError } from "./contract.js";
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
const checkBase = { role: z.enum(["complete", "supporting"]), files: z.record(file, hash).refine(v => Object.keys(v).length <= 128, "Too many check files") };
const count = z.object({ count: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).strict();
const match = z.enum(["literal", "structural"]);
/** Stored observations only: evaluation belongs to the check evaluator. */
export const CheckSchema = z.discriminatedUnion("kind", [
  z.object({ ...checkBase, kind: z.literal("key"), target: z.object({ file, pointer }).strict(), saw: z.object({ value }).strict() }).strict(),
  z.object({ ...checkBase, kind: z.literal("command"), target: z.object({ run: line, file, pointer }).strict(), saw: z.object({ exists: z.boolean() }).strict() }).strict(),
  z.object({ ...checkBase, kind: z.literal("section"), target: z.object({ file, heading: line }).strict(), saw: z.object({ hash }).strict() }).strict(),
  z.object({ ...checkBase, kind: z.literal("source"), target: z.union([
    z.object({ file }).strict(), z.object({ url: z.string().url().max(2048).refine(s => /^https?:\/\//u.test(s), "Expected HTTP or HTTPS") }).strict(),
  ]), saw: z.object({ hash }).strict() }).strict(),
  z.object({ ...checkBase, kind: z.literal("value"), target: z.object({ file, symbol: line }).strict(), saw: z.object({ value }).strict() }).strict(),
  z.object({ ...checkBase, kind: z.literal("symbol"), target: z.object({ file, symbol: line }).strict(), saw: z.object({ fingerprint: line }).strict() }).strict(),
  z.object({ ...checkBase, kind: z.literal("pattern"), target: z.object({ scope, pattern: line, match: match.optional() }).strict(), saw: count }).strict(),
  z.object({ ...checkBase, kind: z.literal("relation"), target: z.object({ query: line, from: scope, to: scope }).strict(), saw: count }).strict(),
]);
const metadata = z.object({
  id: EntryIdSchema, kind: z.enum(ENTRY_KINDS), scope: z.array(scope).min(1).max(32),
  source: z.object({
    type: z.enum(["person", "docs", "review", "ci", "config", "rule-file", "mined", "observed", "agent-memory"]),
    ref: line, quote: z.string().min(1).max(KNOWLEDGE_LIMITS.textCharacters).optional(),
  }).strict(),
  evidence: z.enum(["person", "docs", "review", "ci", "mined", "observed"]),
  one_line: line.refine(s => s.length <= KNOWLEDGE_LIMITS.oneLineCharacters, "One-line claim is too long"),
  when: z.array(z.object({ type: z.enum(["anti", "required", "rejected", "creates"]), match, pattern: line }).strict()).max(32).optional(),
  checks: z.array(CheckSchema).max(32), companions: z.array(EntryIdSchema).max(32).optional(),
  status: z.enum(["active", "retired"]),
  retired: z.object({ reason: line, by: line, at: date }).strict().optional(), created: date,
}).strict().superRefine((m, ctx) => {
  if (m.source.type === "person" && !m.source.quote) ctx.addIssue({ code: "custom", path: ["source", "quote"], message: "A person source requires the exact typed quote" });
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
