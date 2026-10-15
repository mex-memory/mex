/**
 * Entities a session touched and nobody has vouched for.
 *
 * `.mex/local/context-flags.json` is the checkout-local record behind the
 * "changed, re-check" mark. An entity lands here when a session's code change
 * touched what it describes. It is **flagged** until the agent either rewrote
 * its prose or explicitly confirmed it still holds (`mex context confirm`);
 * then it is **eligible** and the settle worker re-records its code links.
 * Reading code, or being shown the fact, is never a confirmation.
 *
 * `reconciled` remembers when an entity's links were last re-recorded, so the
 * same uncommitted change is not asked about again at every Stop.
 *
 * Reads are bounded and tolerant (damaged file: nothing flagged); writes go
 * through `local-state.ts`, the context feature's only writer.
 */

import { join } from "node:path";
import { readBounded } from "./index-file.js";
import { writeTextAtomic } from "./local-state.js";

export const FLAGS_FILE_NAME = "context-flags.json";
const FLAGS_SCHEMA_VERSION = 1;
const MAX_FLAGS_BYTES = 2 * 1024 * 1024;
export const MAX_FLAGGED_ENTITIES = 1000;
export const MAX_RECONCILED = 1000;

export type FlagStatus = "flagged" | "eligible";
export type FlagBasis = "edited" | "confirmed";

export interface FlagEntry {
  title: string;
  /** `.mex`-relative Markdown file and the line of the entity's heading. */
  file: string;
  line: number;
  /** Why it counts as touched, in a few words. */
  why: string;
  status: FlagStatus;
  /** For an eligible entity: what makes it eligible. */
  basis?: FlagBasis;
  /** The confirmation's note, if one was given. */
  note?: string;
  since: string;
  updatedAt: string;
  /** The last re-record attempt that failed. */
  error?: string;
}

export interface FlagsFile {
  schemaVersion: number;
  entities: Record<string, FlagEntry>;
  /** Entity id to when its links were last re-recorded by the settle worker. */
  reconciled: Record<string, string>;
}

export const flagsPathOf = (localDir: string): string => join(localDir, FLAGS_FILE_NAME);

const emptyFlags = (): FlagsFile => ({ schemaVersion: FLAGS_SCHEMA_VERSION, entities: {}, reconciled: {} });

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

export function loadFlags(localDir: string): FlagsFile {
  const read = readBounded(flagsPathOf(localDir), MAX_FLAGS_BYTES);
  if (!("text" in read)) return emptyFlags();
  try {
    const value = JSON.parse(read.text) as unknown;
    if (!isRecord(value) || value["schemaVersion"] !== FLAGS_SCHEMA_VERSION || !isRecord(value["entities"])) return emptyFlags();
    const entities: Record<string, FlagEntry> = {};
    for (const [id, entry] of Object.entries(value["entities"])) {
      if (!isRecord(entry) || (entry["status"] !== "flagged" && entry["status"] !== "eligible")) continue;
      entities[id] = entry as unknown as FlagEntry;
    }
    const reconciled: Record<string, string> = {};
    if (isRecord(value["reconciled"])) {
      for (const [id, at] of Object.entries(value["reconciled"])) if (typeof at === "string") reconciled[id] = at;
    }
    return { schemaVersion: FLAGS_SCHEMA_VERSION, entities, reconciled };
  } catch {
    return emptyFlags();
  }
}

/** Every entity that currently reads "changed, re-check". */
export function loadFlaggedIds(localDir: string): ReadonlySet<string> {
  return new Set(Object.keys(loadFlags(localDir).entities));
}

function bounded(flags: FlagsFile): FlagsFile {
  const byAge = <T>(entries: Array<[string, T]>, when: (value: T) => string): Array<[string, T]> =>
    entries.sort((a, b) => (when(a[1]) < when(b[1]) ? -1 : 1));
  const entities = Object.entries(flags.entities);
  if (entities.length > MAX_FLAGGED_ENTITIES) {
    flags.entities = Object.fromEntries(byAge(entities, (e) => e.updatedAt).slice(-MAX_FLAGGED_ENTITIES));
  }
  const reconciled = Object.entries(flags.reconciled);
  if (reconciled.length > MAX_RECONCILED) {
    flags.reconciled = Object.fromEntries(byAge(reconciled, (at) => at).slice(-MAX_RECONCILED));
  }
  return flags;
}

/**
 * Read, change and write the flags in one short step. The settle worker and a
 * Stop hook can run at the same time, so neither keeps a copy across a slow
 * operation: each applies its own change to whatever is on disk.
 */
export function mutateFlags(localDir: string, change: (flags: FlagsFile) => void): FlagsFile {
  const flags = loadFlags(localDir);
  change(flags);
  bounded(flags);
  writeTextAtomic(localDir, flagsPathOf(localDir), `${JSON.stringify(flags)}\n`);
  return flags;
}
