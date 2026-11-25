import { lstatSync } from "node:fs";
import type { RecordReader } from "../../record/index.js";
import type { LocationOptions } from "../../record/location.js";

type Opener = (location: LocationOptions) => RecordReader | undefined;

/** Treat a missing store as empty, while letting an unreadable store surface as a request error. */
export function readStore<T>(open: Opener, location: LocationOptions, read: (reader: RecordReader | undefined) => T): T {
  const reader = open(location);
  try {
    if (reader?.diagnostic) throw new Error(reader.diagnostic);
    return read(reader);
  } finally { reader?.close(); }
}

export function boundedSetting(reader: RecordReader, scope: string, key: string, maxBytes: number): string | undefined {
  return reader.get<{ value: string }>(
    "SELECT value FROM settings WHERE scope=? AND key=? AND length(CAST(value AS BLOB))<=?", scope, key, maxBytes,
  )?.value;
}

export const checkoutCollation = process.platform === "win32" ? "COLLATE NOCASE" : "";

export const knowledgeKey = (repoId: string, audience: "onlyYou" | "team" | "hint", id: string) => `${repoId}:${audience}:${id}`;

const CHECKOUT_LIMIT = 128;

export function activeCheckouts(reader: RecordReader, project: string, now: number): string[] {
  const rows = reader.all<{ path: string }>(`SELECT path FROM checkouts WHERE project_id=?
    AND (state='on' OR (state='off until' AND off_until<=?)) ORDER BY path LIMIT ?`, project, new Date(now).toISOString(), CHECKOUT_LIMIT + 1);
  if (rows.length > CHECKOUT_LIMIT) throw new Error("Home checkout scan limit exceeded");
  return rows.map(({ path }) => path).filter((path) => lstatSync(path, { throwIfNoEntry: false })?.isDirectory());
}

export function mostRecentCheckout(hooks: RecordReader | undefined, project: string, paths: string[]) {
  if (paths.length < 2) return paths[0];
  const last = hooks?.get<{ checkout: string }>(`SELECT checkout FROM sessions WHERE project_id=?
    AND checkout ${checkoutCollation} IN (SELECT value FROM json_each(?))
    ORDER BY last_seen_at DESC,session_id DESC LIMIT 1`, project, JSON.stringify(paths));
  return paths.find((path) => checkoutCollation ? path.toLowerCase() === last?.checkout.toLowerCase() : path === last?.checkout) ?? paths[0];
}

const knowledgeStatuses = { held: "upToDate", changed: "codeChanged", broken: "outOfDate", unknown: "notChecked" } as const;
export function knowledgeStatus(verdict: string | undefined) {
  return Object.hasOwn(knowledgeStatuses, verdict ?? "") ? knowledgeStatuses[verdict as keyof typeof knowledgeStatuses] : "notChecked";
}
