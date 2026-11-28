import { sourceDigest } from "../../source.js";
import { newCandidate } from "../../harvest/evidence.js";
import type { Candidate } from "../../harvest/types.js";
import type { Observation } from "../../triage.js";

export const fixturePath = "src/queue.ts";
export const fixtureNorm = "Use `queueTransport` for retry dispatch in `src/queue.ts`.";
export const fixtureAt = "2026-11-15T00:00:00.000Z";
export function candidate(number: number, text = fixtureNorm, over: Partial<Candidate> = {}): Candidate {
  const node = "IC_fixture" + number;
  return newCandidate({ id: "gh:conversation:" + node, kind: "conversation",
    link: "https://github.com/acme/transport/pull/" + number + "#issuecomment-" + number,
    pull: number, at: fixtureAt, hash: sourceDigest(text), text, nodeIds: [node],
    reviewers: [sourceDigest("fixture reviewer " + number)], changedPaths: [fixturePath], ...over });
}
export function observation(number: number, over: Partial<Observation> = {}): Observation {
  const item = candidate(number);
  return { id: sourceDigest(item.id), source: { id: item.id, hash: item.hash, link: item.link, node: item.nodeIds[0] },
    at: fixtureAt, pull: number, sourceKind: "conversation", kind: "api-design", norm: fixtureNorm, quote: fixtureNorm,
    why: "", scope: [fixturePath], form: "stated", stated_as_rule: true, response: "unknown", ...over };
}
