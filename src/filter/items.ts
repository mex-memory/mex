import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { ENTRY_KINDS, KNOWLEDGE_LIMITS, KnowledgeError, assertPersonQuote, validateEntry } from "../knowledge/entry.js";
import { assertNoSecrets, stripHidden } from "../knowledge/gates.js";
import type { FilterInput } from "./input.js";

const CheckRequest = z.object({ kind: z.enum(["key", "command", "section", "source", "value", "symbol", "pattern", "relation"]),
  role: z.enum(["complete", "supporting"]), target: z.record(z.unknown()) }).strict();
export const Item = z.object({ source_id: z.string().max(128), quote: z.string().min(1).max(8192).refine(s => s.trim().length > 0),
  label: z.enum(["task", "next-session", "lasting", "unsure"]), kind: z.enum(ENTRY_KINDS),
  scope: z.array(z.string().min(1).max(512)).min(1).max(32), text: z.string().min(1).max(8192),
  one_line: z.string().min(1).max(1024), private: z.boolean(), checks: z.array(CheckRequest).max(32),
  aliases: z.array(z.string().max(120)).max(16).optional(), asks: z.array(z.string().max(240)).max(10).optional() }).strict();
const Response = z.object({ items: z.array(z.unknown()).max(128) }).strict();
const DropReason = z.enum(["item shape", "invalid kind", "unverified quote", "invalid entry", "secret", "duplicate", "explicit note label", "changed repair claim", "unrecordable checks"]);
export const DropCounts = z.record(DropReason, z.number().int().positive().max(256));
export type DropCounts = z.infer<typeof DropCounts>;
export type Answer = z.infer<typeof Item>;

export function countDrop(dropped: DropCounts, reason: z.infer<typeof DropReason>, count = 1): void {
  dropped[reason] = (dropped[reason] ?? 0) + count;
}

// A message can supply several claims. A repair must still match the claim it was asked to update.
export const itemIdentity = (item: Answer): string => JSON.stringify([item.source_id, item.quote, item.text]);
const claim = ({ checks: _checks, aliases: _aliases, asks: _asks, ...rest }: Answer) => rest;

export function parseItems(text: string, input: FilterInput, repairs?: readonly Answer[]): { answers: Answer[]; dropped: DropCounts } {
  let items: unknown[];
  try { items = Response.parse(JSON.parse(text)).items; }
  catch { throw new Error("The filter did not return valid structured items."); }

  const messages = new Map(input.messages.map(message => [message.id, message]));
  const notes = new Map(input.notes.map(note => [note.id, note]));
  const noteOccurrences = new Map<string, number>();
  for (const item of items) {
    const id = item && typeof item === "object" && "source_id" in item ? item.source_id : undefined;
    if (typeof id === "string" && notes.has(id)) noteOccurrences.set(id, (noteOccurrences.get(id) ?? 0) + 1);
  }
  const expected = repairs && new Map(repairs.map(answer => [itemIdentity(answer), answer]));
  const identities = new Set<string>();
  const answers: Answer[] = [];
  const dropped: DropCounts = {};
  for (const item of items) {
    const parsed = Item.safeParse(item);
    if (!parsed.success) {
      countDrop(dropped, parsed.error.issues.some(issue => issue.path[0] === "kind") ? "invalid kind" : "item shape");
      continue;
    }
    const answer = parsed.data, note = notes.get(answer.source_id);
    const typed = messages.get(answer.source_id)?.text ?? note?.entry.mex.source.quote;
    if (!typed?.includes(answer.quote) || stripHidden(answer.quote) !== answer.quote || answer.quote.includes("[secret removed]")) {
      countDrop(dropped, "unverified quote");
      continue;
    }
    if (note && answer.label !== "lasting") { countDrop(dropped, "explicit note label"); continue; }
    try {
      if (Buffer.byteLength(JSON.stringify(answer)) > KNOWLEDGE_LIMITS.entryBytes) {
        countDrop(dropped, "invalid entry");
        continue;
      }
      assertNoSecrets(answer);
      const entry = validateEntry({ text: stripHidden(answer.text), mex: { id: "mx_filter0", kind: answer.kind, scope: answer.scope,
        source: { type: "person", ref: answer.source_id, quote: answer.quote }, evidence: "person", one_line: stripHidden(answer.one_line),
        checks: [], status: "active", created: "2000-01-01" } });
      assertPersonQuote(entry, typed);
      answer.text = entry.text;
      answer.one_line = entry.mex.one_line;
      assertNoSecrets({ text: answer.text, one_line: answer.one_line });
    } catch (error) {
      countDrop(dropped, error instanceof KnowledgeError && error.code === "SECRET_FOUND" ? "secret" : "invalid entry");
      continue;
    }
    const identity = itemIdentity(answer);
    const original = expected?.get(identity);
    if (expected && (!original || !isDeepStrictEqual(claim(original), claim(answer)))) {
      countDrop(dropped, "changed repair claim");
      continue;
    }
    // More than one result for an explicit note leaves its proposed update ambiguous.
    if ((noteOccurrences.get(answer.source_id) ?? 0) > 1 || identities.has(identity)) {
      countDrop(dropped, "duplicate");
      continue;
    }
    identities.add(identity);
    answers.push(answer);
  }
  return { answers, dropped };
}
