/**
 * Live health and the compact packet.
 *
 * Health is computed when a packet is built, from the graph's current body
 * hash against the hash each grounding recorded; the index's copy of either is
 * never trusted after an edit. A packet is deliberately small: at most two
 * entries and 4000 characters in total, one line of code locations, and the
 * command that opens the rest.
 */

import { openGraphReader, type GraphReader } from "./graph-reader.js";
import type { ContextEntity, LiveHealth } from "./types.js";

export const PACKET_CHAR_LIMIT = 4000;
export const PACKET_MAX_ENTRIES = 2;
const ENTRY_BODY_CHARS = 900;
const MAX_LOCATIONS = 3;
const MAX_CODE_LINE_CHARS = 300;
const MIN_BODY_CHARS = 120;

export interface LiveLocation {
  file: string;
  start: number;
  end: number;
  name: string;
}

export interface LiveState {
  health: LiveHealth;
  locations: LiveLocation[];
}

export type LiveStateResolver = (entity: ContextEntity) => LiveState;

/**
 * Resolve live state for the entities a packet will show.
 *
 * Opens the graph once, read-only; when it cannot be opened every entity reads
 * `unchecked` and keeps the locations the index recorded.
 */
export function resolveLiveState(scaffoldRoot: string, entities: readonly ContextEntity[]): LiveStateResolver {
  const { reader } = openGraphReader(scaffoldRoot);
  try {
    return liveStateFrom(reader, entities);
  } finally {
    reader?.close();
  }
}

/**
 * Live state from a graph handle the caller already holds (a hook event that
 * also looks up callers opens the graph once). Every row is read before this
 * returns, so the caller may close the handle afterwards.
 */
export function liveStateFrom(reader: GraphReader | null, entities: readonly ContextEntity[]): LiveStateResolver {
  const nodes = reader ? reader.nodes(entities.flatMap((e) => e.groundings.map((g) => g.node))) : null;
  return (entity) => {
    if (entity.groundings.length === 0) return { health: "none", locations: [] };
    if (nodes === null) {
      return {
        health: "unchecked",
        locations: entity.symbols.map((s) => ({ file: s.file, start: s.start, end: s.end, name: s.name })),
      };
    }
    let missing = false;
    let changed = false;
    let unverified = false;
    const locations: LiveLocation[] = [];
    for (const g of entity.groundings) {
      const node = nodes.get(g.node);
      if (node === undefined) {
        missing = true;
        continue;
      }
      locations.push({ file: node.file, start: node.start, end: node.end, name: node.name });
      if (g.bodyHash === null) unverified = true;
      else if (node.bodyHash !== g.bodyHash) changed = true;
    }
    const health: LiveHealth = missing ? "missing" : changed ? "changed" : unverified ? "unverified" : "fresh";
    return { health, locations };
  };
}

function healthLabel(health: LiveHealth, type: string): string {
  switch (health) {
    case "fresh":
      return "fresh";
    case "changed":
      return "changed ⚠ code differs from when this was written, verify before relying";
    case "missing":
      return "missing ⚠ linked code not found, verify";
    case "unverified":
      return "unverified";
    case "unchecked":
      return "unchecked";
    case "none":
      return type;
  }
}

function trimBody(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max).replace(/\s+\S*$/, "")} …`;
}

export interface PacketOptions {
  /** Entries shown at most; defaults to {@link PACKET_MAX_ENTRIES}. */
  maxEntries?: number;
  /** Paragraphs after the last entry (a pointer to further entries); they count toward the cap. */
  footer?: string[];
  /** Total cap; defaults to {@link PACKET_CHAR_LIMIT} and is never above it. */
  charLimit?: number;
  /** Starting prose length per entry. */
  bodyChars?: number;
}

export interface PacketEntry {
  entity: ContextEntity;
  live: LiveState;
  /** One more line under the code line (an event's own instruction); kept intact when the cap bites. */
  extra?: string;
}

function codeLine(entry: PacketEntry): string {
  const { entity, live } = entry;
  const more = `more: mex wiki show ${entity.id}`;
  if (live.locations.length === 0) return `source: .mex/${entity.file}:${entity.line} · ${more}`;
  let locations = live.locations
    .slice(0, MAX_LOCATIONS)
    .map((l) => `${l.file}:${l.start}-${l.end} #${l.name.replace(/^#/, "")}`)
    .join("; ");
  if (locations.length > MAX_CODE_LINE_CHARS) locations = `${locations.slice(0, MAX_CODE_LINE_CHARS - 1)}…`;
  return `code: ${locations} · ${more}`;
}

function render(entry: PacketEntry, channel: string, bodyChars: number): string {
  const { entity, live } = entry;
  const header = `MEX knowledge (${healthLabel(live.health, entity.type)} · ${channel}) — ${entity.title}`;
  const body = trimBody(entity.body, bodyChars);
  return [header, ...(body === "" ? [] : [body]), codeLine(entry), ...(entry.extra ? [entry.extra] : [])].join("\n");
}

/**
 * Format entries into one packet no longer than {@link PACKET_CHAR_LIMIT}.
 *
 * Bodies share whatever space the fixed lines leave, so the cap is met by
 * shortening prose and never by cutting a code line or a `more:` pointer.
 */
export function formatPacket(
  entries: readonly PacketEntry[],
  channel: string,
  options: PacketOptions = {},
): { text: string; shown: PacketEntry[] } {
  const kept = entries.slice(0, options.maxEntries ?? PACKET_MAX_ENTRIES);
  const footer = options.footer ?? [];
  const join = (parts: string[]): string => [...parts, ...footer].join("\n\n");
  const limit = Math.min(options.charLimit ?? PACKET_CHAR_LIMIT, PACKET_CHAR_LIMIT);
  const startChars = options.bodyChars ?? ENTRY_BODY_CHARS;
  let bodyChars = startChars;
  for (;;) {
    const text = join(kept.map((entry) => render(entry, channel, bodyChars)));
    if (text.length <= limit) return { text, shown: kept };
    if (bodyChars > MIN_BODY_CHARS) {
      bodyChars = Math.max(MIN_BODY_CHARS, Math.floor(bodyChars * 0.8));
      continue;
    }
    if (kept.length > 1) {
      kept.pop();
      bodyChars = startChars;
      continue;
    }
    return { text: text.slice(0, limit), shown: kept };
  }
}
