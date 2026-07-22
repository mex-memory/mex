import { readFileSync } from "node:fs";
import { relative } from "node:path";
import type { DriftIssue, Grounding, ScaffoldFrontmatter } from "../../types.js";
import { deserializeFingerprint, serializeFingerprint } from "../../graph/fingerprint.js";
import type { GraphEngine } from "../../graph/engine.js";
import type { GroundedSource, GroundingChecker } from "../../graph/grounding.js";
import type { Fingerprint, Reconciler } from "../../graph/reconcile.js";
import { findMexAnchors } from "../../markdown.js";

interface GroundingReconcilerCapabilities {
  getGroundedSource?(scaffoldFile: string, nodeId: string): GroundedSource | null;
  getFingerprint?(nodeId: string): Fingerprint | null;
}

export function makeGroundingChecker(
  graph: GraphEngine,
  reconciler: Reconciler,
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

    for (const grounding of frontmatter?.grounds_to ?? []) {
      if (!isGrounding(grounding)) continue;
      const current = graph.getNode(grounding.node);
      const baselineSource = capabilities.getGroundedSource?.(scaffoldFile, grounding.node) ?? null;
      if (current) {
        if (baselineSource && current.bodyHash !== baselineSource.bodyHash) {
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

    let content: string;
    try { content = readFileSync(filePath, "utf-8"); } catch { return issues; }
    for (const anchor of findMexAnchors(content)) {
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
