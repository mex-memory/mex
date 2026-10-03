import { createHash, randomBytes } from "node:crypto";
import { parseDocument as parseYaml, stringify, visit, isAlias } from "yaml";
import { z } from "zod";
import { encodeUlidTime, encodeUlidRandom, decodeUlidTime, isUlid } from "../wiki/model/ulid.js";
import { parseDocument } from "../wiki/markdown/parse.js";
import { NOTE_LIMITS, NoteError, type NoteContext, type NoteRecord } from "./contracts.js";

export const NOTE_ROOT = "events/notes";
const text = (max: number) => z.string().refine((value) => Buffer.byteLength(value) <= max && Buffer.from(value).toString("utf8") === value);
const git = z.object({ branch: text(1024).nullable(), head: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/).nullable(), dirty: z.boolean(), observedAt: z.string().datetime() }).strict();
const context = z.object({ projectId: z.string().uuid().nullable(), repositoryId: z.null(), worktreeId: z.null(), actor: z.null(), session: z.null(), git: git.nullable() }).strict();
const metadataSchema = z.object({
  schema_version: z.literal(1), id: z.string(), timestamp: z.string().datetime(),
  kind: z.enum(["decision", "note", "risk", "todo"]),
  files: z.array(text(NOTE_LIMITS.pathBytes)).max(NOTE_LIMITS.files), cwd: text(NOTE_LIMITS.pathBytes).nullable(),
  context, origin_adapter: z.enum(["cli", "mcp", "api"]),
  trace: text(NOTE_LIMITS.labelBytes).optional(), source: text(NOTE_LIMITS.labelBytes).optional(), status: text(NOTE_LIMITS.labelBytes).optional(),
  message_bytes: z.number().int().min(0).max(NOTE_LIMITS.messageBytes), message_sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export function sha256(bytes: string | Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
export function newNoteId(date: Date): string { return `log_${encodeUlidTime(date.getTime())}${encodeUlidRandom(randomBytes(10))}`; }
export function noteTime(id: string): number {
  if (!id.startsWith("log_") || !isUlid(id.slice(4))) throw new NoteError("INVALID_NOTE_ID", "Expected a log_ note ID.");
  return decodeUlidTime(id.slice(4))!;
}
export function notePath(id: string): string {
  const date = new Date(noteTime(id)).toISOString();
  if (!/^\d{4}-/.test(date)) throw new NoteError("INVALID_NOTE_ID", "Unsupported note timestamp.");
  return `${NOTE_ROOT}/${date.slice(0, 7)}/${id}.md`;
}
export function portablePath(path: string): boolean {
  return path !== "" && !path.startsWith("/") && !path.includes("\\") && !/[\u0000-\u001f\u007f:]/.test(path)
    && path.split("/").every((part) => part !== ".." && part !== "." && part !== "");
}

export interface PreparedNote {
  id: string; timestamp: string; kind: NoteRecord["kind"]; files: string[]; cwd: string | null;
  context: NoteContext; originAdapter: "cli" | "mcp" | "api"; message: string;
  trace?: string; source?: string; status?: string;
}

export function encodeNote(note: PreparedNote): Buffer {
  const { message, originAdapter, ...fields } = note;
  const metadata = { schema_version: 1, ...fields, origin_adapter: originAdapter,
    message_bytes: Buffer.byteLength(message), message_sha256: sha256(message) };
  const yaml = stringify({ mex_log: metadata }, { lineWidth: 0 });
  if (Buffer.byteLength(yaml) > NOTE_LIMITS.metadataBytes) throw new NoteError("NOTE_TOO_LARGE", "Note metadata exceeds 16 KiB.");
  const bytes = Buffer.from(`---\n${yaml}---\n${message}`, "utf8");
  // One decoder is the authority for writes and reads, including the exact body boundary.
  decodeNote(bytes, note.id, notePath(note.id));
  return bytes;
}

export function decodeNote(bytes: Uint8Array, id: string, recordPath: string): NoteRecord {
  const invalid = () => new NoteError("INVALID_NOTE", "The note is malformed, unsupported or its recorded body digest does not match.");
  try {
    if (bytes.byteLength > NOTE_LIMITS.artifactBytes) throw invalid();
    const raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    if (!raw.startsWith("---\n")) throw invalid();
    // Bound the parser to metadata: supplied Markdown is opaque authored content.
    const end = raw.indexOf("\n---\n", 4);
    if (end < 0 || Buffer.byteLength(raw.slice(0, end)) > NOTE_LIMITS.metadataBytes) throw invalid();
    const header = raw.slice(0, end + 5);
    const frontmatter = parseDocument(header).frontmatter;
    if (!frontmatter || frontmatter.start !== 0) throw invalid();
    const yaml = parseYaml(frontmatter.text, { uniqueKeys: true, schema: "core" });
    if (yaml.errors.length || yaml.warnings.length) throw invalid();
    visit(yaml, (_, node) => { if (isAlias(node) || (node && typeof node === "object" && "tag" in node && node.tag)) throw invalid(); });
    const value = z.object({ mex_log: metadataSchema }).strict().parse(yaml.toJS({ maxAliasCount: 0 }));
    const meta = value.mex_log;
    const message = raw.slice(end + 5);
    if (meta.id !== id || new Date(noteTime(id)).toISOString() !== meta.timestamp
      || !meta.files.every(portablePath) || (meta.cwd !== null && meta.cwd !== "." && !portablePath(meta.cwd))
      || meta.message_bytes !== Buffer.byteLength(message) || meta.message_sha256 !== sha256(message)) throw invalid();
    return { id, format: "markdown", timestamp: meta.timestamp, kind: meta.kind, message,
      files: meta.files, cwd: meta.cwd, context: meta.context, originAdapter: meta.origin_adapter,
      ...(meta.trace === undefined ? {} : { trace: meta.trace }), ...(meta.source === undefined ? {} : { source: meta.source }),
      ...(meta.status === undefined ? {} : { status: meta.status }), recordPath, revision: sha256(bytes) };
  } catch { throw invalid(); }
}
