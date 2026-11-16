import { describe, expect, it } from "vitest";
import { promotionDecision, type Evidence, type PromotionPolicy } from "../evidence.js";
const observation = { session: "one", verified: true, lasting: true, marked: false, delivered: false };
const policy = (evidence: Evidence, extra: Partial<PromotionPolicy> = {}): PromotionPolicy => ({ evidence, shared: true, manual: false, visibility: "private", authorized: true, privacyHolds: [], checksHold: true, conflict: false, ...extra });
const person: Evidence = { source: "person", observations: [observation] };
describe("code-enforced team evidence fixture table", () => {
  it.each([
    ["lasting person", policy(person), "team", "eligible"],
    ["temporary person", policy({ source: "person", observations: [{ ...observation, lasting: false }] }), "personal", "insufficient-evidence"],
    ["independent unsure repeat", policy({ source: "person", observations: [{ ...observation, lasting: false }, { ...observation, lasting: false, session: "two" }] }), "team", "eligible"],
    ["repeated inside one session", policy({ source: "person", observations: [{ ...observation, lasting: false }, { ...observation, lasting: false }] }), "personal", "insufficient-evidence"],
    ["delivered-note echo", policy({ source: "person", observations: [{ ...observation, delivered: true }] }), "personal", "insufficient-evidence"],
    ["pasted or scripted", policy({ source: "person", observations: [{ ...observation, marked: true }] }), "personal", "insufficient-evidence"],
    ["quote unavailable", policy({ source: "person", observations: [{ ...observation, verified: false }] }), "personal", "insufficient-evidence"],
    ["private detail", policy(person, { privacyHolds: ["new-name"] }), "personal", "privacy"],
    ["first share pending", policy(person, { shared: false }), "personal", "not-shared"],
    ["manual sharing", policy(person, { manual: true }), "personal", "manual-sharing"],
    ["unknown contributor", policy(person, { authorized: false }), "personal", "source-authority"],
    ["public repository", policy(person, { visibility: "public" }), "review", "public-session"],
    ["unknown visibility", policy(person, { visibility: "unknown" }), "review", "public-session"],
    ["check stopped it", policy(person, { checksHold: false }), "review", "checks"],
    ["recorded decision conflict", policy(person, { conflict: true }), "review", "team-conflict"],
    ["unconfirmed agent claim", policy({ source: "observed" }), "personal", "insufficient-evidence"],
    ["agent memory alone", policy({ source: "agent-memory" }), "personal", "insufficient-evidence"],
    ["observed and corroborated", policy({ source: "observed", corroboration: { kind: "script", verified: true, sameClaim: true } }), "team", "eligible"],
    ["coincidental command success", policy({ source: "observed", corroboration: { kind: "ci", verified: true, sameClaim: false } }), "personal", "insufficient-evidence"],
  ] as const)("%s", (_name, input, destination, reason) => expect(promotionDecision(input)).toEqual({ destination, reason }));
  it.each(["docs", "ci", "review"] as const)("requires two distinct authorized merged PRs for %s", source => {
    const one = { repository: "team/project", number: 1, merged: true, authorized: true };
    expect(promotionDecision(policy({ source, pullRequests: [one, one] })).destination).toBe("personal");
    expect(promotionDecision(policy({ source, pullRequests: [one, { ...one, number: 2 }] })).destination).toBe("team");
    for (const altered of [{ ...one, repository: "other/project", number: 2 }, { ...one, merged: false, number: 2 }, { ...one, authorized: false, number: 2 }])
      expect(promotionDecision(policy({ source, pullRequests: [one, altered] })).destination).toBe("personal");
  });
  it("rejects unrecognized corroboration kinds", () => {
    expect(promotionDecision(policy({ source: "observed", corroboration: { kind: "assistant" as never, verified: true, sameClaim: true } })).destination).toBe("personal");
  });
});
