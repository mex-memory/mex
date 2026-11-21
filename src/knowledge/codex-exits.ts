/**
 * Codex hook payloads usually carry no exit code: a shell call's response is
 * just its output. The session's rollout does. Each finished command is an
 * `item_completed` event whose `CommandExecution` item has the hook's
 * `tool_use_id` as its id and the process's `exit_code`. The capture hook
 * keeps that id on command rows without an exit code; this reads the codes
 * back off the hook path, for the fail-pass job and the gate.
 */
import type { RecordLocation } from "../record/location.js";
import { filterSession } from "../filter/input.js";
import { transcriptTail } from "../filter/transcript.js";

/** How much of a rollout's end is read. Earlier commands stay unresolved. */
export const CODEX_EXIT_BYTES = 32 << 20;
const MARK = '"CommandExecution"';

/** Exit codes recorded in a Codex rollout, by call id. Only finished commands count. */
export function rolloutExitCodes(body: string, wanted: ReadonlySet<string>): Map<string, number> {
  const out = new Map<string, number>();
  for (const line of body.split("\n")) {
    if (out.size === wanted.size) break;
    if (!line.includes(MARK)) continue;
    let row: unknown;
    try { row = JSON.parse(line); } catch { continue; }
    const payload = (row as { type?: unknown; payload?: { type?: unknown; item?: Record<string, unknown> } })?.payload;
    const item = payload?.item;
    if ((row as { type?: unknown }).type !== "event_msg" || payload?.type !== "item_completed" || item?.type !== "CommandExecution") continue;
    const id = item.id, code = item.exit_code;
    if (typeof id !== "string" || !wanted.has(id) || !Number.isSafeInteger(code) || (item.status !== "completed" && item.status !== "failed")) continue;
    out.set(id, code as number);
  }
  return out;
}

/**
 * Exit codes for a Codex session's command rows, read from the transcript the
 * hook recorded for this project, checkout and session. Missing or unreadable
 * transcripts resolve nothing.
 */
export function codexExitCodes(location: Pick<RecordLocation, "directory">, project: string, checkout: string, session: string,
  callIds: ReadonlySet<string>): Map<string, number> {
  if (!callIds.size) return new Map();
  const meta = filterSession({ location: location as RecordLocation }, project, checkout, session);
  if (!meta || meta.agent !== "codex" || !meta.transcript) return new Map();
  const body = transcriptTail(meta.transcript, "codex", CODEX_EXIT_BYTES, false, true);
  return body ? rolloutExitCodes(body, callIds) : new Map();
}
