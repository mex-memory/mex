import { createHash, randomBytes } from "node:crypto";
import { resolve } from "node:path";
import type { RecordReader, RecordWriter } from "../../record/index.js";
import { mexHomeDir } from "../../global-config.js";
import { loadHubSecret } from "./secret.js";
import { BOOTSTRAP_TTL_MS, bootstrapKey, newBootstrapToken } from "./security.js";

/**
 * What the Hub keeps in record.db, all under settings scope `hub`. The CLI, the background
 * process and a terminal-run Hub coordinate only through these rows, never through IPC.
 */

const SCOPE = "hub";
/** The default home's Hub always asks for this port first, so its bookmarks stay valid. */
export const DEFAULT_HUB_PORT = 41_917;
/** Other homes take a stored port from this range; fallbacks stay inside it too. */
export const HUB_PORT_RANGE = { first: 41_917, last: 41_999 } as const;
export const HUB_PORT_FALLBACKS = 9;
/** A tab's heartbeat keeps the Hub up this long; the page sends one every minute. */
export const TAB_KEEPALIVE_MS = 2 * 60_000;
/** `mex hub` keeps the Hub up this long, to give the browser time to open the link. */
export const LAUNCH_KEEPALIVE_MS = 5 * 60_000;

export type HubMode = "background" | "terminal";

export interface BoundHub {
  readonly port: number;
  readonly pid: number;
  readonly version: string;
  readonly homeId: string;
  readonly mode: HubMode;
  readonly at: string;
}

type Reader = Pick<RecordReader, "setting"> | Pick<RecordWriter, "setting">;

function put(writer: RecordWriter, key: string, value: string): void {
  writer.db.prepare("INSERT INTO settings(scope,key,value) VALUES(?,?,?) ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value")
    .run(SCOPE, key, value);
}

/** A random id for this MEX home, so a Hub never serves, or is mistaken for, another home's. */
export function ensureHomeId(writer: RecordWriter): string {
  const existing = writer.setting(SCOPE, "home_id");
  if (existing) return existing;
  writer.db.prepare("INSERT OR IGNORE INTO settings(scope,key,value) VALUES(?,?,?)")
    .run(SCOPE, "home_id", randomBytes(16).toString("base64url"));
  return writer.setting(SCOPE, "home_id")!;
}

/** The port this home's Hub asks for first. Stored on first use, so it never moves on its own. */
export function preferredPort(writer: RecordWriter, home = writer.location.home): number {
  const stored = Number(writer.setting(SCOPE, "port"));
  if (Number.isSafeInteger(stored) && stored >= 1 && stored <= 65_535) return stored;
  const port = isDefaultHome(home) ? DEFAULT_HUB_PORT : derivedPort(home);
  put(writer, "port", String(port));
  return port;
}

/** The preferred port, then the next few inside the Hub range, wrapping around. */
export function candidatePorts(preferred: number): number[] {
  const ports = [preferred];
  const inRange = preferred >= HUB_PORT_RANGE.first && preferred <= HUB_PORT_RANGE.last;
  const span = HUB_PORT_RANGE.last - HUB_PORT_RANGE.first + 1;
  for (let step = 1; step <= HUB_PORT_FALLBACKS; step += 1) {
    ports.push(inRange
      ? HUB_PORT_RANGE.first + ((preferred - HUB_PORT_RANGE.first + step) % span)
      : HUB_PORT_RANGE.first + step - 1);
  }
  return ports;
}

export function readBound(reader: Reader): BoundHub | undefined {
  const raw = reader.setting(SCOPE, "bound");
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as Partial<BoundHub>;
    if (typeof value.port !== "number" || typeof value.pid !== "number" || typeof value.version !== "string"
      || typeof value.homeId !== "string" || (value.mode !== "background" && value.mode !== "terminal")
      || typeof value.at !== "string") return undefined;
    return value as BoundHub;
  } catch {
    return undefined;
  }
}

export function writeBound(writer: RecordWriter, bound: BoundHub): void {
  put(writer, "bound", JSON.stringify(bound));
}

/** Clear the row only if it is still ours, so a newer Hub's address is never erased. */
export function clearBound(writer: RecordWriter, pid: number, port: number): void {
  const current = readBound(writer);
  if (current && current.pid === pid && current.port === port) {
    writer.db.prepare("DELETE FROM settings WHERE scope=? AND key='bound'").run(SCOPE);
  }
}

/** A process that stops clears the address its Hub published, whichever port that was. */
export function clearBoundForPid(writer: RecordWriter, pid: number): void {
  const current = readBound(writer);
  if (current && current.pid === pid) writer.db.prepare("DELETE FROM settings WHERE scope=? AND key='bound'").run(SCOPE);
}

/** Mint the one-time sign-in token for a printed link; sweeps expired ones. */
export function mintBootstrap(writer: RecordWriter, now = Date.now()): string {
  sweepBootstraps(writer, now);
  const token = newBootstrapToken();
  put(writer, `bootstrap.${bootstrapKey(loadHubSecret(writer.location.home).bytes, token)}`, new Date(now + BOOTSTRAP_TTL_MS).toISOString());
  return token;
}

/** Use a sign-in token. True exactly once per token, and only before it expires. */
export function consumeBootstrap(writer: RecordWriter, token: string, now = Date.now()): boolean {
  const key = `bootstrap.${bootstrapKey(loadHubSecret(writer.location.home).bytes, token)}`;
  const row = writer.db.prepare("DELETE FROM settings WHERE scope=? AND key=? RETURNING value").get(SCOPE, key) as { value?: string } | undefined;
  if (!row?.value) return false;
  const expires = Date.parse(row.value);
  return Number.isFinite(expires) && expires > now;
}

function sweepBootstraps(writer: RecordWriter, now: number): void {
  const rows = writer.db.prepare("SELECT key, value FROM settings WHERE scope=? AND key LIKE 'bootstrap.%'").all(SCOPE) as { key: string; value: string }[];
  const drop = writer.db.prepare("DELETE FROM settings WHERE scope=? AND key=?");
  for (const row of rows) {
    const expires = Date.parse(row.value);
    if (!Number.isFinite(expires) || expires <= now) drop.run(SCOPE, row.key);
  }
}

/** Keep the Hub (and so the background process) up until at least `untilMs`. Never shortens it. */
export function keepHubOpen(writer: RecordWriter, untilMs: number): void {
  writer.db.prepare("UPDATE background SET hub_until=? WHERE id=1 AND (hub_until IS NULL OR hub_until < ?)")
    .run(new Date(untilMs).toISOString(), new Date(untilMs).toISOString());
}

function isDefaultHome(home: string): boolean {
  if (process.env.MEX_HOME?.trim()) return false;
  return samePath(resolve(home), resolve(mexHomeDir()));
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32" || process.platform === "darwin"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function derivedPort(home: string): number {
  const digest = createHash("sha256").update(resolve(home)).digest();
  const first = HUB_PORT_RANGE.first + 3;
  return first + (digest.readUInt32BE(0) % (HUB_PORT_RANGE.last - first + 1));
}
