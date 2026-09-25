import { readFileSync } from "node:fs";
import { relative } from "node:path";
import type { DriftIssue, Grounding, ScaffoldFrontmatter } from "../../types.js";
import { deserializeFingerprint, serializeFingerprint } from "../../graph/fingerprint.js";
import type { GraphEngine } from "../../graph/engine.js";
import type { GroundedSource, GroundingChecker } from "../../graph/grounding.js";
import type { Fingerprint, Reconciler, Resolution } from "../../graph/reconcile.js";
import { observeCommittedGroundings, type CommittedGrounding } from "../../committed-groundings.js";
import { extractGroundings, findMexAnchors } from "../../markdown.js";

interface GroundingReconcilerCapabilities {
  getGroundedSource?(scaffoldFile: string, nodeId: string): GroundedSource | null;
  getFingerprint?(nodeId: string): Fingerprint | null;
  /** The reconciler may take the committed body hash as a tie-breaker (#229). */
  reconcile(missingNodeId: string, baseline: Fingerprint, bodyHash?: string): Resolution;
}

/** What a snapshot stale only by changed source can still say about one node (#228). */
export type SourceDriftResolution =
  /** The node's body as a refresh would record it: from the snapshot when its
   *  file is unchanged, or re-derived exactly from the edited file. */
  | { kind: "current"; bodyHash: string | undefined }
  /** Only a refresh can settle this node; `reason` says why. */
  | { kind: "unverified"; reason: string };

/**
 * Grounding against a graph whose only fault is that source files changed.
 * Supplied by the read-only runtime, which owns the exhaustive drifted-path set.
 */
export interface SourceDriftGrounding {
  resolve(nodeId: string): SourceDriftResolution;
}

export function makeGroundingChecker(
  graph: GraphEngine,
  reconciler: Reconciler,
  sourceDrift?: SourceDriftGrounding,
): GroundingChecker {
  const capabilities = reconciler as Reconciler & GroundingReconcilerCapabilities;

  return function checkGrounding(
    frontmatter: ScaffoldFrontmatter | null,
    filePath: string,
    source: string,
    projectRoot: string,
    _scaffoldRoot: string,
  ): DriftIssue[] {
    const scaffoldFile = relative(projectRoot, filePath).replaceAll("\\", "/");
    const issues: DriftIssue[] = [];

    let content: string | null;
    try { content = readFileSync(filePath, "utf-8"); } catch { content = null; }

    // **Read through `extractGroundings`, which knows both key paths.**
    //
    // A pre-wiki scaffold keeps `grounds_to` at the frontmatter root. Once
    // `wiki migrate` adopts a file as an entity, §13.4 moves the key under the
    // `mex` map — and reading the root key directly, as this did, then finds
    // nothing. The loop ran zero times and the checker reported no grounding
    // issues at all: not stale, not missing, not gone. Measured on a migrated
    // scaffold with a fresh graph and four groundings in one file, `mex check`
    // returned zero `GROUNDING_*` codes of any kind.
    //
    // That is silent, and it is worse than a false positive, because a
    // scaffold that checks clean is one nobody looks at. `extractGroundings`
    // reads both keys, because the same silence came back through a file that
    // carries a root `grounds_to` beside a `mex:` map (#226); the writer folds
    // the two into one. The frontmatter value is the fallback for a file that
    // cannot be re-read here, which is the only case the old path still covers.
    const declared = content === null ? (frontmatter?.grounds_to ?? []) : extractGroundings(content);
    // Taken before the loop below rebinds MOVED entries in place.
    const committedHere = committedBaselines(declared.filter(isGrounding));

    for (const grounding of declared) {
      if (!isGrounding(grounding)) continue;
      const current = graph.getNode(grounding.node);
      const baselineSource = capabilities.getGroundedSource?.(scaffoldFile, grounding.node) ?? null;
      if (sourceDrift) {
        // **A stale snapshot never reconciles.** Rename and move detection
        // compares fingerprints across the whole corpus, and the corpus this
        // snapshot describes is no longer the working tree. A node that looks
        // gone may have moved into an edited file, so nothing here is reported
        // GONE, MOVED or AMBIGUOUS: what cannot be settled is UNVERIFIED, and
        // a definite DRIFT comes only from a body hash a refresh would record.
        const resolution = sourceDrift.resolve(grounding.node);
        if (resolution.kind === "unverified") {
          issues.push(issue("GROUNDING_UNVERIFIED", "warning", source,
            `Grounded node cannot be verified until \`mex graph refresh\`: ${grounding.node} (${resolution.reason})`));
          continue;
        }
        const baselineBodyHash = grounding.bodyHash ?? baselineSource?.bodyHash;
        if (baselineBodyHash !== undefined && resolution.bodyHash !== baselineBodyHash) {
          issues.push(issue("GROUNDING_DRIFT", "warning", source,
            `Grounded node body changed: ${grounding.node}`));
        }
        continue;
      }
      if (current) {
        // **The committed hash wins, and the cached one is only a fallback.**
        //
        // `_mex_grounded_source` lives in `.mex/graph.db`, which is gitignored
        // and disposable by invariant — `mex graph rebuild` is offered as a
        // routine repair. Reading the baseline only from there meant a rebuild
        // silently ended drift detection for every grounding in the scaffold:
        // `baselineSource` came back null, this branch reported nothing, and
        // the grounding went on looking healthy forever. A teammate who cloned
        // never had a baseline in the first place.
        //
        // So prefer `grounding.bodyHash`, which is in Git. The cache still
        // answers for a grounding authored before that field existed, which is
        // exactly the pre-existing behaviour and no worse than it was.
        const baselineBodyHash = grounding.bodyHash ?? baselineSource?.bodyHash;
        if (baselineBodyHash !== undefined && current.bodyHash !== baselineBodyHash) {
          issues.push(issue("GROUNDING_DRIFT", "warning", source,
            `Grounded node body changed: ${grounding.node}`));
        }
        continue;
      }

      const baseline = deserializeFingerprint(grounding.fingerprint)
        ?? (baselineSource ? deserializeFingerprint(baselineSource.fingerprint) : null);
      if (!baseline) continue;
      const baselineBodyHash = grounding.bodyHash ?? baselineSource?.bodyHash;
      const resolution = capabilities.reconcile(grounding.node, baseline, baselineBodyHash);
      if (resolution.kind === "MOVED") {
        const moved = graph.getNode(resolution.nodeId);
        if (moved && baselineBodyHash !== undefined && moved.bodyHash !== baselineBodyHash) {
          issues.push(issue("GROUNDING_DRIFT", "warning", source,
            `Grounded node body changed: ${grounding.node}; candidate: ${resolution.nodeId}`));
        }
        grounding.node = resolution.nodeId;
        const movedFingerprint = capabilities.getFingerprint?.(resolution.nodeId);
        if (movedFingerprint) grounding.fingerprint = serializeFingerprint(movedFingerprint);
      } else if (resolution.kind === "AMBIGUOUS") {
        issues.push(issue("GROUNDING_AMBIGUOUS", "warning", source,
          `Grounded node may have moved: ${grounding.node}; candidate: ${resolution.candidate}`));
      } else {
        issues.push(issue("GROUNDING_GONE", "error", source,
          `Grounded node no longer exists: ${grounding.node}`));
      }
    }

    if (content === null) return issues;

    const elsewhere = committedElsewhere(projectRoot, scaffoldFile);
    const anchorBaseline = (nodeId: string) => resolveAnchorBaseline({
      current: capabilities.getFingerprint?.(nodeId) ?? null,
      here: committedHere.get(nodeId),
      elsewhere: () => elsewhere(nodeId),
      cached: capabilities.getGroundedSource?.(scaffoldFile, nodeId) ?? null,
    });

    for (const anchor of findMexAnchors(content)) {
      if (sourceDrift) {
        const resolution = sourceDrift.resolve(anchor.nodeId);
        if (resolution.kind === "unverified") {
          issues.push(issue("GROUNDING_UNVERIFIED", "warning", source,
            `Inline anchor cannot be verified until \`mex graph refresh\`: ${anchor.nodeId} (${resolution.reason})`));
        }
        continue;
      }
      if (graph.getNode(anchor.nodeId)) continue;
      const baseline = anchorBaseline(anchor.nodeId);
      if (baseline === "conflict") {
        issues.push(issue("GROUNDING_AMBIGUOUS", "warning", source,
          `Inline anchor has conflicting committed fingerprints in other scaffold files: ${anchor.nodeId}`));
        continue;
      }
      if (!baseline) {
        issues.push(issue("GROUNDING_GONE", "warning", source,
          `Inline anchor points to an unavailable node: ${anchor.nodeId}`));
        continue;
      }
      const resolution = capabilities.reconcile(anchor.nodeId, baseline.fingerprint, baseline.bodyHash);
      if (resolution.kind === "MOVED") {
        issues.push(issue("GROUNDING_DRIFT", "warning", source,
          `Inline anchor should move: ${anchor.nodeId}; candidate: ${resolution.nodeId}`));
      } else if (resolution.kind === "AMBIGUOUS") {
        issues.push(issue("GROUNDING_AMBIGUOUS", "warning", source,
          `Inline anchor may have moved: ${anchor.nodeId}; candidate: ${resolution.candidate}`));
      } else {
        issues.push(issue("GROUNDING_GONE", "warning", source,
          `Inline anchor points to a deleted node: ${anchor.nodeId}`));
      }
    }
    return issues;
  };
}

/** What a missing node is reconciled from: a fingerprint, and the committed body hash when known. */
export interface MissingNodeBaseline {
  fingerprint: Fingerprint;
  bodyHash?: string;
}

/** Where an inline anchor's baseline can come from, most direct first. */
export interface AnchorBaselineSources {
  /** The node's fingerprint in the current graph (or a snapshot taken before a rebuild). */
  current: Fingerprint | null;
  /** The committed `grounds_to` entry for the node in the anchor's own file. */
  here: MissingNodeBaseline | undefined;
  /** Committed entries for the node in other scaffold files; read only when needed. */
  elsewhere: () => readonly CommittedGrounding[];
  /** The local `_mex_grounded_source` cache. */
  cached: GroundedSource | null;
}

/**
 * **An anchor's baseline, most direct evidence first (#229).**
 *
 * The current graph, then this file's committed `grounds_to` entry for the
 * node, then a committed entry in any other scaffold file, then the local
 * cache. Anchors used to read only the graph and the cache, so on a fresh
 * build an anchor had no baseline and read GONE while the `grounds_to` entry
 * for the same node, in the same run, reconciled MOVED. Committed entries in
 * other files that disagree about the fingerprint are not chosen between:
 * that is `"conflict"`, which callers report as AMBIGUOUS.
 *
 * Shared by `check` and `sync`, so both read an anchor the same way.
 */
export function resolveAnchorBaseline(sources: AnchorBaselineSources): MissingNodeBaseline | "conflict" | null {
  const { current, here, cached } = sources;
  if (current) return { fingerprint: current, ...bodyHashOf(here?.bodyHash ?? cached?.bodyHash) };
  if (here) return here;
  const elsewhere = sources.elsewhere().filter((entry) => deserializeFingerprint(entry.fingerprint) !== null);
  if (new Set(elsewhere.map((entry) => entry.fingerprint)).size > 1) return "conflict";
  const [first] = elsewhere;
  if (first) {
    const agreed = new Set(elsewhere.map((entry) => entry.bodyHash)).size === 1;
    return {
      fingerprint: deserializeFingerprint(first.fingerprint)!,
      ...bodyHashOf(agreed ? first.bodyHash : undefined),
    };
  }
  const fingerprint = cached ? deserializeFingerprint(cached.fingerprint) : null;
  return fingerprint ? { fingerprint, ...bodyHashOf(cached!.bodyHash) } : null;
}

/** A file's own committed entries as baselines, by node; the first entry for a node wins. */
export function committedBaselines(groundings: readonly Grounding[]): Map<string, MissingNodeBaseline> {
  const baselines = new Map<string, MissingNodeBaseline>();
  for (const grounding of groundings) {
    const fingerprint = deserializeFingerprint(grounding.fingerprint);
    if (fingerprint && !baselines.has(grounding.node)) {
      baselines.set(grounding.node, { fingerprint, ...bodyHashOf(grounding.bodyHash) });
    }
  }
  return baselines;
}

/**
 * Committed entries for a node in scaffold files other than `scaffoldFile`.
 * The returned lookup reads the scaffold at most once, and only when an anchor
 * gets that far, through the contained, bounded reader `impact` uses (#224).
 * It is made per checked file, so it never outlives the Markdown it read.
 */
export function committedElsewhere(
  projectRoot: string,
  scaffoldFile: string,
): (nodeId: string) => CommittedGrounding[] {
  let byNode: Map<string, CommittedGrounding[]> | undefined;
  return (nodeId) => {
    if (!byNode) {
      byNode = new Map();
      for (const entry of observeCommittedGroundings(projectRoot).groundings) {
        if (entry.file === scaffoldFile) continue;
        byNode.set(entry.node, [...(byNode.get(entry.node) ?? []), entry]);
      }
    }
    return byNode.get(nodeId) ?? [];
  };
}

function bodyHashOf(bodyHash: string | undefined): { bodyHash?: string } {
  return bodyHash === undefined ? {} : { bodyHash };
}

function isGrounding(value: unknown): value is Grounding {
  if (!value || typeof value !== "object") return false;
  const grounding = value as Partial<Grounding>;
  return typeof grounding.node === "string" && typeof grounding.fingerprint === "string";
}

function issue(
  code: DriftIssue["code"],
  severity: DriftIssue["severity"],
  file: string,
  message: string,
): DriftIssue {
  return { code, severity, file, line: null, message };
}
