/**
 * The per-tool composers for hook events.
 *
 * Each one takes the context index plus a read-only graph handle and returns
 * the text to inject (or null for silence) together with the session keys to
 * remember. They share the compact packet format and its caps, and none of
 * them writes anything: the runner owns session state and the log.
 *
 * Session keys: a bare entity id means "its text was shown". `edit:<id>` means
 * "it was shown as touched by an edit", which is a different message and so
 * has its own memory; `diff:<file>:<signature>` means "this exact change to
 * this file was already checked".
 */

import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { GraphNodeRow, GraphReader } from "../graph-reader.js";
import { formatPacket, liveStateFrom, PACKET_CHAR_LIMIT, type LiveLocation, type PacketEntry } from "../packet.js";
import type { ContextEntity, ContextIndex, LiveHealth } from "../types.js";
import { baseLocations } from "./base.js";
import type { PointerEntry } from "./budget.js";
import { touches, type FileDiff } from "./diff.js";

export const READ_MAX_FACTS = 2;
export const EDIT_MAX_FACTS = 3;
export const GREP_NOTE_CHAR_LIMIT = 1200;
export const GREP_MAX_FILES = 5;
export const GREP_MAX_FACTS = 2;
export const MAX_GROUNDING_LINES = 300;
export const GREP_MAX_CALLERS = 0;
export const READ_BODY_CHARS = 200;
export const GREP_BODY_CHARS = 220;
const POINTER_IDS = 3;

export interface EventOutcome {
  /** What to inject. */
  text: string;
  /** Session keys to remember once the text has been delivered. */
  remember: string[];
  /** Facts the text carries, for the log. */
  ids: string[];
  /** One entry per fact in the text, for the budget's degraded form. */
  pointers?: PointerEntry[];
  /** Locations already carried by knowledge, also used for same-event graph dedup. */
  knowledgeNodes?: string[];
  /** Atomic graph rows allow the combined composer to drop duplicates before delivery. */
  graphRows?: Array<{ text: string; nodes: string[]; remember: string[] }>;
  graphHeader?: string;
  graphNodes?: string[];
  graphChars?: number;
}

export interface EventContext {
  projectRoot: string;
  localDir: string;
  index: ContextIndex;
  /** Graph handle, or null when the graph is absent or unusable. */
  reader: GraphReader | null;
  /** Session keys already remembered (empty when the host sent no usable session id). */
  shown: ReadonlySet<string>;
  /** The commit HEAD names, when it could be read. */
  head: string | null;
  /** Entities a session touched and nobody re-confirmed (`context-flags.json`); they read as changed. */
  flagged?: ReadonlySet<string>;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** A project-relative POSIX path, or null for a path outside the project or inside `.mex/`. */
export function projectRelative(projectRoot: string, path: string): string | null {
  const relativePath = relative(projectRoot, isAbsolute(path) ? path : resolve(projectRoot, path)).replace(/\\/g, "/");
  if (relativePath === "" || relativePath === ".." || relativePath.startsWith("../") || isAbsolute(relativePath)) return null;
  if (relativePath === ".mex" || relativePath.startsWith(".mex/")) return null;
  return relativePath;
}

export function isTestPath(path: string): boolean {
  return /(^|\/)(__tests__|tests?|specs?|e2e|__mocks__|testRunner|unittests)(\/|$)/i.test(path) || /\.(test|spec)\.[a-z0-9]+$/i.test(path);
}

export function isDocPath(path: string): boolean {
  return /(^|\/)(docs?|documentation)(\/|$)/i.test(path) || /\.(md|mdx|rst|txt)$/i.test(path);
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

export function facts(index: ContextIndex): ContextEntity[] {
  return index.entities.filter((entity) => entity.type === "fact" && entity.level > 0);
}

function linkedTo(index: ContextIndex, file: string): ContextEntity[] {
  return facts(index).filter((entity) => entity.code.includes(file));
}

const sameFile = (a: string, b: string): boolean => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);

function locationsIn(locations: readonly LiveLocation[], file: string): LiveLocation[] {
  return locations.filter((location) => sameFile(location.file, file));
}

const pointerOf = (entry: PacketEntry): PointerEntry => ({ id: entry.entity.id, title: entry.entity.title, health: entry.live.health });

function oneLineList(ids: readonly string[]): string {
  return ids.slice(0, POINTER_IDS).join(" ");
}

// ---------------------------------------------------------------------------
// read
// ---------------------------------------------------------------------------

export interface ReadInput {
  /** Project-relative path of the file that was read. */
  file: string;
  offset?: number;
  limit?: number;
}

/** The inclusive line range the agent saw, or null for the whole file. */
export function readRange(input: Pick<ReadInput, "offset" | "limit">): [number, number] | null {
  const offset = Number.isFinite(input.offset) && (input.offset ?? 0) > 0 ? Math.floor(input.offset!) : 0;
  const limit = Number.isFinite(input.limit) && (input.limit ?? 0) > 0 ? Math.floor(input.limit!) : 0;
  if (offset === 0 && limit === 0) return null;
  const start = offset || 1;
  return [start, start + (limit || 2000) - 1];
}

/**
 * Facts about the code that was just read: those whose linked code overlaps the
 * lines the agent actually saw. At most two are shown; the rest are one pointer.
 */
export function composeRead(ctx: EventContext, input: ReadInput): EventOutcome | null {
  const linked = linkedTo(ctx.index, input.file);
  if (linked.length === 0) return null;
  const live = liveStateFrom(ctx.reader, linked, ctx.flagged);
  const range = readRange(input);

  const inRange = linked
    .map((entity) => ({ entity, state: live(entity) }))
    .filter(({ state }) => {
      return locationsIn(state.locations, input.file).some((l) => l.end - l.start + 1 <= MAX_GROUNDING_LINES && (range === null || (l.start <= range[1] && l.end >= range[0])));
    })
    .filter(({ entity }) => !ctx.shown.has(entity.id));
  if (inRange.length === 0) return null;

  const firstLine = (entry: (typeof inRange)[number]): number =>
    Math.min(...locationsIn(entry.state.locations, input.file).map((l) => l.start), Number.MAX_SAFE_INTEGER);
  // Facts about code that has since changed come first: they are the ones to verify. Then top to bottom.
  const stale = (entry: (typeof inRange)[number]): number => (entry.state.health === "fresh" ? 1 : 0);
  inRange.sort((a, b) => stale(a) - stale(b) || firstLine(a) - firstLine(b));

  const entries: PacketEntry[] = inRange.slice(0, READ_MAX_FACTS).map(({ entity, state }) => ({
    entity: { ...entity, body: claimExcerpt(entity.body, READ_BODY_CHARS) }, live: state,
  }));
  const rest = inRange.slice(READ_MAX_FACTS).map(({ entity }) => entity.id);
  const footer = rest.length > 0 ? [`+${rest.length} more fact${rest.length === 1 ? "" : "s"} about ${input.file}: mex wiki show ${oneLineList(rest)}`] : [];
  const packet = formatPacket(entries, "read", { maxEntries: READ_MAX_FACTS, bodyChars: READ_BODY_CHARS + 5, footer: [...footer, ...seeAlso(ctx, entries.map(e => e.entity))] });
  if (packet.shown.length === 0) return null;
  const ids = packet.shown.map((entry) => entry.entity.id);
  const nodes = shownLocationNodes(ctx, packet.shown);
  return { text: packet.text, remember: [...ids, ...nodes.map(id => `graph:${id}`)], ids, knowledgeNodes: nodes, pointers: packet.shown.map(pointerOf) };
}

// ---------------------------------------------------------------------------
// edit and bash
// ---------------------------------------------------------------------------

export interface TouchedFact {
  entity: ContextEntity;
  /** First touched line of the entity's code at HEAD (for ordering). */
  first: number;
  /** The grounded symbol overlapped by the hunk. */
  why: string;
}

/**
 * The facts a change touches, judged on the base side.
 *
 * A fact is touched when a hunk overlaps one of its linked symbols as the code
 * stood at HEAD. Unresolved links do not establish an overlap. `base` records
 * where each fact's code stood at HEAD (see `base.ts`).
 */
export function findTouched(
  candidates: readonly ContextEntity[],
  files: readonly string[],
  diffs: ReadonlyMap<string, FileDiff>,
  base: Readonly<Record<string, LiveLocation[]>>,
  skip: (entity: ContextEntity) => boolean = () => false,
): TouchedFact[] {
  const touched: TouchedFact[] = [];
  for (const entity of candidates) {
    if (skip(entity)) continue;
    let first = Number.MAX_SAFE_INTEGER;
    let hit = false;
    const reasons: string[] = [];
    for (const file of files) {
      if (!entity.code.some((code) => sameFile(code, file))) continue;
      const ranges = diffs.get(file)!.ranges;
      const here = locationsIn(base[entity.id] ?? [], file);
      // An unresolved link is not evidence that this edit touched the claim.
      if (here.length > 0) {
        for (const location of here) {
          const cited = citedLocations(entity, location);
          if (cited.some(l => touches(ranges, l.start, l.end))) {
            hit = true;
            first = Math.min(first, location.start);
            reasons.push(`edited #${location.name.replace(/^#/, "")} in ${file}`);
          }
        }
      }
    }
    if (hit) touched.push({ entity, first, why: [...new Set(reasons)].slice(0, 2).join("; ") });
  }
  return touched;
}

export const EDIT_INSTRUCTION =
  "Only if the claim may now be false, read its body and rewrite just that prose; no action if still true. Never edit <!-- mex:entity --> blocks, ids or fingerprints: MEX re-records code links itself.";

export interface EditInput {
  /** Files changed, each with the diff against HEAD (null diff: git could not say). */
  diffs: ReadonlyMap<string, FileDiff>;
  /** Files the agent named (an Edit hook knows which file it was); defaults to every diffed file. */
  only?: readonly string[];
}

/** Session key for "this exact change to this file was already checked". */
export const diffKey = (file: string, diff: FileDiff): string => `diff:${file}:${diff.signature}`;

/**
 * Facts whose linked code a change touched.
 *
 * A fact is touched when a hunk overlaps one of its linked symbols as the code
 * stood at HEAD. A never-resolved link cannot establish touch.
 */
export function composeEdit(ctx: EventContext, input: EditInput, charLimit = PACKET_CHAR_LIMIT): EventOutcome | null {
  const files = [...input.diffs.keys()].filter((file) => input.only === undefined || input.only.some((o) => sameFile(o, file)));
  const fresh = files.filter((file) => !ctx.shown.has(diffKey(file, input.diffs.get(file)!)));
  const remember = files.map((file) => diffKey(file, input.diffs.get(file)!));
  if (fresh.length === 0) return null;

  const candidates = facts(ctx.index).filter((entity) => entity.code.some((code) => fresh.some((file) => sameFile(file, code))));
  if (candidates.length === 0) return { text: "", remember, ids: [] };
  const live = liveStateFrom(ctx.reader, candidates, ctx.flagged);
  const base = baseLocations(ctx.localDir, ctx.head, candidates, live);

  const touched = findTouched(candidates, fresh, input.diffs, base, (entity) => ctx.shown.has(`edit:${entity.id}`));
  if (touched.length === 0) return { text: "", remember, ids: [] };
  // A broad symbol overlap remains checker evidence, but is not a prose request.
  const precise = touched.filter(({ entity }) => fresh.some(file => locationsIn(base[entity.id] ?? [], file)
    .some(location => citedLocations(entity, location).some(l => l !== location && touches(input.diffs.get(file)!.ranges, l.start, l.end)))));
  precise.sort((a, b) => a.first - b.first);

  const selected = precise.slice(0, EDIT_MAX_FACTS);
  const lines = selected.map(({ entity }) => {
    const bodyLine = firstBodyLine(ctx, entity);
    const pointer = bodyLine === null ? `mex wiki show ${entity.id}` : `.mex/${entity.file}:${bodyLine}`;
    const body = ctx.shown.has(entity.id) ? "" : ` - ${trimTo(entity.body, 400)}`;
    return `- ${entity.title}${body} | ${pointer}`;
  });
  while (lines.length && (`MEX: a cited claim may need checking:\n${lines.join("\n")}\n${EDIT_INSTRUCTION}`).length > charLimit) {
    lines.pop(); selected.pop();
  }
  const ids = selected.map(({ entity }) => entity.id);
  if (!ids.length) return { text: "", remember, ids: [] };
  return { text: `MEX: a cited claim may need checking:\n${lines.join("\n")}\n${EDIT_INSTRUCTION}`,
    remember: [...remember, ...ids.map(id => `edit:${id}`)], ids,
    pointers: selected.map(({ entity }) => ({ id: entity.id, title: entity.title, health: live(entity).health })) };

}

// ---------------------------------------------------------------------------
// grep
// ---------------------------------------------------------------------------

export interface GrepHit {
  file: string;
  /** One-based line, or null when the output listed only file names. */
  line: number | null;
}

/** `path:line:` hits in search output, in order, one per line of output. */
export function parseGrepLines(text: string, projectRoot: string): GrepHit[] {
  const hits: GrepHit[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const match = /^((?:[A-Za-z]:)?[^:\n]+?):(\d+):/.exec(raw);
    if (!match) continue;
    const file = projectRelative(projectRoot, match[1]!);
    if (file !== null) hits.push({ file, line: Number(match[2]) });
  }
  return hits;
}

export function hitsFromFileList(files: readonly string[], projectRoot: string): GrepHit[] {
  return files.flatMap((name) => {
    const file = projectRelative(projectRoot, name);
    return file === null ? [] : [{ file, line: null }];
  });
}

function trimTo(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 2)).replace(/\s+\S*$/, "")} …`;
}

interface GrepFinding {
  hit: GrepHit;
  node: GraphNodeRow | null;
  fact: ContextEntity | null;
  moreFacts: number;
  health: LiveHealth;
}

/**
 * A short note about where search hits land: for the top hits (five files at
 * most), the enclosing symbol and up to two facts linked by node id. Silent
 * unless a hit sits in code with a fact the agent has not been shown.
 */
export function composeGrep(ctx: EventContext, hits: readonly GrepHit[]): EventOutcome | null {
  if (ctx.reader === null || hits.length === 0) return null;
  const files: string[] = [];
  for (const hit of hits) if (!files.some((f) => sameFile(f, hit.file)) && files.length < GREP_MAX_FILES) files.push(hit.file);
  const top = hits.filter((hit) => files.some((f) => sameFile(f, hit.file)));

  const factsByNode = new Map<string, ContextEntity[]>();
  for (const entity of facts(ctx.index)) {
    for (const grounding of entity.groundings) {
      const list = factsByNode.get(grounding.node) ?? [];
      list.push(entity);
      factsByNode.set(grounding.node, list);
    }
  }

  const findings: GrepFinding[] = [];
  const seenNodes = new Set<string>();
  const usedFacts = new Set<string>();
  for (const hit of top) {
    if (hit.line === null) continue;
    const node = ctx.reader.enclosing(hit.file, hit.line);
    if (node === null || node.end - node.start + 1 > MAX_GROUNDING_LINES || seenNodes.has(node.id)) continue;
    seenNodes.add(node.id);
    const linked = (factsByNode.get(node.id) ?? []).filter((entity) => !ctx.shown.has(entity.id) && !usedFacts.has(entity.id));
    if (linked.length === 0) continue;
    if (findings.filter((f) => f.fact !== null).length >= GREP_MAX_FACTS) continue;
    const fact = linked[0]!;
    usedFacts.add(fact.id);
    const health = liveStateFrom(ctx.reader, [fact], ctx.flagged)(fact).health;
    findings.push({ hit, node, fact, moreFacts: linked.length - 1, health });
  }
  // File-only output (no line numbers) can still point at a file's facts, one per file.
  for (const hit of top) {
    if (hit.line !== null || findings.length >= GREP_MAX_FACTS * 2) continue;
    const fact = linkedTo(ctx.index, hit.file).find((entity) => !ctx.shown.has(entity.id) && !usedFacts.has(entity.id) && liveStateFrom(ctx.reader, [entity])(entity).locations.some(l => sameFile(l.file, hit.file) && l.end - l.start + 1 <= MAX_GROUNDING_LINES));
    if (fact === undefined || findings.filter((f) => f.fact !== null).length >= GREP_MAX_FACTS) continue;
    usedFacts.add(fact.id);
    findings.push({ hit, node: null, fact, moreFacts: 0, health: liveStateFrom(ctx.reader, [fact], ctx.flagged)(fact).health });
  }

  const withFacts = findings.filter((f) => f.fact !== null);
  if (withFacts.length === 0) return null;
  // Factless locations are covered by the graph tier; spend this budget on claims.
  findings.splice(0, findings.length, ...withFacts);

  const render = (bodyChars: number, lines: number): string => {
    const out: string[] = ["MEX (search hits; read code bodies to verify):"];
    for (const finding of findings.slice(0, lines)) {
      if (finding.fact === null) continue;
      const location = finding.node ? `${finding.node.file}:${finding.node.start}-${finding.node.end} #${finding.node.name}` : finding.hit.file;
      const label = finding.health === "changed" ? "changed; verify" : finding.health;
      out.push(`- location ${location} [${label}] ${trimTo(finding.fact.title, 100)}: ${claimExcerpt(finding.fact.body, bodyChars)} | ${finding.fact.id}`);
    }
    return out.join("\n");
  };

  let bodyChars = GREP_BODY_CHARS;
  let text = render(bodyChars, findings.length);
  while (text.length > GREP_NOTE_CHAR_LIMIT) {
    if (bodyChars > 140) bodyChars = Math.max(140, bodyChars - 20);
    else {
      const dropped = findings.pop();
      if (dropped?.fact) withFacts.splice(withFacts.indexOf(dropped), 1);
      if (!findings.length) return null;
    }
    text = render(bodyChars, findings.length);
  }
  const also = seeAlso(ctx, withFacts.map(f => f.fact!)).join("\n");
  if (also && text.length + also.length + 1 <= GREP_NOTE_CHAR_LIMIT) text += `\n${also}`;
  const ids = withFacts.map((f) => f.fact!.id);
  const nodes = withFacts.flatMap(f => f.node ? [f.node.id] : []);
  return { text, remember: [...ids, ...nodes.map(id => `graph:${id}`)], ids,
    knowledgeNodes: nodes,
    pointers: withFacts.map((f) => ({ id: f.fact!.id, title: f.fact!.title, health: f.health })) };
}

/** Explicit file:line citations narrow a claim; absent citations retain the recorded span. */
export function citedLocations(entity: ContextEntity, location: LiveLocation): LiveLocation[] {
  const cited = [...entity.body.matchAll(/([\w./-]+\.[a-zA-Z]+):(\d+)(?:-(\d+))?/g)]
    .filter(m => sameFile(m[1]!, location.file))
    .map(m => ({ ...location, start: Number(m[2]), end: Number(m[3] ?? m[2]) }))
    .filter(l => l.start >= location.start && l.end <= location.end && l.end >= l.start);
  return cited.length ? cited : [location];
}

function shownLocationNodes(ctx: EventContext, entries: readonly PacketEntry[]): string[] {
  const ids = entries.flatMap(e => e.entity.groundings.map(g => g.node));
  const nodes = ctx.reader?.nodes(ids);
  return entries.flatMap(entry => entry.entity.groundings.flatMap(g => {
    const node = nodes?.get(g.node) ?? entry.entity.symbols.find(s => s.node === g.node);
    return node && entry.live.locations.slice(0, 3).some(l => sameFile(l.file, node.file) && l.start === node.start && l.end === node.end) ? [g.node] : [];
  }));
}

/** Read only the known artifact, with containment and size bounds; never scan .mex. */
function artifactLines(ctx: EventContext, entity: ContextEntity): string[] | null {
  const root = resolve(ctx.projectRoot, ".mex");
  const path = resolve(root, entity.file);
  const rel = relative(root, path);
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  try {
    const physical = relative(realpathSync(root), realpathSync(path));
    if (physical.startsWith("..") || isAbsolute(physical)) return null;
    if (statSync(path).size > 256 * 1024) return null;
    return readFileSync(path, "utf8").split(/\r?\n/);
  } catch { return null; }
}

export function firstBodyLine(ctx: EventContext, entity: ContextEntity): number | null {
  const lines = artifactLines(ctx, entity);
  if (!lines) return null;
  let comment = false;
  for (let i = Math.max(0, entity.line - 1); i < Math.min(lines.length, entity.line + 200); i++) {
    const line = lines[i]!.trim();
    if (line.startsWith("<!--")) comment = true;
    if (comment) { if (line.includes("-->")) comment = false; continue; }
    if (/^#{1,6}\s/.test(line)) {
      if (i !== entity.line - 1) return null;
      continue;
    }
    if (!line) continue;
    return i + 1;
  }
  return null;
}

/** At most one undisclosed neighbour per delivered fact, as a title/id pointer only. */
export function seeAlso(ctx: EventContext, delivered: readonly ContextEntity[]): string[] {
  const used = new Set([...ctx.shown, ...delivered.map(e => e.id)]);
  const out: string[] = [];
  const referenced = (entity: ContextEntity): string[] => [...new Set(
    [...entity.body.matchAll(/`([A-Za-z_$][\w$]*)/g)].map(m => m[1]!)
      .filter(name => /[a-z][A-Z]|[a-zA-Z]_[a-zA-Z]|^[A-Z]/.test(name)),
  )].slice(0, 12);
  for (const entity of delivered) {
    const lines = artifactLines(ctx, entity);
    // Section metadata immediately preceding the heading owns its relationships.
    const prefix = lines?.slice(0, entity.line).join("\n") ?? "";
    const marker = prefix.lastIndexOf("<!-- mex:entity");
    const metadata = marker >= 0 ? prefix.slice(marker) : entity.level === 0 ? prefix : "";
    const targets = new Set([...metadata.matchAll(/target:\s*["']?(mx_[A-Za-z0-9]+)/g)].map(m => m[1]!));
    const candidates = facts(ctx.index).filter(other => !used.has(other.id));
    let neighbour = candidates.find(other => targets.has(other.id) ||
      other.groundings.some(g => entity.groundings.some(link => link.node === g.node)));
    if (!neighbour && ctx.reader) {
      // A fact can cite an enclosing class while grounding its precise method.
      // Require a unique definition enclosing recorded evidence, not shared prose.
      const symbols = referenced(entity).flatMap(name => {
        const nodes = ctx.reader!.exactName(name, 2);
        return nodes.length === 1 ? [{ name, node: nodes[0]! }] : [];
      });
      neighbour = candidates.find(other => symbols.some(({ name, node }) => referenced(other).includes(name) &&
        [...entity.symbols, ...other.symbols].some(s => sameFile(s.file, node.file) && s.start >= node.start && s.end <= node.end)));
    }
    if (neighbour) { out.push(`see also: ${trimTo(neighbour.title, 90)} \u00b7 ${neighbour.id}`); used.add(neighbour.id); }
  }
  return out;
}

/** Keep the opening and deciding tail when a claim exceeds the prose budget. */
export function claimExcerpt(body: string, max: number): string {
  if (body.length <= max) return body;
  const first = Math.floor(max * 0.35);
  const last = max - first;
  return `${body.slice(0, first)} ... ${body.slice(-last)}`;
}
