/**
 * Incremental refresh — reparse what changed, re-resolve everything by default.
 *
 * The update is the easy half. The hard half is **invalidation**, and it is
 * where an incremental index normally starts lying: deleting a file leaves the
 * relations that pointed into it dangling, and adding a file can *resolve* a
 * reference that has been dangling for weeks. Neither shows up as a crash. It
 * shows up as a confidently wrong answer, months later, to a question nobody
 * thinks to check.
 *
 * Full refresh derives health and set diagnostics from scratch. Apply opts
 * into retaining cached grounding verdicts outside reparsed files; set-level
 * diagnostics still use all rows. `resolveIndexState` is the same function the
 * rebuild calls, over the same rows, so a dangling reference and a resolved one
 * are recomputed on every refresh whether or not the file involved was in the
 * changed set. There is no second resolver to disagree with the first, which is
 * why the determinism test can be expected to hold rather than hoped to.
 *
 * `fileContentHash` decides *whether* to reparse and nothing else (D6). It is a
 * staleness signal, never a correctness precondition: a hash that matches skips
 * work, and a hash that does not match costs a parse. Neither answer can make a
 * wrong row survive, because the row is replaced either way when it is written.
 */

import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { toPosix } from "../../paths.js";
import { diagnostic, type WikiDiagnostic } from "../model/diagnostic.js";
import { exactFileContentHash } from "../model/hash.js";
import type { EntityTypeRegistry } from "../model/entity.js";
import { parseWikiMarkdown } from "../markdown/codec.js";
import type { DiscoveredFile } from "./discover.js";
import { WIKI_CORPUS_LIMITS, WikiCorpusLimitError } from "./corpus-policy.js";
import { openWikiIndex } from "./open.js";
import { defaultIndexPath, unreadableFileDiagnostic } from "./rebuild.js";
import {
  clonePendingIndex,
  discardPendingIndex,
  discardSealedPendingIndex,
  publishSealedPendingIndex,
  sealPendingIndex,
  type SealedPendingIndex,
} from "./publish.js";
import {
  deleteFileRows,
  resolveIndexState,
  writeFileDiagnostics,
  writeParsedFile,
  type GroundingResolver,
} from "./write.js";
import {
  acquireWikiMaintenanceLease,
  assertIndexPath,
  bindIndexGeneration,
  IndexInUseError,
  IndexPublishRecoveryError,
  type IndexGenerationBinding,
  type WikiMaintenanceLease,
} from "./dbfile.js";
import {
  assertWikiCorpusUnchanged,
  assertWikiCorpusFastUnchanged,
  bindWikiCorpusFast,
  maintenanceBoundary,
  observeWikiCorpus,
  type WikiCorpusObservation,
  type WikiCorpusFastBinding,
  type WikiMaintenanceContext,
  WikiPreparedMaintenanceNotPreflightedError,
  WikiPreparedMaintenanceSettledError,
  WikiMaintenanceInterruptedError,
} from "./maintenance.js";

export interface RefreshOptions {
  scaffoldRoot: string;
  indexPath?: string;
  exclude?: readonly string[];
  /**
   * Paths that changed, absolute or scaffold-relative. A path that no longer
   * exists, or that the exclusions now cover, is removed from the index —
   * "changed" includes "gone".
   */
  changed: readonly string[];
  registry?: EntityTypeRegistry;
  now?: () => string;
  /** Injectable file reader. See `RebuildOptions.readFile` for why it exists. */
  readFile?: (absolutePath: string) => string;
  /**
   * How to resolve grounding health, when the caller has a code graph.
   *
   * Optional because the index must build in a checkout that has none — a
   * fresh clone, CI before `mex graph`, a sandbox. Absent, every grounding's
   * verdict column stays NULL, which is what "nothing looked" is stored as.
   *
   * **A rebuild and a refresh must be given the same resolver or neither**, or
   * their dumps differ for a reason that is not a refresh bug: health depends
   * on code, and code changes without the scaffold changing at all.
   */
  resolveGrounding?: GroundingResolver;
  /** Apply-only: all other refresh callers resolve the whole Wiki. */
  targetedGroundings?: boolean;
  /** Cancellation and bounded phase progress for explicit maintenance jobs. */
  maintenance?: WikiMaintenanceContext;
  /** Existing operation/migration lease; prevents self-contention. */
  maintenanceLease?: WikiMaintenanceLease;
}

export type RefreshResult =
  | {
      ok: true;
      reparsed: string[];
      removed: string[];
      /** Present, indexed, and identical to what is already stored. */
      unchanged: string[];
      diagnostics: WikiDiagnostic[];
    }
  | { ok: false; diagnostic: WikiDiagnostic };

export interface PreparedWikiRefresh {
  readonly kind: "refresh";
  /** Exact selected-path preflight; call before the consumer's final Graph check. */
  preflight(): void;
  /** Rename-only publication after a successful preflight. */
  commit(): RefreshResult;
  discard(): void;
}

export type PrepareWikiRefreshResult =
  | { ok: true; prepared: PreparedWikiRefresh }
  | { ok: false; diagnostic: WikiDiagnostic };

/** Normalize a caller's path to the scaffold-relative POSIX form used as a key. */
export function toScaffoldPath(scaffoldRoot: string, path: string): string {
  if (
    path.length === 0
    || path.includes("\0")
    || path.includes("\\")
    || isAbsolute(path)
    || path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) throw new WikiRefreshPathError(path);
  const asRelative = toPosix(relative(scaffoldRoot, resolve(scaffoldRoot, path)));
  if (asRelative === ".." || asRelative.startsWith("../") || asRelative !== path) {
    throw new WikiRefreshPathError(path);
  }
  return asRelative;
}

export class WikiRefreshPathError extends Error {
  readonly code = "PATH_OUTSIDE_SCAFFOLD";
  constructor(readonly path: string) {
    super("Wiki refresh paths must be normalized repository-relative POSIX paths inside the scaffold.");
    this.name = "WikiRefreshPathError";
  }
}

export function prepareWikiRefresh(options: RefreshOptions): PrepareWikiRefreshResult {
  const scaffoldRoot = resolve(options.scaffoldRoot);
  const indexPath = options.indexPath ?? defaultIndexPath(scaffoldRoot);
  const now = options.now ?? (() => new Date().toISOString());

  // Strictly reject direct API path injection before acquiring a writer lease
  // or constructing a candidate.
  if (options.changed.length > WIKI_CORPUS_LIMITS.maxMaintenancePaths) {
    throw new WikiCorpusLimitError("maxMaintenancePaths");
  }
  const targets = [...new Set(options.changed.map((path) => toScaffoldPath(scaffoldRoot, path)))].sort();

  const ownedLease = options.maintenanceLease === undefined;
  const lease = options.maintenanceLease ?? acquireWikiMaintenanceLease(indexPath, "refresh", scaffoldRoot);
  try {
    assertIndexPath(indexPath, lease.binding);
    const inspected = openWikiIndex(indexPath);
    if (!inspected.ok) {
      if (ownedLease) lease.release();
      return { ok: false, diagnostic: inspected.diagnostic };
    }
    inspected.index.close();

    maintenanceBoundary(options.maintenance, "discover");
    // Refresh pins only the explicit changed set. Unrelated concurrent corpus
    // changes leave the result honestly stale instead of blocking a targeted
    // repair; selected additions/removals/bytes must remain exact through
    // preflight.
    const observation = observeWikiCorpus({
      scaffoldRoot,
      ...(options.exclude === undefined ? {} : { exclude: options.exclude }),
      ...(options.readFile === undefined ? {} : { readFile: options.readFile }),
      paths: targets,
    });
    const indexable = new Map<string, DiscoveredFile>(observation.files.map((file) => [file.path, file]));
    const live = bindIndexGeneration(indexPath, lease.binding);

    const reparsed: string[] = [];
    const removed: string[] = [];
    const unchanged: string[] = [];
    const unreadable: WikiDiagnostic[] = [];
    let omittedUnreadable = 0;

    maintenanceBoundary(options.maintenance, "stage");
    let pending: ReturnType<typeof clonePendingIndex>;
    try {
      pending = clonePendingIndex(indexPath, lease.binding);
    } catch (error) {
      if (error instanceof IndexInUseError) {
        if (ownedLease) lease.release();
        return { ok: false, diagnostic: indexInUseDiagnostic(error) };
      }
      throw error;
    }
    if (!pending.ok) {
      if (ownedLease) lease.release();
      return { ok: false, diagnostic: pending.diagnostic };
    }
    const candidate = pending.handle;
    const tempPath = pending.tempPath;
    try {
      candidate.db.transaction(() => {
        const storedHash = candidate.db.prepare(`SELECT content_hash FROM wiki_files WHERE path = ?`);

        maintenanceBoundary(options.maintenance, "parse", { completed: 0, total: targets.length });
        for (let targetIndex = 0; targetIndex < targets.length; targetIndex += 1) {
          const path = targets[targetIndex]!;
          maintenanceBoundary(options.maintenance, "parse", { completed: targetIndex, total: targets.length });
          const file = indexable.get(path);
          if (file === undefined) {
            // Deleted, excluded, or never Markdown. The rows go; the references
            // into them are left to dangle and be reported, not cascaded away.
            deleteFileRows(candidate.db, path);
            removed.push(path);
            continue;
          }

          let text: string;
          try {
            text = observation.readFile(file.absolutePath);
          } catch (error) {
            if (error instanceof WikiCorpusLimitError || error instanceof WikiMaintenanceInterruptedError) throw error;
            // The rows go, and the report stays — attached to this file, so it
            // survives a later refresh of an unrelated one and is cleared by the
            // refresh that finally reads this file successfully. A rebuild
            // derives exactly the same row.
            deleteFileRows(candidate.db, path);
            const entry = unreadableFileDiagnostic(path, error);
            writeFileDiagnostics(candidate.db, path, [entry]);
            if (unreadable.length < WIKI_CORPUS_LIMITS.maxDiagnostics) unreadable.push(entry);
            else omittedUnreadable += 1;
            removed.push(path);
            continue;
          }

          const previous = storedHash.get(path) as { content_hash?: string } | undefined;
          if (previous?.content_hash === exactFileContentHash(text)) {
            unchanged.push(path);
            continue;
          }

          deleteFileRows(candidate.db, path);
          writeParsedFile(
            candidate.db,
            parseWikiMarkdown(
              options.registry === undefined ? { path, text } : { path, text, registry: options.registry },
            ),
            { now: now() },
          );
          reparsed.push(path);
        }
        maintenanceBoundary(options.maintenance, "parse", { completed: targets.length, total: targets.length });

        maintenanceBoundary(options.maintenance, "resolve");
        resolveIndexState(candidate.db, {
          scaffoldRoot,
          buildKind: "refresh",
          now: now(),
          scaffoldDiagnostics: observation.diagnostics,
          resolveGrounding: options.resolveGrounding,
          ...(options.targetedGroundings ? { groundingFiles: reparsed } : {}),
        });
        maintenanceBoundary(options.maintenance, "validate");
      });

      const sealed = sealPendingIndex(candidate, tempPath, lease.binding);
      const diagnostics = [...observation.diagnostics, ...unreadable]
        .slice(0, WIKI_CORPUS_LIMITS.maxDiagnostics);
      const diagnosticCount = observation.diagnostics.length + unreadable.length + omittedUnreadable;
      if (diagnosticCount > diagnostics.length) {
        diagnostics[diagnostics.length - 1] = diagnostic(
          "WIKI_PARSE_ERROR",
          `${diagnosticCount - diagnostics.length + 1} additional Wiki refresh diagnostic(s) were omitted.`,
          {
            severity: "info",
            remediation: "Resolve the visible diagnostics, then refresh again for any remaining issues.",
          },
        );
      }
      return {
        ok: true,
        prepared: preparedRefreshHandle({
          options,
          scaffoldRoot,
          indexPath,
          targets,
          lease,
          ownedLease,
          tempPath,
          sealed,
          live,
          observation,
          summary: {
            ok: true,
            reparsed,
            removed,
            unchanged,
            diagnostics,
          },
        }),
      };
    } catch (error) {
      discardPendingIndex(candidate, tempPath, lease.binding);
      throw error;
    }
  } catch (error) {
    if (ownedLease) lease.release();
    if (error instanceof IndexInUseError) return { ok: false, diagnostic: indexInUseDiagnostic(error) };
    throw error;
  }
}

function preparedRefreshHandle(state: {
  options: RefreshOptions;
  scaffoldRoot: string;
  indexPath: string;
  targets: readonly string[];
  lease: WikiMaintenanceLease;
  ownedLease: boolean;
  tempPath: string;
  sealed: SealedPendingIndex;
  live: IndexGenerationBinding;
  observation: WikiCorpusObservation;
  summary: Extract<RefreshResult, { ok: true }>;
}): PreparedWikiRefresh {
  let settled = false;
  let preflighted = false;
  let fastBinding: WikiCorpusFastBinding | null = null;
  const beginSettlement = (): void => {
    if (settled) throw new WikiPreparedMaintenanceSettledError();
    settled = true;
  };
  const release = (): void => {
    if (state.ownedLease) state.lease.release();
  };
  const discardCandidate = (): void => {
    if (existsSync(state.tempPath)) discardSealedPendingIndex(state.tempPath, state.lease.binding, state.sealed);
  };
  return {
    kind: "refresh",
    preflight: () => {
      if (settled) throw new WikiPreparedMaintenanceSettledError();
      preflighted = false;
      fastBinding = null;
      maintenanceBoundary(state.options.maintenance, "publish");
      const corpusOptions = {
        scaffoldRoot: state.scaffoldRoot,
        ...(state.options.exclude === undefined ? {} : { exclude: state.options.exclude }),
        ...(state.options.readFile === undefined ? {} : { readFile: state.options.readFile }),
        paths: state.targets,
      };
      const before = bindWikiCorpusFast(corpusOptions);
      assertWikiCorpusUnchanged(state.observation, corpusOptions);
      assertWikiCorpusFastUnchanged(before, corpusOptions);
      maintenanceBoundary(state.options.maintenance, "publish");
      fastBinding = before;
      preflighted = true;
    },
    commit: () => {
      if (!preflighted) throw new WikiPreparedMaintenanceNotPreflightedError();
      beginSettlement();
      try {
        if (fastBinding === null) throw new WikiPreparedMaintenanceNotPreflightedError();
        maintenanceBoundary(state.options.maintenance, "publish");
        assertWikiCorpusFastUnchanged(fastBinding, {
          scaffoldRoot: state.scaffoldRoot,
          ...(state.options.exclude === undefined ? {} : { exclude: state.options.exclude }),
          ...(state.options.readFile === undefined ? {} : { readFile: state.options.readFile }),
          paths: state.targets,
        });
        publishSealedPendingIndex(
          state.tempPath,
          state.indexPath,
          state.lease.binding,
          state.sealed,
          state.live,
        );
        return state.summary;
      } catch (error) {
        try {
          discardCandidate();
        } catch (cleanupError) {
          throw new IndexPublishRecoveryError(state.tempPath, state.tempPath, error, cleanupError);
        }
        if (error instanceof IndexInUseError) return { ok: false, diagnostic: indexInUseDiagnostic(error) };
        throw error;
      } finally {
        release();
      }
    },
    discard: () => {
      beginSettlement();
      try {
        discardCandidate();
      } finally {
        release();
      }
    },
  };
}

export function refreshWikiIndex(options: RefreshOptions): RefreshResult {
  const result = prepareWikiRefresh(options);
  if (!result.ok) return result;
  try {
    result.prepared.preflight();
  } catch (error) {
    result.prepared.discard();
    throw error;
  }
  return result.prepared.commit();
}

function indexInUseDiagnostic(error: IndexInUseError): WikiDiagnostic {
  return {
    code: "WIKI_INDEX_REBUILD_REQUIRED",
    severity: "error",
    message: error.message,
    file: error.path,
    remediation: "Close anything holding the index open and retry the explicit Wiki maintenance operation.",
  };
}
