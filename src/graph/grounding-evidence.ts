/**
 * Evidence about a grounded body that no longer matches its committed hash.
 *
 * A grounding commits `bodyHash` (and, since #236, a `codeHash` bound to it).
 * When the live body differs, the warning is right only if the difference is
 * one a reader would care about. This module answers the two mechanical
 * questions — did only comments change, did only layout change — and hands
 * the old and new bodies to the caller for anything finer.
 *
 * ## The old body
 *
 * Markdown commits hashes, not text, so the old side of a diff comes from a
 * checkout-local cache of bodies this checkout has seen, keyed by body hash
 * (`.mex/local/grounded-bodies/<bodyHash>.txt`). It is content-addressed and
 * re-hashed on every read, so it can only ever supply the body the committed
 * hash names: it cannot turn a changed body into a fresh one by itself the way
 * a re-captured baseline would. A missing or unreadable entry leaves the
 * warning exactly as it was.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bodyTokenHash, codeHash, committedCodeHash } from "./code-hash.js";
import { readContainedRepositorySource } from "./status.js";

export interface GroundingChangeEvidence {
  /** Only comments differ: the committed code hash, or the remembered old body, says so. */
  commentOnly: boolean;
  /** Only comments and layout (semicolons, trailing commas, quote style) differ. */
  layoutOnly: boolean;
  /** The body the committed `bodyHash` names, when this checkout has seen it. */
  oldBody: string | null;
  /** The node's body now, read as the graph indexed it. */
  newBody: string | null;
}

/** What a grounding committed, as far as this module reads it. */
export interface CommittedBody {
  bodyHash?: string;
  codeHash?: string;
}

export interface GroundingEvidence {
  explainChange(committed: CommittedBody, nodeId: string): GroundingChangeEvidence | null;
  rememberBody(nodeId: string, bodyHash: string): void;
}

interface EvidenceNode {
  filePath: string;
  startLine: number;
  endLine: number;
  bodyHash?: string | null;
}

/** The graph's body normalization: whitespace runs collapsed, then sha256. */
function hashNodeBody(source: string): string {
  return createHash("sha256").update(source.replace(/\s+/g, " ").trim()).digest("hex");
}

/** Where a project's remembered grounded bodies live. */
export function groundedBodyCacheDir(projectRoot: string): string {
  return join(projectRoot, ".mex", "local", "grounded-bodies");
}

export function createGroundingEvidence(options: {
  projectRoot: string;
  getNode(nodeId: string): EvidenceNode | null;
  /** Defaults to {@link groundedBodyCacheDir}. */
  bodyCacheDir?: string;
}): GroundingEvidence {
  const dir = options.bodyCacheDir ?? groundedBodyCacheDir(options.projectRoot);
  const pathFor = (bodyHash: string): string | null =>
    /^[0-9a-f]{64}$/.test(bodyHash) ? join(dir, `${bodyHash}.txt`) : null;

  const recall = (bodyHash: string): string | null => {
    const path = pathFor(bodyHash);
    if (path === null) return null;
    try {
      const body = readFileSync(path, "utf8");
      return hashNodeBody(body) === bodyHash ? body : null;
    } catch {
      return null;
    }
  };

  /** The node's file and body, only while the file still holds the indexed body. */
  const readNode = (nodeId: string): { filePath: string; file: string; body: string; startLine: number; endLine: number } | null => {
    try {
      const node = options.getNode(nodeId);
      if (node === null || !node.bodyHash) return null;
      const file = readContainedRepositorySource(options.projectRoot, node.filePath);
      const body = file.split("\n").slice(node.startLine - 1, node.endLine).join("\n");
      if (hashNodeBody(body) !== node.bodyHash) return null;
      return { filePath: node.filePath, file, body, startLine: node.startLine, endLine: node.endLine };
    } catch {
      return null;
    }
  };

  return {
    explainChange(committed, nodeId) {
      const current = readNode(nodeId);
      if (current === null) return null;
      const oldBody = committed.bodyHash === undefined ? null : recall(committed.bodyHash);
      // The committed code hash (#236) answers "only comments" without the old
      // body; the remembered body answers it, and the layout question, with it.
      const committedCode = committedCodeHash(committed.codeHash, committed.bodyHash);
      let commentOnly = committedCode !== null
        && committedCode === codeHash(current.filePath, current.file, current.startLine, current.endLine);
      let layoutOnly = commentOnly;
      if (oldBody !== null) {
        const oldCode = bodyTokenHash(current.filePath, oldBody, false);
        commentOnly ||= oldCode !== null && oldCode === bodyTokenHash(current.filePath, current.body, false);
        const oldLayout = bodyTokenHash(current.filePath, oldBody, true);
        layoutOnly ||= commentOnly || (oldLayout !== null && oldLayout === bodyTokenHash(current.filePath, current.body, true));
      }
      return { commentOnly, layoutOnly, oldBody, newBody: current.body };
    },
    rememberBody(nodeId, bodyHash) {
      const path = pathFor(bodyHash);
      if (path === null || recall(bodyHash) !== null) return;
      const current = readNode(nodeId);
      if (current === null || hashNodeBody(current.body) !== bodyHash) return;
      try {
        mkdirSync(dir, { recursive: true });
        const temp = `${path}.${process.pid}.tmp`;
        writeFileSync(temp, current.body, "utf8");
        renameSync(temp, path);
      } catch {
        /* A cache that cannot be written only means a later change stays `changed`. */
      }
    },
  };
}
