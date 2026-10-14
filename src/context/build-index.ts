/**
 * Building the context index. Read-only: it parses Markdown and reads graph
 * rows, and hands back a value. Writing it down is `index-store.ts`.
 *
 * Entities come from the Wiki engine's own parser, so ids, types, titles,
 * bodies, groundings and aliases mean exactly what they mean to every other
 * Wiki command. Only the types a prompt can be answered from are kept.
 */

import { dirname } from "node:path";
import { readProjectWords } from "./project-words.js";
import { parseWikiMarkdown } from "../wiki/markdown/codec.js";
import { lineAt, lineStarts } from "../wiki/markdown/positions.js";
import { ACTIVE_LIFECYCLE_STATES } from "../wiki/model/entity.js";
import { WIKI_CANDIDATE_TYPES } from "./frozen.js";
import { openGraphReader, type GraphNodeRow, type GraphReader } from "./graph-reader.js";
import {
  CONTEXT_INDEX_SCHEMA_VERSION,
  type ContextDiagnostic,
  type ContextEntity,
  type ContextGrounding,
  type ContextIndex,
  type ContextInputs,
  type ContextSymbol,
} from "./types.js";
import { observeWikiMarkdown, type ObservedWikiFile, type WikiObservation } from "./wiki-source.js";

/** The longest body the index keeps; the frozen scorer was calibrated on this. */
export const MAX_BODY_CHARS = 1500;

/** Prose as the scorer sees it: Wiki link syntax reduced to its text, one line. */
export function oneLine(text: string): string {
  return text.replace(/\[([^\]]*)\]\(mex:\/\/[^)]*\)/g, "$1").replace(/\s+/g, " ").trim();
}

export interface BuildResult {
  index: ContextIndex;
  diagnostics: ContextDiagnostic[];
}

export interface AliasOverlay {
  overlay: Record<string, string[]>;
  digest: string | null;
}

export interface BuildOptions {
  /** Reuse an observation already taken for a staleness check. */
  observation?: WikiObservation;
  overlay: AliasOverlay;
  /** Supplies cached vectors; one is carried over only if its text hash still matches. */
  previous: ContextIndex | null;
  now?: () => string;
}

/** Observe the inputs and build the index from them. */
export function buildContextIndex(scaffoldRoot: string, options: BuildOptions): BuildResult {
  const observation = options.observation ?? observeWikiMarkdown(scaffoldRoot);
  const now = options.now ?? (() => new Date().toISOString());
  const { reader, reason } = openGraphReader(scaffoldRoot);
  const diagnostics: ContextDiagnostic[] = [...observation.diagnostics];
  if (reader === null && reason !== undefined) {
    diagnostics.push({
      code: "CONTEXT_GRAPH_UNAVAILABLE",
      severity: "info",
      message: `${reason} Linked-code tokens and live health fall back to what the Markdown recorded.`,
      remediation: "Run `mex graph` to build the code graph.",
    });
  }
  try {
    const overlay = options.overlay;
    const entities = collectEntities(observation.files, reader, overlay.overlay);
    const inputs: ContextInputs = {
      wiki: { files: observation.files.map(({ path, hash, stat }) => ({ path, hash, stat })), digest: observation.digest },
      graph: { identity: reader ? reader.identity() : null },
      aliasOverlay: overlay.digest,
    };
    return {
      index: {
        schemaVersion: CONTEXT_INDEX_SCHEMA_VERSION,
        builtAt: now(),
        inputs,
        projectWords: readProjectWords(dirname(scaffoldRoot)),
        entities,
        vectors: carryVectors(options.previous, entities),
      },
      diagnostics,
    };
  } finally {
    reader?.close();
  }
}

function collectEntities(
  files: readonly ObservedWikiFile[],
  graph: GraphReader | null,
  overlay: Record<string, string[]>,
): ContextEntity[] {
  const parsed = files.map((file) => ({ file, parsed: parseWikiMarkdown({ path: file.path, text: file.text }) }));
  const nodeIds = parsed.flatMap(({ parsed: p }) =>
    p.entities
      .filter(({ entity }) => isCandidateEntity(entity.type, entity.status))
      .flatMap(({ entity }) => entity.groundsTo.map((g) => g.node)),
  );
  const nodes = graph ? graph.nodes(nodeIds) : new Map<string, GraphNodeRow>();

  const out: ContextEntity[] = [];
  const seen = new Set<string>();
  for (const { file, parsed: p } of parsed) {
    const starts = lineStarts(file.text);
    for (const { entity, metadataKind } of p.entities) {
      if (!isCandidateEntity(entity.type, entity.status) || seen.has(entity.id)) continue;
      seen.add(entity.id);
      const loc = entity.location;
      const hasHeading = loc.headingEnd > loc.headingStart;
      const groundings: ContextGrounding[] = entity.groundsTo.map((g) => ({
        node: g.node,
        file: g.file ?? null,
        bodyHash: g.bodyHash ?? null,
      }));
      const symbols: ContextSymbol[] = [];
      for (const g of groundings) {
        const n = nodes.get(g.node);
        if (n) symbols.push({ node: n.id, name: n.name, file: n.file, start: n.start, end: n.end, bodyHash: n.bodyHash });
      }
      const code = [
        ...new Set(
          groundings
            .map((g) => g.file ?? nodes.get(g.node)?.file ?? null)
            .filter((f): f is string => f !== null && f.length > 0),
        ),
      ];
      const authored = entity.metadata?.["aliases"];
      const aliases = [
        ...new Set([
          ...(Array.isArray(authored) ? authored.filter((a): a is string => typeof a === "string" && a.trim() !== "") : []),
          ...(overlay[entity.id] ?? []),
        ]),
      ];
      out.push({
        id: entity.id,
        type: entity.type,
        title: oneLine(entity.title),
        body: oneLine(entity.body).slice(0, MAX_BODY_CHARS),
        aliases,
        file: file.path,
        line: lineAt(starts, hasHeading ? loc.headingStart : loc.bodyStart),
        level: metadataKind === "frontmatter" ? 0 : hasHeading ? loc.headingDepth : 9,
        groundings,
        code,
        symbols,
      });
    }
  }
  return out;
}

function isCandidateEntity(type: string, status: string): boolean {
  return WIKI_CANDIDATE_TYPES.has(type) && (ACTIVE_LIFECYCLE_STATES as readonly string[]).includes(status);
}

function carryVectors(previous: ContextIndex | null, entities: readonly ContextEntity[]): ContextIndex["vectors"] {
  if (previous === null) return {};
  const live = new Set(entities.map((e) => e.id));
  const kept: ContextIndex["vectors"] = {};
  for (const [model, byId] of Object.entries(previous.vectors)) {
    const filtered = Object.fromEntries(Object.entries(byId).filter(([id]) => live.has(id)));
    if (Object.keys(filtered).length > 0) kept[model] = filtered;
  }
  return kept;
}
