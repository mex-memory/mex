/**
 * Reading and writing the context index file, and nothing else.
 *
 * Split from `index-store.ts` so the hook's tool events (read, edit, grep) can
 * load the index without importing what it takes to *rebuild* one: the Wiki
 * discovery, the configuration loader and the Markdown parser. Reads are
 * bounded and tolerant: a missing, oversized, corrupt or incompatible file is
 * "no index", never an exception, because a hook must degrade to silence
 * rather than break an agent session.
 */

import { closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeTextAtomic } from "./local-state.js";
import { CONTEXT_INDEX_SCHEMA_VERSION, type ContextIndex } from "./types.js";

/** Largest index or overlay file the composer will read. */
export const MAX_INDEX_BYTES = 64 * 1024 * 1024;
export const MAX_OVERLAY_BYTES = 1024 * 1024;

export const indexPathOf = (localDir: string): string => join(localDir, "context-index.json");
export const aliasOverlayPathOf = (localDir: string): string => join(localDir, "context-aliases.json");

export type Bounded = { text: string } | { missing: true } | { missing: false };

export function readBounded(path: string, limit: number): Bounded {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    if (fstatSync(fd).size > limit) return { missing: false };
    return { text: readFileSync(fd, "utf8") };
  } catch (error) {
    return { missing: (error as NodeJS.ErrnoException).code === "ENOENT" };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export type IndexLoad =
  | { index: ContextIndex; state: "ok" }
  | { index: null; state: "missing" | "incompatible" | "unreadable" };

export function loadContextIndex(localDir: string): IndexLoad {
  const read = readBounded(indexPathOf(localDir), MAX_INDEX_BYTES);
  if (!("text" in read)) return { index: null, state: read.missing ? "missing" : "unreadable" };
  try {
    const value = JSON.parse(read.text) as Partial<ContextIndex>;
    if (value.schemaVersion !== CONTEXT_INDEX_SCHEMA_VERSION) return { index: null, state: "incompatible" };
    if (!Array.isArray(value.entities) || value.inputs === undefined || typeof value.vectors !== "object") {
      return { index: null, state: "incompatible" };
    }
    return { index: value as ContextIndex, state: "ok" };
  } catch {
    return { index: null, state: "unreadable" };
  }
}

export function saveContextIndex(localDir: string, index: ContextIndex): void {
  writeTextAtomic(localDir, indexPathOf(localDir), `${JSON.stringify(index)}\n`);
}
