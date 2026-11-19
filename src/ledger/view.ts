import { join } from "node:path";
import { readSnapshot, replaceFile, snapshotBytes } from "../install/files.js";
import type { RecordReader, RecordWriter } from "../record/index.js";
import type { RecordLocation } from "../record/location.js";
import { shortHash } from "../record/project.js";
import type { CompactAgent, CompactScope } from "../compaction/settings.js";
import { toolLevers, type Lever, type ToolLever } from "./accounting.js";
import { LEDGER_PRICE_PROFILE } from "./pricing.js";

type LedgerReader = Pick<RecordReader, "get" | "all" | "version">;
const pricedSchemaVersion = 12;
interface LeverGate { version: 1; off: boolean; rearmed_at: number }

export type LedgerMode = "report-only" | "enforce";
// Enable enforcement after the ledger also credits avoided calls.
export const LEDGER_MODE: LedgerMode = "report-only";

export interface LedgerNet { at: string; started: string; net_millitokens: number }

export function sessionLeverNet(hooks: LedgerReader, session: string, lever: Lever): LedgerNet | undefined {
  if (hooks.version < pricedSchemaVersion) return undefined;
  const result = hooks.get<LedgerNet>(`SELECT ended_at AS at, s.started_at AS started,
      (SELECT CASE WHEN count(*)=count(saved_input_millitokens) AND count(*)=count(cost_input_millitokens)
        THEN sum(saved_input_millitokens - cost_input_millitokens) END FROM ledger AS l
        WHERE l.session_id=s.session_id AND l.agent_id='' AND (l.lever=? OR l.lever GLOB ?)) AS net_millitokens
    FROM ledger_settlements JOIN sessions s USING(session_id) JOIN ledger base USING(session_id)
    WHERE s.session_id=? AND base.agent_id='' AND base.lever=? AND price_profile=?`,
    lever, lever + "#[0-9]*", session, lever, LEDGER_PRICE_PROFILE);
  return result && Number.isSafeInteger(result.net_millitokens) ? result : undefined;
}

function recentLeverNets(hooks: LedgerReader, lever: ToolLever, rearmedAt: number): number[] {
  const agent = lever === "codex-wrapper" ? "codex" : "claude-code";
  const sessions = hooks.all<{ session_id: string }>(`SELECT s.session_id
    FROM ledger_settlements JOIN sessions s USING(session_id) JOIN ledger base USING(session_id)
    WHERE base.agent_id='' AND base.lever=? AND s.agent=? AND price_profile=?
      AND base.saved_input_millitokens IS NOT NULL AND base.cost_input_millitokens IS NOT NULL
      AND (?=0 OR julianday(s.started_at)>julianday(?))
    ORDER BY julianday(ended_at) DESC,s.session_id LIMIT 10`, lever, agent, LEDGER_PRICE_PROFILE, rearmedAt, new Date(rearmedAt).toISOString());
  return sessions.flatMap(s => {
    const row = sessionLeverNet(hooks, s.session_id, lever);
    return row ? [row.net_millitokens] : [];
  });
}

export function ledgerShouldTurnOff(nets: number[]): boolean {
  return nets.length === 10 && nets.reduce((sum, net) => sum + net, 0) <= 0;
}

function parseGate(bytes: Buffer | null): LeverGate {
  const initial: LeverGate = { version: 1, off: false, rearmed_at: 0 };
  const content = bytes?.toString("utf8");
  if (content === "1\n") return { ...initial, off: true };
  try {
    const gate = JSON.parse(content ?? "null") as Partial<LeverGate> | null;
    if (gate?.version === 1 && typeof gate.off === "boolean" &&
      typeof gate.rearmed_at === "number" && Number.isSafeInteger(gate.rearmed_at) && gate.rearmed_at >= 0 && gate.rearmed_at <= 8.64e15) {
      return { version: 1, off: gate.off, rearmed_at: gate.rearmed_at };
    }
  } catch { /* Unknown state fails open. */ }
  return initial;
}

function updateLeverGate(writer: RecordWriter, lever: ToolLever, decide: (gate: LeverGate) => LeverGate | undefined): void {
  // Put the CLI reset and the worker's read/compare/publish under the same
  // record.db writer lock. The atomic file is what the native hook reads.
  writer.db.exec("BEGIN IMMEDIATE");
  try {
    const path = join(writer.location.directory, "ledger-off." + lever);
    const current = readSnapshot(path, 128);
    const next = decide(parseGate(snapshotBytes(current)));
    if (next) replaceFile(path, current, { data: Buffer.from(JSON.stringify(next) + "\n").toString("base64"), mode: 0o600 });
    writer.db.exec("COMMIT");
  } catch (error) {
    writer.db.exec("ROLLBACK");
    throw error;
  }
}

export function reenableLever(writer: RecordWriter, lever: ToolLever): void {
  updateLeverGate(writer, lever, gate => ({ ...gate, off: false, rearmed_at: Date.now() }));
}

/** A report never changes the gate file or its trial start. */
export function publishLeverGates(writer: RecordWriter, hooks: LedgerReader, mode: LedgerMode = LEDGER_MODE): void {
  if (hooks.version < pricedSchemaVersion) return;
  for (const lever of toolLevers) {
    updateLeverGate(writer, lever, gate => {
      const nonPositive = !gate.off && ledgerShouldTurnOff(recentLeverNets(hooks, lever, gate.rearmed_at));
      if (mode === "enforce" && nonPositive) return { ...gate, off: true };
      if (mode === "report-only") publishNoticeFile(writer.location, "ledger-report." + lever, nonPositive ? String(gate.rearmed_at) : undefined);
      return undefined;
    });
  }
}

function publishNoticeFile(location: RecordLocation, name: string, value?: string): void {
  const path = join(location.directory, name);
  const current = readSnapshot(path, 32);
  const data = value === undefined ? null : Buffer.from(value).toString("base64");
  if (current.data !== data) replaceFile(path, current, { data, mode: 0o600 });
}

export function publishCompactionLedgerNotice(
  location: RecordLocation, agent: CompactAgent, scope: CompactScope, checkout: string, accepted: number, mode: LedgerMode,
): void {
  const key = agent + "." + (scope === "user" ? "user" : shortHash(checkout));
  const id = shortHash(key + "\0" + accepted);
  publishNoticeFile(location, "ledger-compaction." + key, mode === "report-only" ? "report:" + id : id);
}
