import { z } from "zod";
import type { KnowledgeEntry } from "../knowledge/entry.js";
import type { Candidate } from "./harvest/types.js";
import { sourceDigest } from "./source.js";

const NODE_LIMIT = 64;
const NodeId = z.string().regex(/^[A-Za-z0-9_+/=-]{1,200}$/u);
const CapturedHash = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const Group = z.object({ url: z.string().max(2048), hash: CapturedHash, nodes: z.array(NodeId).max(NODE_LIMIT), complete: z.boolean() }).strict();
export type NetworkGroup = z.infer<typeof Group>;

export const networkProofPrefix = "learning.deep.nodes.";
export const NETWORK_KIND = "learn-network";
export const networkProofKey = (id: string) => `${networkProofPrefix}${id}`;
export const networkRowKey = (url: string, hash: string) => `learning.deep.url.${sourceDigest(`${url}\n${hash}`).slice(7)}`;

export function networkGroups(entry: KnowledgeEntry, candidates: Candidate[]): NetworkGroup[] {
  return entry.mex.checks.flatMap(check => {
    if (check.kind !== "source" || !("url" in check.target) || !check.target.url) return [];
    const url = check.target.url, hash = check.saw.hash;
    const nodes = candidates.find(candidate => candidate.link === url && candidate.hash === hash)?.nodeIds ?? [];
    const valid = nodes.slice(0, NODE_LIMIT).filter(id => NodeId.safeParse(id).success);
    return [{ url, hash, nodes: valid, complete: valid.length > 0 && valid.length === nodes.length }];
  });
}

export function readNetworkGroups(raw: string): NetworkGroup[] {
  try {
    // Flat receipts from older builds cannot reconstruct the check's digest.
    const groups = z.array(Group).max(32).safeParse(JSON.parse(raw));
    return groups.success ? groups.data.filter(group => group.complete && group.nodes.length) : [];
  } catch { return []; }
}
