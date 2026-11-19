import { execFile } from "node:child_process";
import { existsSync, opendirSync, renameSync, rmdirSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";
import { filterSession } from "../filter/input.js";
import { transcriptTail } from "../filter/transcript.js";
import { binaryFileName } from "../hooks/shim/binary.js";
import { nativeBinary } from "../knowledge/check.js";
import { containedDirectory, readBoundedTextFile } from "../knowledge/files.js";
import { openHooksReadOnly, type RecordReader, type RecordWriter } from "../record/index.js";
import { shortHash } from "../record/project.js";
import { observationData, readLedgerTrace, settleSessionLedger, type LedgerTerm, type Observation } from "./accounting.js";
import { LEDGER_PRICE_PROFILE } from "./pricing.js";
import { publishLeverGates } from "./view.js";

const pendingFolder = "ledger-pending";
const MAX_PENDING = 4;
const MAX_OBSERVATIONS = 4096;
const MAX_TRANSCRIPT_BYTES = 32 << 20;
const MAX_PENDING_AGE = 24 * 60 * 60_000;
// Give the closing host a chance to flush its last usage record.
const SETTLE_DELAY = 2_000;
const finish = z.object({
  version: z.literal(1), agent: z.enum(["claude-code", "codex"]),
  project: z.string().regex(/^[gf]-[0-9a-f]{24}$/u), checkout: z.string().min(1).max(4096),
  session: z.string().min(1).max(256), ended: z.string().datetime({ offset: true }),
}).strict();
type Finish = z.infer<typeof finish>;
type Settlement = Omit<Finish, "version"> & { price_profile: string; terms: LedgerTerm[] };

export function ledgerPending(directory: string): boolean {
  return existsSync(join(directory, pendingFolder));
}

function observe(hooks: RecordReader, input: Finish, ended: number): Observation[] | undefined {
  const rows = hooks.all<{ ts: string; detail: string }>(
    "SELECT ts,CASE WHEN length(CAST(detail AS BLOB))<=256 THEN detail ELSE '' END detail " +
    "FROM deliveries WHERE session_id=? AND agent_id='' AND project_id=? AND checkout=? " +
    "AND moment='lever-observation' AND action='control' ORDER BY ts LIMIT ?",
    input.session, input.project, input.checkout, MAX_OBSERVATIONS + 1);
  if (rows.length > MAX_OBSERVATIONS) return undefined;
  const observations: Observation[] = [];
  for (const row of rows) {
    const at = Date.parse(row.ts);
    if (!Number.isFinite(at)) return undefined;
    if (at > ended) continue;
    try {
      const parsed = observationData.parse(JSON.parse(row.detail));
      if ((input.agent === "codex") !== (parsed.lever === "codex-wrapper")) return undefined;
      observations.push({ at, ...parsed });
    } catch { return undefined; }
  }
  return observations;
}

function measure(writer: RecordWriter, hooks: RecordReader, input: Finish): LedgerTerm[] | undefined {
  const ended = Date.parse(input.ended);
  const checkout = writer.checkout(input.checkout);
  if (!checkout || checkout.path !== input.checkout || checkout.project_id !== input.project || checkout.state === "off" ||
    (checkout.state === "off until" && !(Date.parse(checkout.off_until ?? "") <= Date.now()))) return undefined;
  const session = hooks.get<{ started_at: string; last_seen_at: string }>(
    "SELECT started_at,last_seen_at FROM sessions WHERE session_id=? AND project_id=? AND checkout=? AND agent=? AND paused=0",
    input.session, input.project, input.checkout, input.agent);
  if (!session || !(Date.parse(session.started_at) <= ended && Date.parse(session.last_seen_at) <= ended)) return undefined;
  const meta = filterSession(writer, input.project, input.checkout, input.session);
  if (!meta?.finished || meta.agent !== input.agent || meta.seen_at !== input.ended) return undefined;
  const name = basename(meta.transcript);
  if (!(input.agent === "claude-code" ? name === input.session + ".jsonl" : name.endsWith("-" + input.session + ".jsonl"))) return undefined;
  const body = transcriptTail(meta.transcript, input.agent === "claude-code" ? "claude" : "codex", MAX_TRANSCRIPT_BYTES, true);
  if (!body) return undefined;
  const trace = readLedgerTrace(body, input.agent, input.session, ended, input.checkout);
  const observations = observe(hooks, input, ended);
  if (!trace || !observations) return undefined;

  // Older host logs can be missing the boundary itself. Still stop carrying
  // tool savings when the controller has evidence of a context replacement.
  const resets = hooks.all<{ started_at: string; reason: string }>(
    "SELECT started_at,reason FROM epochs WHERE session_id=? AND agent_id='' " +
    "AND reason IN ('clear','rewind','fork','compact') ORDER BY epoch LIMIT 257", input.session);
  if (resets.length > 256) return undefined;
  for (const row of resets) {
    const at = Date.parse(row.started_at);
    if (at < ended && !trace.boundaries.some(b => Math.abs(b.at - at) <= 60_000 && b.compact && row.reason === "compact")) {
      trace.boundaries.push({ at });
    }
  }
  return settleSessionLedger(trace, observations);
}

function persist(writer: RecordWriter, data: Settlement): Promise<void> {
  const installed = join(writer.location.home, "bin", binaryFileName());
  const binary = process.env.MEX_HOOK_BINARY ? nativeBinary() : existsSync(installed) ? installed : nativeBinary();
  if (!binary) return Promise.reject(new Error("The native hook is unavailable."));
  return new Promise((resolve, reject) => {
    const child = execFile(binary, ["--ledger-settle"], { encoding: "utf8", timeout: 5_000, maxBuffer: 4096,
      windowsHide: true, env: { ...process.env, MEX_BACKGROUND: "1" } }, (error, stdout) => {
      try {
        if (error || typeof JSON.parse(stdout).saved !== "boolean") throw error ?? new Error();
        resolve();
      } catch { reject(new Error("The native ledger writer did not acknowledge the session.")); }
    });
    child.stdin?.on("error", () => { /* execFile reports the failure */ });
    child.stdin?.end(JSON.stringify(data));
  });
}

/** Claim bounded end-of-session requests. Unacknowledged claims survive a
 * worker exit and native replacement makes a repeated settlement harmless. */
export async function settlePendingLedger(writer: RecordWriter, now: number, write = persist): Promise<void> {
  const directory = containedDirectory(writer.location.directory, [pendingFolder]);
  if (!directory) return;
  const hooks = openHooksReadOnly({ home: writer.location.home });
  try {
    if (!hooks || hooks.diagnostic) return;
    const folder = opendirSync(directory);
    const keys = new Set<string>();
    try {
      for (let inspected = 0; inspected < 128 && keys.size < MAX_PENDING; inspected++) {
        const entry = folder.readSync();
        if (!entry) break;
        const key = /^([0-9a-f]{24})\.(?:json|claimed)$/u.exec(entry.name)?.[1];
        if (key && entry.isFile() && !entry.isSymbolicLink()) keys.add(key);
      }
    } finally { folder.closeSync(); }

    let unacknowledged = false;
    // Only measure one transcript at a time. measure returns numeric terms
    // and its transcript body goes out of scope before the awaited write.
    for (const key of keys) {
      const source = join(directory, key + ".json"), claim = join(directory, key + ".claimed");
      try {
        if (!existsSync(claim)) renameSync(source, claim);
        let parsed: ReturnType<typeof finish.safeParse>;
        try { parsed = finish.safeParse(JSON.parse(readBoundedTextFile(claim, 16 << 10) ?? "null")); }
        catch { unlinkSync(claim); continue; }
        if (parsed.success) {
          const { version, ...input } = parsed.data;
          const ended = Date.parse(input.ended);
          if (key === shortHash([input.agent, input.project, input.checkout, input.session].join("\0")) &&
            ended >= now - MAX_PENDING_AGE && ended <= now &&
            writer.setting("global", "capture.enabled") !== "false" && writer.setting(input.project, "capture.enabled") !== "false") {
            if (now - ended < SETTLE_DELAY) continue;
            const terms = measure(writer, hooks, parsed.data);
            if (terms) await write(writer, { ...input, price_profile: LEDGER_PRICE_PROFILE, terms });
          }
        }
        unlinkSync(claim);
      } catch {
        unacknowledged = true;
      }
    }
    // A crash between the native commit and publication leaves a claim, or
    // a directory still present for the next review to see.
    publishLeverGates(writer, hooks);
    try { rmdirSync(directory); } catch { /* newer or outstanding requests */ }
    if (unacknowledged) throw new Error("Some ledger requests will be retried.");
  } finally { hooks?.close(); }
}
