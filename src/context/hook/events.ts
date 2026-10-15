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
export const GREP_MAX_FACTS = 3;
export const GREP_MAX_CALLERS = 3;
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
  return /(^|\/)(__tests__|tests?|specs?|e2e|__mocks__)(\/|$)/i.test(path) || /\.(test|spec)\.[a-z0-9]+$/i.test(path);
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
      if (range === null) return true;
      return locationsIn(state.locations, input.file).some((l) => l.start <= range[1] && l.end >= range[0]);
    })
    .filter(({ entity }) => !ctx.shown.has(entity.id));
  if (inRange.length === 0) return null;

  const firstLine = (entry: (typeof inRange)[number]): number =>
    Math.min(...locationsIn(entry.state.locations, input.file).map((l) => l.start), Number.MAX_SAFE_INTEGER);
  // Facts about code that has since changed come first: they are the ones to verify. Then top to bottom.
  const stale = (entry: (typeof inRange)[number]): number => (entry.state.health === "fresh" ? 1 : 0);
  inRange.sort((a, b) => stale(a) - stale(b) || firstLine(a) - firstLine(b));

  const entries: PacketEntry[] = inRange.slice(0, READ_MAX_FACTS).map(({ entity, state }) => ({ entity, live: state }));
  const rest = inRange.slice(READ_MAX_FACTS).map(({ entity }) => entity.id);
  const footer = rest.length > 0 ? [`+${rest.length} more fact${rest.length === 1 ? "" : "s"} about ${input.file}: mex wiki show ${oneLineList(rest)}`] : [];
  const packet = formatPacket(entries, "read", { maxEntries: READ_MAX_FACTS, footer });
  if (packet.shown.length === 0) return null;
  const ids = packet.shown.map((entry) => entry.entity.id);
  return { text: packet.text, remember: ids, ids, pointers: packet.shown.map(pointerOf) };
}

// ---------------------------------------------------------------------------
// edit and bash
// ---------------------------------------------------------------------------

export interface TouchedFact {
  entity: ContextEntity;
  /** First touched line of the entity's code at HEAD (for ordering), or a huge number when none could be located. */
  first: number;
  /** Why it counts as touched, in a few words: the symbol the change fell in, or that the symbol could not be located. */
  why: string;
}

/**
 * The facts a change touches, judged on the base side.
 *
 * A fact is touched when a hunk overlaps one of its linked symbols as the code
 * stood at HEAD, or when it links a changed file but none of its symbols could
 * be located there (deleted, or never resolved), since the change may well have
 * been to it. `base` is where each fact's code stood at HEAD (see `base.ts`).
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
      if (here.length === 0) {
        hit = true;
        reasons.push(`${file} changed; its linked code could not be located at HEAD`);
      } else {
        for (const location of here) {
          if (touches(ranges, location.start, location.end)) {
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
  "If your change makes a fact false, read a few lines at its .mex line (offset/limit) and rewrite just that prose. Never edit <!-- mex:entity --> blocks, ids or fingerprints: MEX re-records code links itself.";

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
 * stood at HEAD, or when it links the file but none of its symbols could be
 * located there (the symbol was deleted or never resolved), since the change
 * may well have been to it.
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
  touched.sort((a, b) => a.first - b.first);

  const entries: PacketEntry[] = touched.slice(0, EDIT_MAX_FACTS).map(({ entity }) => ({
    entity,
    live: live(entity),
    extra: `if this change makes it false, rewrite its prose at .mex/${entity.file}:${entity.line}`,
  }));
  const names = fresh.slice(0, 3).join(", ") + (fresh.length > 3 ? ` +${fresh.length - 3} more` : "");
  const preamble = `MEX: you changed ${names}. Facts that describe the code you touched:`;
  const budget = Math.max(0, charLimit - preamble.length - 2);
  const packet = formatPacket(entries, "edit", {
    maxEntries: EDIT_MAX_FACTS,
    footer: [EDIT_INSTRUCTION],
    charLimit: budget,
    bodyChars: 400,
  });
  if (packet.shown.length === 0) return { text: "", remember, ids: [] };
  const ids = packet.shown.map((entry) => entry.entity.id);
  return { text: `${preamble}\n\n${packet.text}`, remember: [...remember, ...ids.map((id) => `edit:${id}`)], ids, pointers: packet.shown.map(pointerOf) };
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
  callers: GraphNodeRow[];
}

const tag = (file: string): string => (isTestPath(file) ? " [test]" : isDocPath(file) ? " [docs]" : "");
const where = (node: Pick<GraphNodeRow, "file" | "start">): string => `${node.file}:${node.start}`;
const symbolName = (name: string): string => `#${name.replace(/^#/, "")}`;

/** Callers distinct by place: one function can appear as several graph nodes at one line. */
function distinctByPlace(callers: readonly GraphNodeRow[]): GraphNodeRow[] {
  const seen = new Set<string>();
  return callers.filter((caller) => {
    const key = where(caller);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * A short note about where search hits land: for the top hits (five files at
 * most), the enclosing symbol, the fact linked to it and a few callers found
 * by node id. Silent unless some hit sits in code that has a fact the agent
 * has not been shown.
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
    if (node === null || seenNodes.has(node.id)) continue;
    seenNodes.add(node.id);
    const linked = (factsByNode.get(node.id) ?? []).filter((entity) => !ctx.shown.has(entity.id) && !usedFacts.has(entity.id));
    if (linked.length === 0) {
      findings.push({ hit, node, fact: null, moreFacts: 0, health: "none", callers: [] });
      continue;
    }
    if (findings.filter((f) => f.fact !== null).length >= GREP_MAX_FACTS) continue;
    const fact = linked[0]!;
    usedFacts.add(fact.id);
    const health = liveStateFrom(ctx.reader, [fact], ctx.flagged)(fact).health;
    findings.push({ hit, node, fact, moreFacts: linked.length - 1, health, callers: distinctByPlace(ctx.reader.callers(node.id, GREP_MAX_CALLERS * 3)).slice(0, GREP_MAX_CALLERS) });
  }
  // File-only output (no line numbers) can still point at a file's facts, one per file.
  for (const hit of top) {
    if (hit.line !== null || findings.length >= GREP_MAX_FACTS * 2) continue;
    const fact = linkedTo(ctx.index, hit.file).find((entity) => !ctx.shown.has(entity.id) && !usedFacts.has(entity.id));
    if (fact === undefined || findings.filter((f) => f.fact !== null).length >= GREP_MAX_FACTS) continue;
    usedFacts.add(fact.id);
    findings.push({ hit, node: null, fact, moreFacts: 0, health: liveStateFrom(ctx.reader, [fact], ctx.flagged)(fact).health, callers: [] });
  }

  const withFacts = findings.filter((f) => f.fact !== null);
  if (withFacts.length === 0) return null;
  // Lines with a fact come first, so trimming lines never costs one.
  findings.sort((a, b) => (b.fact === null ? 0 : 1) - (a.fact === null ? 0 : 1));

  const render = (bodyChars: number, lines: number): string => {
    const out: string[] = ["MEX (search hits that land in code with recorded knowledge):"];
    for (const finding of findings.slice(0, lines)) {
      const place = finding.hit.line === null ? finding.hit.file : `${finding.hit.file}:${finding.hit.line}`;
      if (finding.fact === null) {
        out.push(`- ${place}${tag(finding.hit.file)}${finding.node ? ` in ${symbolName(finding.node.name)}` : ""}`);
        continue;
      }
      const symbol = finding.node ? ` in ${symbolName(finding.node.name)} (${finding.node.file}:${finding.node.start}-${finding.node.end})` : "";
      const label = finding.health === "fresh" ? "fresh" : finding.health === "changed" ? "changed ⚠ verify" : finding.health;
      const extra = finding.moreFacts > 0 ? ` (+${finding.moreFacts} more)` : "";
      const callers = finding.callers.length > 0
        ? ` · callers: ${finding.callers.map((c) => `${symbolName(c.name)} ${where(c)}${tag(c.file)}`).join("; ")}`
        : "";
      out.push(
        `- ${place}${tag(finding.hit.file)}${symbol} · fact [${label}]${extra}: ${trimTo(finding.fact.title, 120)}${bodyChars > 0 ? ` — ${trimTo(finding.fact.body, bodyChars)}` : ""}${callers} · mex wiki show ${finding.fact.id}`,
      );
    }
    return out.join("\n");
  };

  let text = "";
  search: for (let lines = findings.length; lines >= withFacts.length; lines -= 1) {
    for (const bodyChars of [220, 140, 80, 0]) {
      text = render(bodyChars, lines);
      if (text.length <= GREP_NOTE_CHAR_LIMIT) break search;
    }
  }
  if (text.length > GREP_NOTE_CHAR_LIMIT) text = text.slice(0, GREP_NOTE_CHAR_LIMIT - 1) + "…";
  const ids = withFacts.map((f) => f.fact!.id);
  return { text, remember: ids, ids, pointers: withFacts.map((f) => ({ id: f.fact!.id, title: f.fact!.title, health: f.health })) };
}
