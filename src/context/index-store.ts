/**
 * Loading, validating and (lazily) rebuilding `.mex/local/context-index.json`.
 *
 * Reads are bounded and tolerant: a missing, oversized, corrupt or
 * incompatible file is "no index", never an exception, because a hook must
 * degrade to silence rather than break an agent session. Rebuilding is
 * explicit (`mex context index`) or lazy on the prompt path, and in both cases
 * it only ever replaces this one derived file, atomically.
 */

import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AliasOverlay } from "./build-index.js";
import { openGraphReader } from "./graph-reader.js";
import { writeTextAtomic } from "./local-state.js";
import type { ContextRoot } from "./root.js";
import { CONTEXT_INDEX_SCHEMA_VERSION, type ContextDiagnostic, type ContextIndex } from "./types.js";
import { listWikiMarkdown, observeWikiMarkdown, type WikiListing, type WikiObservation } from "./wiki-source.js";

/** Largest index or overlay file the composer will read. */
export const MAX_INDEX_BYTES = 64 * 1024 * 1024;
export const MAX_OVERLAY_BYTES = 1024 * 1024;

export const indexPathOf = (localDir: string): string => join(localDir, "context-index.json");
export const aliasOverlayPathOf = (localDir: string): string => join(localDir, "context-aliases.json");

type Bounded = { text: string } | { missing: true } | { missing: false };

function readBounded(path: string, limit: number): Bounded {
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

/**
 * The checkout-local alias overlay: `{ "<entity id>": ["symptom phrase", ...] }`.
 *
 * Authoring writes aliases into the Markdown (`metadata.aliases`); this file
 * lets tooling supply them without touching tracked prose (the parity script
 * uses it to replay a reference alias set).
 */
export function readAliasOverlay(localDir: string): AliasOverlay {
  const read = readBounded(aliasOverlayPathOf(localDir), MAX_OVERLAY_BYTES);
  if (!("text" in read)) return { overlay: {}, digest: null };
  const text = read.text;
  try {
    const value = JSON.parse(text) as unknown;
    const overlay: Record<string, string[]> = {};
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      for (const [id, phrases] of Object.entries(value)) {
        if (Array.isArray(phrases)) overlay[id] = phrases.filter((p): p is string => typeof p === "string" && p.trim() !== "");
      }
    }
    return { overlay, digest: createHash("sha256").update(text).digest("hex") };
  } catch {
    return { overlay: {}, digest: null };
  }
}

/** The cheap half of what an index was derived from: no file is read. */
export interface QuickInputs {
  listing: WikiListing;
  graphIdentity: string | null;
  overlay: AliasOverlay;
}

export function quickInputs(root: ContextRoot): QuickInputs {
  const listing = listWikiMarkdown(root.scaffoldRoot);
  const { reader } = openGraphReader(root.scaffoldRoot);
  let graphIdentity: string | null = null;
  try {
    graphIdentity = reader ? reader.identity() : null;
  } finally {
    reader?.close();
  }
  return { listing, graphIdentity, overlay: readAliasOverlay(root.localDir) };
}

function sameListing(index: ContextIndex, listing: WikiListing): boolean {
  const recorded = index.inputs.wiki.files;
  return (
    recorded.length === listing.files.length
    && recorded.every((file, i) => file.path === listing.files[i]!.path && file.stat === listing.files[i]!.stat)
  );
}

export interface EnsuredIndex {
  index: ContextIndex;
  /** True when this call rebuilt the index rather than reusing a current one. */
  rebuilt: boolean;
  /** True when the rebuilt index could not be written (it is still usable in memory). */
  unsaved: boolean;
  diagnostics: ContextDiagnostic[];
}

export type EnsureMode = "if-stale" | "force";

function trySave(localDir: string, index: ContextIndex, diagnostics: ContextDiagnostic[]): boolean {
  try {
    saveContextIndex(localDir, index);
    return true;
  } catch (error) {
    diagnostics.push({
      code: "CONTEXT_INDEX_MISSING",
      severity: "warning",
      message: `The context index could not be written: ${error instanceof Error ? error.message : String(error)}`,
    });
    return false;
  }
}

/**
 * The current index, rebuilding (and recording) it when its inputs changed.
 *
 * Freshness is decided in two steps. If every Markdown file's size, timestamps
 * and inode match what the index recorded, and the graph snapshot and alias
 * overlay identities match, the index is current and nothing was read. If a file
 * looks touched, its bytes are hashed: an unchanged digest (a `touch`, a
 * checkout that rewrote identical bytes) keeps the index and refreshes only the
 * recorded signatures. `mode: "force"` always reads, hashes and rebuilds.
 */
export async function ensureContextIndex(root: ContextRoot, mode: EnsureMode = "if-stale"): Promise<EnsuredIndex> {
  const loaded = loadContextIndex(root.localDir);
  const quick = quickInputs(root);
  const diagnostics: ContextDiagnostic[] = [...quick.listing.diagnostics];

  const sideInputsCurrent = (index: ContextIndex): boolean =>
    index.inputs.graph.identity === quick.graphIdentity && index.inputs.aliasOverlay === quick.overlay.digest;

  let observation: WikiObservation | undefined;
  if (loaded.index !== null && mode === "if-stale" && sideInputsCurrent(loaded.index)) {
    if (sameListing(loaded.index, quick.listing)) {
      return { index: loaded.index, rebuilt: false, unsaved: false, diagnostics };
    }
    observation = observeWikiMarkdown(root.scaffoldRoot, quick.listing);
    if (observation.digest === loaded.index.inputs.wiki.digest) {
      loaded.index.inputs.wiki.files = observation.files.map(({ path, hash, stat }) => ({ path, hash, stat }));
      trySave(root.localDir, loaded.index, diagnostics);
      return { index: loaded.index, rebuilt: false, unsaved: false, diagnostics: [...diagnostics, ...observation.diagnostics] };
    }
  }

  // The Markdown parser is a heavy import; a current index never needs it.
  const { buildContextIndex } = await import("./build-index.js");
  const built = buildContextIndex(root.scaffoldRoot, {
    observation: observation ?? observeWikiMarkdown(root.scaffoldRoot, quick.listing),
    overlay: quick.overlay,
    previous: loaded.index,
  });
  const unsaved = !trySave(root.localDir, built.index, diagnostics);
  return { index: built.index, rebuilt: true, unsaved, diagnostics: [...diagnostics, ...built.diagnostics] };
}
