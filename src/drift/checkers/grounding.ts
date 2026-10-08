import { readFileSync } from "node:fs";
import { relative } from "node:path";
import type { DriftIssue, Grounding, ScaffoldFrontmatter } from "../../types.js";
import { committedCodeHash } from "../../graph/code-hash.js";
import { canonicalFingerprint, deserializeFingerprint, serializeFingerprint } from "../../graph/fingerprint.js";
import type { GraphEngine } from "../../graph/engine.js";
import type { GroundedSource, GroundingChecker } from "../../graph/grounding.js";
import type { Fingerprint, Reconciler, Resolution } from "../../graph/reconcile.js";
import type { ExplainedResolution } from "../../graph/reconcile-engine.js";
import { observeCommittedGroundings, type CommittedGrounding } from "../../committed-groundings.js";
import { extractGroundings, findMexAnchors } from "../../markdown.js";
import { createGroundingEvidence } from "../../graph/grounding-evidence.js";
import type { GroundingGraph } from "../../wiki/grounding/adapter.js";
import { resolveGrounding } from "../../wiki/grounding/resolve.js";
import { groundingVerdict, type NamedVerdict } from "../../wiki/grounding/verdict.js";
import { parseWikiMarkdown } from "../../wiki/markdown/codec.js";
import type { GroundingResolution } from "../../wiki/model/grounding.js";

interface GroundingReconcilerCapabilities {
  getGroundedSource?(scaffoldFile: string, nodeId: string): GroundedSource | null;
  getFingerprint?(nodeId: string): Fingerprint | null;
  /** The reconciler may take the committed body hash as a tie-breaker (#229). */
  reconcile(missingNodeId: string, baseline: Fingerprint, bodyHash?: string): Resolution;
  /** The verdict and the evidence that decided it; without it every verdict counts as body evidence. */
  explain?(missingNodeId: string, baseline: Fingerprint, bodyHash?: string): ExplainedResolution;
}

/**
 * The info notice for a MOVED that callers and callees decided (#229). Not
 * counted in the score (`src/drift/scoring.ts`); `sync` prints the same line
 * when it rewrites the reference.
 */
export function movedByNeighborsMessage(oldId: string, newId: string, anchor = false): string {
  return `${anchor ? "Inline anchor" : "Grounded node"} matched by callers and callees, not body: ${oldId} → ${newId}`;
}

/** What a snapshot stale only by changed source can still say about one node (#228). */
export type SourceDriftResolution =
  /** The node's body as a refresh would record it: from the snapshot when its
   *  file is unchanged, or re-derived exactly from the edited file. `codeHash`
   *  computes that body's comment-free hash on demand (#236). */
  | { kind: "current"; bodyHash: string | undefined; codeHash?: () => string | null }
  /** Only a refresh can settle this node; `reason` says why. */
  | { kind: "unverified"; reason: string };

/**
 * Grounding against a graph whose only fault is that source files changed.
 * Supplied by the read-only runtime, which owns the exhaustive drifted-path set.
 */
export interface SourceDriftGrounding {
  resolve(nodeId: string): SourceDriftResolution;
}

/**
 * Comment-free code hashes (#236; `src/graph/code-hash.ts`), supplied by the
 * runtime because they need the node's source file and its grammar. Either
 * may return null, which always means "cannot tell" and keeps the warning.
 */
export interface GroundingCodeHashing {
  /** The current node's code hash, from its file as the graph indexed it. */
  current(nodeId: string): string | null;
  /** The code hash of an old body of `nodeId`, parsed as that node's language. */
  ofBody(nodeId: string, body: string): string | null;
  /** A recorded old body by its hash, from the graph's grounded-source rows. */
  recallBody?(bodyHash: string): string | null;
}

export function makeGroundingChecker(
  graph: GraphEngine,
  reconciler: Reconciler,
  sourceDrift?: SourceDriftGrounding,
  codeHashing?: GroundingCodeHashing,
): GroundingChecker {
  const capabilities = reconciler as Reconciler & GroundingReconcilerCapabilities;
  const decide = (nodeId: string, baseline: Fingerprint, bodyHash: string | undefined): ExplainedResolution =>
    capabilities.explain?.(nodeId, baseline, bodyHash)
      ?? { resolution: capabilities.reconcile(nodeId, baseline, bodyHash), evidence: "body" };

  // The graph as the shared verdict function reads it, built once per project root.
  let links: { projectRoot: string; graph: CheckLinkGraph } | null = null;
  const linkGraph = (projectRoot: string): CheckLinkGraph => {
    if (links?.projectRoot !== projectRoot) {
      links = { projectRoot, graph: createCheckLinkGraph(graph, capabilities, decide, projectRoot, codeHashing) };
    }
    return links.graph;
  };

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

    // Every code link in the file, with the Wiki entity it belongs to. Read
    // through the Wiki's own codec, so `mex.grounds_to` maps, `<!-- mex:entity -->`
    // blocks and a pre-wiki root `grounds_to` (#226) are all seen, each link once.
    const declared = content === null
      ? (frontmatter?.grounds_to ?? []).filter(isGrounding).map((grounding): DeclaredLink => ({ grounding }))
      : declaredLinks(scaffoldFile, content);
    // Taken from the links as committed, for inline anchors below.
    const committedHere = committedBaselines(declared.map((link) => link.grounding));

    const shared = linkGraph(projectRoot);
    for (const { grounding, entity } of declared) {
      let target = shared;
      if (sourceDrift) {
        // **A stale snapshot never reconciles.** Rename and move detection
        // compares fingerprints across the whole corpus, and the corpus this
        // snapshot describes is no longer the working tree. A node that looks
        // gone may have moved into an edited file, so nothing here is reported
        // GONE, MOVED or AMBIGUOUS: what cannot be settled is UNVERIFIED, and
        // a definite verdict comes only from a body hash a refresh would record.
        const resolution = sourceDrift.resolve(grounding.node);
        if (resolution.kind === "unverified") {
          issues.push(withEntity(issue("GROUNDING_UNVERIFIED", "warning", source,
            `Grounded node cannot be verified until \`mex graph refresh\`: ${grounding.node} (${resolution.reason})`), entity));
          continue;
        }
        target = sourceDriftLinkGraph(shared, grounding.node, resolution, codeHashing);
      }
      const verdict = checkLink(grounding, target, entity?.fact);
      const found = linkIssues(grounding.node, verdict, source);
      // A link with no committed body hash is compared by structure alone,
      // which cannot see an edited constant. Say so rather than pass it clean;
      // one finding per link, so only when nothing worse was found.
      if (grounding.bodyHash === undefined && !found.some((entry) => entry.severity !== "info")) {
        found.push(issue("GROUNDING_NO_BASELINE", "warning", source,
          `Grounded node has no recorded body hash, so only structural change is seen: ${grounding.node}`));
      }
      issues.push(...found.map((entry) => withEntity(entry, entity)));
      // A frontmatter-only read rebinds MOVED entries in place, as it always did.
      if (content === null && verdict.named.resolvedNode !== undefined) grounding.node = verdict.named.resolvedNode;
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
      const { resolution, evidence } = decide(anchor.nodeId, baseline.fingerprint, baseline.bodyHash);
      if (resolution.kind === "MOVED") {
        if (evidence === "neighbors") {
          issues.push(issue("GROUNDING_MOVED_BY_NEIGHBORS", "info", source,
            movedByNeighborsMessage(anchor.nodeId, resolution.nodeId, true)));
        }
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

/** A link's entity, when it belongs to one: what `check` reports and the fact it is judged against. */
interface LinkEntity {
  id: string;
  title: string;
  fact: string;
}

interface DeclaredLink {
  grounding: Grounding;
  entity?: LinkEntity;
}

/**
 * Every committed code link in one Markdown file. Wiki entities come first,
 * read by the Wiki's codec exactly as the index reads them; a root
 * `grounds_to` that no entity owns (a pre-wiki scaffold) follows. A node is
 * reported once per owner, so a file-level entity that also carries the same
 * entry at the frontmatter root (#226) is not counted twice.
 */
function declaredLinks(scaffoldFile: string, content: string): DeclaredLink[] {
  const links: DeclaredLink[] = [];
  const owned = new Set<string>();
  let entities: readonly { entity: { id: string; title: string; body: string; groundsTo: readonly Grounding[] } }[];
  try {
    entities = parseWikiMarkdown({ path: scaffoldFile, text: content }).entities;
  } catch {
    entities = [];
  }
  for (const { entity } of entities) {
    const seen = new Set<string>();
    for (const grounding of entity.groundsTo) {
      if (!isGrounding(grounding) || seen.has(grounding.node)) continue;
      seen.add(grounding.node);
      owned.add(grounding.node);
      links.push({ grounding, entity: { id: entity.id, title: entity.title, fact: `${entity.title}\n\n${entity.body}` } });
    }
  }
  for (const grounding of extractGroundings(content)) {
    if (!isGrounding(grounding) || owned.has(grounding.node)) continue;
    owned.add(grounding.node);
    links.push({ grounding });
  }
  return links;
}

/** The shared verdict's graph, plus how each reconciliation was decided. */
interface CheckLinkGraph extends GroundingGraph {
  /** By declared node: whether a reconciliation was decided by body or by neighbours. */
  movedBy: Map<string, ExplainedResolution["evidence"]>;
  /** An old body by its committed hash, when this checkout has seen it. */
  oldBody(bodyHash: string): string | null;
}

/**
 * The graph as {@link resolveGrounding} reads it, for `check`.
 *
 * Read-only by construction: it has no `rememberBody`, so `check` never writes
 * the body cache. Everything else answers as the Wiki's adapter does, from the
 * same graph and the same old-body evidence.
 */
function createCheckLinkGraph(
  graph: GraphEngine,
  capabilities: Reconciler & GroundingReconcilerCapabilities,
  decide: (nodeId: string, baseline: Fingerprint, bodyHash: string | undefined) => ExplainedResolution,
  projectRoot: string,
  codeHashing: GroundingCodeHashing | undefined,
): CheckLinkGraph {
  const recallBody = codeHashing?.recallBody;
  const evidence = createGroundingEvidence({
    projectRoot,
    getNode: (nodeId) => graph.getNode(nodeId),
    ...(recallBody === undefined ? {} : { recallBody: (bodyHash: string) => recallBody(bodyHash) }),
  });
  const movedBy = new Map<string, ExplainedResolution["evidence"]>();
  return {
    movedBy,
    oldBody(bodyHash) {
      return recallBody?.(bodyHash) ?? null;
    },
    getNode(nodeId) {
      const node = graph.getNode(nodeId);
      return node === null ? null : {
        id: node.id,
        bodyHash: node.bodyHash ?? null,
        filePath: node.filePath,
        startLine: node.startLine,
        endLine: node.endLine,
      };
    },
    getFingerprint(nodeId) {
      const fingerprint = capabilities.getFingerprint?.(nodeId) ?? null;
      return fingerprint === null ? null : serializeFingerprint(fingerprint);
    },
    reconcile(nodeId, committedFingerprint, bodyHash) {
      const baseline = deserializeFingerprint(committedFingerprint);
      if (baseline === null) return null;
      const { resolution, evidence: decidedBy } = decide(nodeId, baseline, bodyHash);
      movedBy.set(nodeId, decidedBy);
      return resolution;
    },
    getBaselineSource() {
      return null;
    },
    explainChange(grounding, nodeId) {
      return evidence.explainChange(grounding, nodeId);
    },
  };
}

/**
 * The same graph for one node of a snapshot stale only by changed source
 * (#228): its body hash is the one a refresh would record, and only the
 * comment-only question can be answered, from code hashes.
 */
function sourceDriftLinkGraph(
  shared: CheckLinkGraph,
  nodeId: string,
  current: Extract<SourceDriftResolution, { kind: "current" }>,
  codeHashing: GroundingCodeHashing | undefined,
): CheckLinkGraph {
  return {
    ...shared,
    getNode(id) {
      const node = shared.getNode(id);
      if (id !== nodeId || node === null) return node;
      return { ...node, bodyHash: current.bodyHash ?? null };
    },
    explainChange(grounding) {
      const old = grounding.bodyHash === undefined ? null : shared.oldBody(grounding.bodyHash);
      const baselineCode = committedCodeHash(grounding.codeHash, grounding.bodyHash)
        ?? (old !== null ? codeHashing?.ofBody(nodeId, old) ?? null : null);
      const commentOnly = baselineCode !== null && baselineCode === (current.codeHash?.() ?? null);
      return { commentOnly, layoutOnly: commentOnly, oldBody: null, newBody: null };
    },
  };
}

/** One link's verdict, from the function the Wiki uses. */
function checkLink(grounding: Grounding, graph: CheckLinkGraph, fact: string | undefined): LinkVerdict {
  const resolution = resolveGrounding({
    node: grounding.node,
    fingerprint: grounding.fingerprint,
    ...(grounding.bodyHash === undefined ? {} : { bodyHash: grounding.bodyHash }),
    ...(grounding.codeHash === undefined ? {} : { codeHash: grounding.codeHash }),
  }, graph, fact === undefined ? {} : { fact });
  return {
    named: groundingVerdict(resolution),
    resolution,
    byNeighbors: graph.movedBy.get(grounding.node) === "neighbors",
  };
}

interface LinkVerdict {
  named: NamedVerdict;
  resolution: GroundingResolution;
  byNeighbors: boolean;
}

const NEARBY_MESSAGE = "Grounded node changed away from everything the fact names";

/** The findings one verdict deserves; a plain `fresh` deserves none. */
function linkIssues(node: string, verdict: LinkVerdict, source: string): DriftIssue[] {
  const { named, resolution, byNeighbors } = verdict;
  const moved = named.resolvedNode !== undefined && named.resolvedNode !== node ? named.resolvedNode : undefined;
  const found: DriftIssue[] = [];
  if (moved !== undefined && byNeighbors) {
    found.push(issue("GROUNDING_MOVED_BY_NEIGHBORS", "info", source, movedByNeighborsMessage(node, moved)));
  }
  switch (named.verdict) {
    case "fresh":
    case "moved":
      // A move is not drift: the code is the code the fact was recorded
      // against, found under another id. Said once, so `sync` can rewrite it.
      if (moved !== undefined) {
        found.push(issue("GROUNDING_MOVED", "info", source, `Grounded node moved: ${node}; candidate: ${moved}`));
      }
      if (named.note === "comment-only") {
        found.push(issue("GROUNDING_COMMENT_DRIFT", "info", source, `Grounded node changed only in comments: ${node}`));
      } else if (named.note === "layout-only") {
        found.push(issue("GROUNDING_COMMENT_DRIFT", "info", source,
          `Grounded node changed only in comments or formatting: ${node}`));
      } else if (named.note === "changed-nearby") {
        found.push(issue("GROUNDING_NEARBY_DRIFT", "info", source, `${NEARBY_MESSAGE}: ${node}`));
      }
      break;
    case "changed-nearby":
      found.push(issue("GROUNDING_NEARBY_DRIFT", "info", source, `${NEARBY_MESSAGE}: ${node}`));
      break;
    case "changed":
      found.push(issue("GROUNDING_DRIFT", "warning", source,
        `Grounded node body changed: ${node}${moved === undefined ? "" : `; candidate: ${moved}`}`));
      break;
    case "ambiguous": {
      const candidate = resolution.state === "unresolved" ? resolution.candidates?.[0] : undefined;
      found.push(issue("GROUNDING_AMBIGUOUS", "warning", source,
        `Grounded node may have moved: ${node}${candidate === undefined ? "" : `; candidate: ${candidate}`}`));
      break;
    }
    case "missing":
      found.push(issue("GROUNDING_GONE", "error", source, `Grounded node no longer exists: ${node}`));
      break;
    case "unverified":
      break;
  }
  return found.map((entry) => ({ ...entry, verdict: named.verdict }));
}

/** Attach a link's Wiki entity to its finding: structured, and readable after the node id. */
function withEntity(found: DriftIssue, entity: LinkEntity | undefined): DriftIssue {
  if (entity === undefined) return found;
  return {
    ...found,
    message: `${found.message}; entity: ${entity.id} "${entity.title}"`,
    entity: { id: entity.id, title: entity.title },
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
  // By value: one file written before #233 and one after spell the same
  // fingerprint in two encodings, and they agree.
  if (new Set(elsewhere.map((entry) => canonicalFingerprint(entry.fingerprint))).size > 1) return "conflict";
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
