/**
 * Finding the entity an operation is about — **index as hint, filesystem as truth.**
 *
 * §11.3 step 2 says "resolve the target index and source file", and §3.8 of the
 * brief says applying with no `wiki.db` is the normal case rather than an error.
 * Both are true, and together they say something the spec does not: **the index
 * cannot be the authority here.** Nothing in production builds one, so a
 * pipeline that needed one would be a pipeline that never runs; and a stale one
 * is worse than none, because it answers confidently and wrongly.
 *
 * The current-filesystem claimant view deliberately does not consult the index.
 * A caller that has to distinguish one claimant from duplicate ownership must
 * inspect the complete bounded corpus: an index hit can prove that one file used
 * to claim an id, but cannot prove that another current file does not claim it.
 * The answer is therefore identical with a fresh index, a stale index, and no
 * index at all.
 *
 * **The winner rule is shared, not re-derived.** A duplicate id is a state the
 * index is built to hold (finding 31): both claimants are stored and all but
 * `MIN(entity_key)` are flagged `shadowed`. `entity_key` is
 * `<file>#<zero-padded metadata_start>`, so the winner is the earliest position
 * in the earliest path. The filesystem scan orders candidates by the same key,
 * through the same `entityKeyOf`, because a locator that picked a different
 * claimant than the index reports would target the entity the user cannot see.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { EntityMetadataKind, ParsedFile } from "../markdown/contract.js";
import { parseWikiMarkdown } from "../markdown/codec.js";
import { parseDocument, type RawDocument } from "../markdown/parse.js";
import type { WikiEntity, EntityTypeRegistry } from "../model/entity.js";
import { discoverMarkdownFiles } from "../index/discover.js";
import { entityKeyOf } from "../index/write.js";
import { readContainedSource } from "../index/source-read.js";
import {
  WikiCorpusLimitError,
  addWikiCorpusBytes,
} from "../index/corpus-policy.js";

export const WIKI_PARSE_CACHE_LIMITS = Object.freeze({
  maxEntries: 256,
  maxSourceBytes: 32 * 1024 * 1024,
} as const);

export interface LocatedEntity {
  /** Scaffold-relative POSIX path. */
  path: string;
  absolutePath: string;
  /** The file text exactly as read. */
  text: string;
  parsed: ParsedFile;
  entity: WikiEntity;
  metadataKind: EntityMetadataKind;
  /** `<file>#<padded metadata_start>`, the same key the index stores. */
  entityKey: string;
}

/**
 * A parse cache for one batch run — **keyed on the bytes, never on time.**
 *
 * `locateEntity` walks and re-parses the scaffold for every operation. Sixty-five
 * operations over twenty-five files is sixteen hundred parses of the same
 * unchanged prose, and it is why five migration tests time out at vitest's
 * default five seconds.
 *
 * The obvious cache — remember a file until something writes it — buys the
 * speed by taking on an invalidation policy, and an invalidation policy is a
 * thing that can be wrong. P5's guarantee is that locate's answer is identical
 * with a fresh index, a stale index and no index at all, because every fact
 * comes from the current bytes; a cache that hands back yesterday's parse after
 * a write turns that into a lie, silently, in the layer that decides what gets
 * written into a user's files.
 *
 * So this one still reads the file every time and caches only the **parse**,
 * under the exact text it was parsed from. A hit requires the bytes on disk to
 * be byte-for-byte what produced the cached tree, so there is no invalidation
 * to get wrong: a write changes the text, the text no longer matches, and the
 * file is re-parsed. Reading is a `readFileSync` of a few kilobytes; parsing is
 * remark plus binding plus model validation, and it is the cost that matters.
 *
 * Passing no cache leaves the behaviour exactly as it was.
 */
export interface ParseCache {
  entries: Map<string, Map<string, ParsedFile>>;
  /**
   * Raw-AST parses, under the same byte-equality rule.
   *
   * `parseDocument` is a second remark pass over the same text — migration's
   * inventory takes one of each per file — and it is worth remembering for the
   * same reason and on the same terms.
   */
  documents: Map<string, Map<string, RawDocument>>;
  /** Parses avoided. Reported by the migration run and asserted by its tests. */
  hits: number;
  /** Parses performed through this cache. */
  misses: number;
  /** @internal Combined FIFO bound across semantic and raw-document parses. */
  order: Array<{
    kind: "entry" | "document";
    key: string;
    text: string;
    bytes: number;
  }>;
  /** @internal UTF-8 source bytes currently retained as cache keys. */
  sourceBytes: number;
}

/** A fresh cache. One per run; never shared between runs, and never global. */
export function createParseCache(): ParseCache {
  return {
    entries: new Map(),
    documents: new Map(),
    hits: 0,
    misses: 0,
    order: [],
    sourceBytes: 0,
  };
}

export interface LocateOptions {
  scaffoldRoot: string;
  /** Retained for caller compatibility; current claimant resolution never trusts it. */
  indexPath?: string;
  exclude?: readonly string[];
  registry?: EntityTypeRegistry;
  readFile?: (absolutePath: string) => string;
  /**
   * Reuse a parse when the file's bytes are unchanged. See {@link ParseCache}.
   *
   * Scoped to one batch run by the caller that creates it. There is no module
   * state here on purpose: a cache that outlived its run would be a cache
   * nobody could reason about from a call site.
   */
  parseCache?: ParseCache;
  /**
   * Look here first, ahead of the index and the walk.
   *
   * Replay's seam. A `move-entry` interrupted between its two renames leaves
   * the entity in **both** files, and the ordinary winner rule — the earliest
   * position in the earliest path — would then pick whichever of the two sorts
   * first, which is the destination about half the time. Resuming the move
   * would then read as "already in that file" and stop with the duplicate
   * still there. The intent line records where the entity started, so a resume
   * pins the locator to it and the move finishes the way it began.
   */
  preferFile?: string;
  /**
   * Files an earlier operation of the same batch creates, by absolute path,
   * as that operation leaves them. Planning only: a later operation of the
   * batch writes into the created file rather than into an empty one.
   */
  virtualFiles?: ReadonlyMap<string, string>;
}

/** Read and parse one scaffold file, or null when it cannot be read. */
export function readParsed(
  options: LocateOptions,
  path: string,
  absolutePath: string,
): { text: string; parsed: ParsedFile } | null {
  let text: string;
  try {
    text = readContainedSource(
      options.scaffoldRoot,
      absolutePath,
      options.readFile === undefined ? {} : { readFile: options.readFile },
    );
  } catch (error) {
    if (error instanceof WikiCorpusLimitError) throw error;
    return null;
  }
  return { text, parsed: parseCached(options, path, absolutePath, text) };
}

/**
 * Parse `text` as the file at `absolutePath`, reusing a cached tree when the
 * text is byte-for-byte the text that tree was parsed from.
 *
 * Provenance of the cached tree is deliberately irrelevant: `parseWikiMarkdown`
 * is a pure function of `(path, text, registry)`, so a hit on all three returns
 * the tree the caller would have computed. That is what lets `verifyPlan` store
 * its parse of a plan's *proposed* text — which becomes the file's bytes a
 * moment later, so the next operation to read that file gets a hit instead of
 * re-parsing what this process just parsed.
 */
export function parseCached(
  options: LocateOptions,
  path: string,
  absolutePath: string,
  text: string,
): ParsedFile {
  const cache = options.parseCache;
  let byText: Map<string, ParsedFile> | undefined;
  if (cache !== undefined) {
    const key = cacheKey(absolutePath, path, options.registry);
    byText = cache.entries.get(key);
    if (byText === undefined) {
      byText = new Map();
      cache.entries.set(key, byText);
    }
    const hit = byText.get(text);
    if (hit !== undefined) {
      cache.hits += 1;
      return hit;
    }
  }

  const parsed = parseWikiMarkdown(
    options.registry === undefined ? { path, text } : { path, text, registry: options.registry },
  );
  if (byText !== undefined && cache !== undefined) {
    cache.misses += 1;
    rememberParse(cache, "entry", cacheKey(absolutePath, path, options.registry), text, parsed);
  }
  return parsed;
}

/**
 * Registries are compared by identity, which is enough and is deliberate: two
 * different registry objects may describe the same types, and treating them as
 * interchangeable would be a judgement about equality that nothing else here
 * makes. A duplicate parse is the cost of being wrong in the safe direction.
 */
const registryIds = new WeakMap<object, number>();
let nextRegistryId = 0;

function registryKey(registry: EntityTypeRegistry | undefined): string {
  if (registry === undefined) return "-";
  let id = registryIds.get(registry as unknown as object);
  if (id === undefined) {
    id = (nextRegistryId += 1);
    registryIds.set(registry as unknown as object, id);
  }
  return String(id);
}

/**
 * The whole identity of a parse: where the file is, what it is called, what it
 * held, and which registry read it.
 *
 * The text is part of the key rather than a field compared against one
 * remembered entry, and that is the correction that made the cache worth
 * having. A one-entry-per-path cache thrashes on exactly this pipeline's
 * access pattern: `verifyPlan` parses the proposed text, `revalidate` then
 * re-reads the base text still on disk and evicts it, and the write that lands
 * a moment later leaves the next operation re-parsing the very tree this
 * process built. Keyed by content, both live side by side and neither evicts
 * the other.
 *
 * The separator is U+0000, escaped rather than written literally — a literal
 * one makes the file binary to Git (finding 45). It cannot occur in a path and
 * cannot be produced by a Markdown decode, so no two distinct parses collide.
 */
function cacheKey(absolutePath: string, path: string, registry: EntityTypeRegistry | undefined): string {
  return `${absolutePath}\u0000${path}\u0000${registryKey(registry)}`;
}

function located(
  path: string,
  absolutePath: string,
  text: string,
  parsed: ParsedFile,
  claimant: { entity: WikiEntity; kind: EntityMetadataKind },
): LocatedEntity {
  return {
    path,
    absolutePath,
    text,
    parsed,
    entity: claimant.entity,
    metadataKind: claimant.kind,
    entityKey: entityKeyOf(path, claimant.entity.location.metadataStart),
  };
}

/**
 * Bounded current-filesystem ownership for one entity id.
 *
 * `claimantCount` is deliberately saturating: `2` means "two or more". The
 * consumer needs to distinguish absent, uniquely owned, and ambiguous; retaining
 * or reporting every duplicate would turn corrupt input into an unbounded result.
 * The full bounded corpus is still scanned even after the count saturates so a
 * later corpus-limit violation cannot be hidden by an earlier claimant.
 */
export interface LocatedEntityClaimants {
  winner: LocatedEntity | null;
  claimantCount: 0 | 1 | 2;
  ambiguous: boolean;
}

export interface AttestedEntityClaimants extends LocatedEntityClaimants {
  /**
   * Deterministic evidence for at most three claimants. Two is the largest
   * valid recovery set; a third entry is a bounded "three or more" witness.
   */
  claimantEvidence: readonly {
    entityKey: string;
    path: string;
  }[];
}

/**
 * The authoritative claimant view is useful only when every discoverable
 * canonical source was observed. Ordinary locator compatibility still skips an
 * unreadable source, but mutation preflights and apply revalidation use the
 * strict attestation below and fail closed on an incomplete walk.
 */
export class WikiClaimantScanIncompleteError extends Error {
  readonly code = "WIKI_CLAIMANT_SCAN_INCOMPLETE";

  constructor(readonly reason: "discovery" | "read") {
    super("The complete bounded Wiki claimant corpus could not be observed safely.");
    this.name = "WikiClaimantScanIncompleteError";
  }
}

/** Saturating increment for the only claimant cardinalities callers can use safely. */
function incrementClaimantCount(count: 0 | 1 | 2): 1 | 2 {
  return count === 0 ? 1 : 2;
}

function claimantCountIsAmbiguous(count: 0 | 1 | 2): boolean {
  return count === 2;
}

interface ClaimantAccumulator {
  winner: LocatedEntity | null;
  preferredWinner: LocatedEntity | null;
  claimantCount: 0 | 1 | 2;
  claimantEvidence: Array<{ entityKey: string; path: string }>;
}

/**
 * Inspect canonical Markdown bytes for every current claimant of `id`.
 *
 * The deterministic winner is the smallest engine entity key. `preferFile` is
 * the one deliberate exception: operation replay pins a duplicated move residue
 * to the source recorded by its durable intent. Ambiguity always reflects the
 * complete scan, including claimants outside that preferred file.
 */
function scanEntityClaimants(
  id: string,
  options: LocateOptions,
  requireCompleteScan: boolean,
): AttestedEntityClaimants {
  return scanEntityClaimantSet([id], options, requireCompleteScan).get(id)!;
}

/** One bounded discovery/read/parse pass for an exact requested ID set. */
function scanEntityClaimantSet(
  ids: readonly string[],
  options: LocateOptions,
  requireCompleteScan: boolean,
): ReadonlyMap<string, AttestedEntityClaimants> {
  const requested = [...new Set(ids)];
  const accumulators = new Map<string, ClaimantAccumulator>(requested.map((id) => [id, {
    winner: null,
    preferredWinner: null,
    claimantCount: 0,
    claimantEvidence: [],
  }]));
  if (requested.length === 0) return new Map();
  const root = resolve(options.scaffoldRoot);
  let corpusBytes = 0;
  const countedPaths = new Set<string>();
  const scannedAbsolutePaths = new Set<string>();

  const account = (path: string, text: string): void => {
    if (countedPaths.has(path)) return;
    corpusBytes = addWikiCorpusBytes(corpusBytes, Buffer.byteLength(text, "utf8"));
    countedPaths.add(path);
  };
  const inspect = (
    path: string,
    absolutePath: string,
    preferred: boolean,
    discovered: boolean,
  ): void => {
    const absolute = resolve(absolutePath);
    if (scannedAbsolutePaths.has(absolute)) return;
    const read = readParsed(options, path, absolute);
    if (read === null) {
      if (requireCompleteScan && discovered) {
        throw new WikiClaimantScanIncompleteError("read");
      }
      // Preserve the tolerant locator's historical single-attempt behavior.
      // Strict attestation deliberately retries a failed optional replay hint
      // when canonical discovery later proves that path is mandatory.
      if (!requireCompleteScan) scannedAbsolutePaths.add(absolute);
      return;
    }
    scannedAbsolutePaths.add(absolute);
    account(path, read.text);
    for (const parsed of read.parsed.entities) {
      const accumulator = accumulators.get(parsed.entity.id);
      if (accumulator === undefined) continue;
      const candidate = located(path, absolute, read.text, read.parsed, {
        entity: parsed.entity,
        kind: parsed.metadataKind,
      });
      accumulator.claimantCount = incrementClaimantCount(accumulator.claimantCount);
      if (accumulator.claimantEvidence.length < 3) {
        accumulator.claimantEvidence.push({
          entityKey: candidate.entityKey,
          path: candidate.path,
        });
      }
      if (accumulator.winner === null || candidate.entityKey < accumulator.winner.entityKey) {
        accumulator.winner = candidate;
      }
      if (preferred && (
        accumulator.preferredWinner === null
        || candidate.entityKey < accumulator.preferredWinner.entityKey
      )) {
        accumulator.preferredWinner = candidate;
      }
    }
  };

  if (options.preferFile !== undefined) {
    // A replay hint may name a source that an interrupted move already removed.
    // Only files returned by canonical discovery are mandatory observations.
    inspect(options.preferFile, resolve(root, options.preferFile), true, false);
  }

  const discovery = discoverMarkdownFiles({ root, exclude: options.exclude });
  if (requireCompleteScan && discovery.diagnostics.length > 0) {
    throw new WikiClaimantScanIncompleteError("discovery");
  }
  for (const file of discovery.files) inspect(file.path, file.absolutePath, false, true);

  return new Map([...accumulators].map(([id, accumulator]) => [id, {
    winner: accumulator.preferredWinner ?? accumulator.winner,
    claimantCount: accumulator.claimantCount,
    ambiguous: claimantCountIsAmbiguous(accumulator.claimantCount),
    claimantEvidence: accumulator.claimantEvidence,
  }]));
}

export function locateEntityClaimants(id: string, options: LocateOptions): LocatedEntityClaimants {
  const scanned = scanEntityClaimants(id, options, false);
  return {
    winner: scanned.winner,
    claimantCount: scanned.claimantCount,
    ambiguous: scanned.ambiguous,
  };
}

/**
 * Complete bounded claimant attestation for optimistic mutation boundaries.
 * Unlike the compatibility locator, this never turns an unreadable or
 * diagnostically incomplete corpus into a trusted absence/unique answer.
 */
export function attestEntityClaimants(id: string, options: LocateOptions): AttestedEntityClaimants {
  return scanEntityClaimants(id, options, true);
}

/**
 * Complete bounded claimant attestation for several IDs in one corpus pass.
 * The caller retains the surrounding before/after corpus lease.
 */
export function attestEntityClaimantsBatch(
  ids: readonly string[],
  options: LocateOptions,
): ReadonlyMap<string, AttestedEntityClaimants> {
  return scanEntityClaimantSet(ids, options, true);
}

/**
 * Locate the entity `id` names, or null when the scaffold does not hold it.
 *
 * Never writes. Unreadable files are skipped, while a corpus safety-limit
 * violation is surfaced so callers cannot trust a partial scan.
 */
export function locateEntity(id: string, options: LocateOptions): LocatedEntity | null {
  return scanEntityClaimants(id, options, false).winner;
}

export interface LocatedFile {
  path: string;
  absolutePath: string;
  /** The file's text, or `""` when the operation is creating it. */
  text: string;
  parsed: ParsedFile;
  existed: boolean;
}

/**
 * Read and parse a target file for a write that may be creating it.
 *
 * Null means the file **exists and could not be read**, which is the one case
 * that must not be treated as "absent, so create it" — that would overwrite a
 * document whose contents nobody could see.
 */
export function locateFile(options: LocateOptions, path: string): LocatedFile | null {
  const absolutePath = resolve(resolve(options.scaffoldRoot), path);
  const created = existsSync(absolutePath) ? undefined : options.virtualFiles?.get(absolutePath);
  if (created !== undefined) {
    // Created earlier in this batch: it exists in the overlay the plan chains on.
    return { path, absolutePath, text: created, parsed: parseCached(options, path, absolutePath, created), existed: true };
  }
  if (!existsSync(absolutePath)) {
    return { path, absolutePath, text: "", parsed: parseWikiMarkdown({ path, text: "" }), existed: false };
  }
  const read = readParsed(options, path, absolutePath);
  if (read === null) return null;
  return { path, absolutePath, text: read.text, parsed: read.parsed, existed: true };
}

/** {@link parseDocument}, memoized on the file's own bytes. See {@link ParseCache}. */
export function parseDocumentCached(cache: ParseCache | undefined, absolutePath: string, text: string): RawDocument {
  let byText: Map<string, RawDocument> | undefined;
  if (cache !== undefined) {
    byText = cache.documents.get(absolutePath);
    if (byText === undefined) {
      byText = new Map();
      cache.documents.set(absolutePath, byText);
    }
    const hit = byText.get(text);
    if (hit !== undefined) {
      cache.hits += 1;
      return hit;
    }
  }
  const document = parseDocument(text);
  if (byText !== undefined && cache !== undefined) {
    cache.misses += 1;
    rememberParse(cache, "document", absolutePath, text, document);
  }
  return document;
}

function rememberParse<T extends ParsedFile | RawDocument>(
  cache: ParseCache,
  kind: "entry" | "document",
  key: string,
  text: string,
  value: T,
): void {
  const target = kind === "entry" ? cache.entries : cache.documents;
  const byText = target.get(key) as Map<string, T> | undefined;
  if (byText === undefined) throw new Error("The Wiki parse cache key was not initialized.");
  byText.set(text, value);
  const bytes = Buffer.byteLength(text, "utf8");
  cache.order.push({ kind, key, text, bytes });
  cache.sourceBytes += bytes;

  while (cache.order.length > WIKI_PARSE_CACHE_LIMITS.maxEntries
    || cache.sourceBytes > WIKI_PARSE_CACHE_LIMITS.maxSourceBytes) {
    const oldest = cache.order.shift();
    if (!oldest) break;
    const collection = oldest.kind === "entry" ? cache.entries : cache.documents;
    const values = collection.get(oldest.key);
    if (values?.delete(oldest.text)) cache.sourceBytes -= oldest.bytes;
    if (values?.size === 0) collection.delete(oldest.key);
  }
}
