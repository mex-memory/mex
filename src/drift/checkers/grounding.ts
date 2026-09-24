import { readFileSync } from "node:fs";
import { relative } from "node:path";
import type { DriftIssue, Grounding, ScaffoldFrontmatter } from "../../types.js";
import { deserializeFingerprint, serializeFingerprint } from "../../graph/fingerprint.js";
import type { GraphEngine } from "../../graph/engine.js";
import type { GroundedSource, GroundingChecker } from "../../graph/grounding.js";
import type { Fingerprint, Reconciler } from "../../graph/reconcile.js";
import { extractGroundings, findMexAnchors } from "../../markdown.js";

interface GroundingReconcilerCapabilities {
  getGroundedSource?(scaffoldFile: string, nodeId: string): GroundedSource | null;
  getFingerprint?(nodeId: string): Fingerprint | null;
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
    // resolves the key path the same way the writer does, so the two ends
    // agree; the frontmatter value is the fallback for a file that cannot be
    // re-read here, which is the only case the old path still covers.
    const declared = content === null ? (frontmatter?.grounds_to ?? []) : extractGroundings(content);

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
      const resolution = reconciler.reconcile(grounding.node, baseline);
      if (resolution.kind === "MOVED") {
        const moved = graph.getNode(resolution.nodeId);
        const baselineBodyHash = grounding.bodyHash ?? baselineSource?.bodyHash;
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
      const baselineSource = capabilities.getGroundedSource?.(scaffoldFile, anchor.nodeId) ?? null;
      const baseline = capabilities.getFingerprint?.(anchor.nodeId)
        ?? (baselineSource ? deserializeFingerprint(baselineSource.fingerprint) : null);
      if (!baseline) {
        issues.push(issue("GROUNDING_GONE", "warning", source,
          `Inline anchor points to an unavailable node: ${anchor.nodeId}`));
        continue;
      }
      const resolution = reconciler.reconcile(anchor.nodeId, baseline);
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
