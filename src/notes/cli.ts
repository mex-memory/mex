import type { MexConfig } from "../types.js";
import type { NoteInput, NoteQuery } from "./contracts.js";
import { NOTE_LIMITS, noteProblem } from "./contracts.js";
import { findNotes, getNote, recordNote } from "./service.js";

export async function runNoteLog(config: MexConfig, input: NoteInput, json = false): Promise<void> {
  const receipt = await recordNote(config, { ...input, originAdapter: "cli" });
  if (json) console.log(JSON.stringify(receipt, null, 2));
  else {
    console.log(`Recorded ${receipt.id} locally (${receipt.recordPath}).`);
    if (receipt.durability === "file_flushed_directory_flush_unsupported") console.log("File flushed; directory flush is unsupported on this platform. Host-crash durability is not guaranteed.");
  }
}

export function runNoteGet(config: MexConfig, id: string, json = false): void {
  const note = getNote(config, id);
  console.log(json ? JSON.stringify({ schemaVersion: 1, note }, null, 2) : `${note.id}\n${note.message}`);
}

export function runNoteTimeline(config: MexConfig, query: NoteQuery, options: { json?: boolean; format?: string }): void {
  const result = findNotes(config, query);
  if (options.json) { console.log(JSON.stringify(result, null, 2)); return; }
  const notices: string[] = [];
  if (result.truncated) notices.push("Some matching notes were omitted by the entry or output limit; narrow the filters.");
  if (result.sourceTruncated) notices.push("History search was incomplete; older, malformed or unavailable records may be absent.");
  notices.push(...result.diagnostics.map((entry) => `${entry.code}: ${entry.message}`));
  const md = options.format === "md";
  const lines = md ? ["| Date | Type | Event | Files | ID |", "|---|---|---|---|---|"] : [];
  const cell = (value: string) => value.replace(/\r\n|[\r\n]/g, " ").replace(/[\\`*_{}\[\]<>&|~]/g, "\\$&");
  let bytes = Buffer.byteLength([...lines, ...notices, "Some notes were omitted by the rendered output limit."].join("\n")) + 32;
  let omitted = false;
  for (const note of result.events) {
    const row = md ? `| ${cell(note.timestamp.slice(0, 10))} | ${note.kind} | ${cell(note.message)} | ${note.files.map(cell).join(", ")} | ${note.id ?? "unavailable"} |`
      : `${note.timestamp.slice(0, 10)} ${note.kind} ${note.message}${note.files.length ? ` (${note.files.join(", ")})` : ""} [${note.id ?? "legacy ID unavailable"}]`;
    const size = Buffer.byteLength(row) + 1;
    if (bytes + size > NOTE_LIMITS.outputBytes) { omitted = true; continue; }
    lines.push(row); bytes += size;
  }
  if (omitted) notices.push("Some notes were omitted by the rendered output limit.");
  if (!result.events.length) lines.push(result.sourceTruncated ? "No matches in the available search window." : "No notes found.");
  console.log([...lines, ...(notices.length ? ["", ...notices] : [])].join("\n"));
}

export function printNoteError(error: unknown, json = false): void {
  const problem = noteProblem(error);
  console.error(json ? JSON.stringify({ schemaVersion: 1, ok: false, problem })
    : `${problem.code}: ${problem.message}${problem.recordId ? ` (${problem.recordId})` : ""}`);
  process.exitCode = 1;
}
