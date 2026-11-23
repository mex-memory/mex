import { describe, expect, it } from "vitest";
import { backedBy, type Triaged } from "../cluster.js";
import type { Candidate } from "../harvest/types.js";
import { alreadyWrittenEarly, earlyClusters, earlyLessons } from "../pipeline.js";
import { learnedStatus } from "../route.js";

function item(over: { id: string; pull?: number; lesson: string; strong?: boolean; actedOn?: boolean; familiar?: boolean; at?: string }): Triaged {
  const candidate: Candidate = {
    id: over.id, kind: "review-thread", link: `https://github.com/acme/app/pull/${over.pull ?? 1}`, hash: `sha256:${"0".repeat(64)}`,
    nodeIds: [], at: over.at ?? "2026-05-01T00:00:00Z", ...(over.pull ? { pull: over.pull } : { pull: 1 }),
    path: "src/api.ts", text: over.lesson, reviewers: ["r1"],
    weights: { actedOn: over.actedOn ?? false, familiar: over.familiar ?? false, guidelineLink: false, generalising: false, smallPr: false, hotUnknown: false },
    signal: over.strong ? "strong" : "weak",
  };
  return { candidate, triage: { id: over.id, keep: true, category: "api-use", lesson: over.lesson } };
}

const lesson = "Log through `apiLogger`, not console.log, in the API.";

describe("first rules when the first batch has no strong item", () => {
  it("writes strong items and leaves the weak ones for the full window", () => {
    const strong = item({ id: "s", lesson, strong: true, actedOn: true });
    const weak = item({ id: "w", lesson: "Button colours come from the theme tokens file.", actedOn: true, at: "2026-06-01T00:00:00Z" });
    const picked = earlyLessons([weak, strong], 5);
    expect(picked.waiting).toBe(false);
    expect(picked.items.map(item => item.candidate.id)).toEqual(["s"]);
  });

  it("leaves an issue to be counted instead of writing it as a first rule", () => {
    const issue = item({ id: "issue", lesson: "Require the version handshake." });
    issue.candidate.kind = "issue";
    issue.candidate.pull = undefined;
    const picked = earlyLessons([issue], 5);
    expect(picked).toEqual({ items: [], waiting: false });
    const doc = item({ id: "doc", lesson: "Run the unit tests before pushing." });
    doc.candidate.kind = "doc";
    expect(earlyLessons([doc], 5)).toEqual({ items: [], waiting: false });
  });

  it("writes the best-supported kept items as waiting rules when nothing strong was kept", () => {
    const acted = item({ id: "acted", lesson, actedOn: true, at: "2026-04-01T00:00:00Z" });
    const familiar = item({ id: "familiar", lesson: "Pages read data through `useQuery` hooks.", familiar: true, at: "2026-06-01T00:00:00Z" });
    const bare = item({ id: "bare", lesson: "Rename this local before merging.", at: "2026-07-01T00:00:00Z" });
    const picked = earlyLessons([bare, familiar, acted], 2);
    expect(picked.waiting).toBe(true);
    expect(picked.items.map(item => item.candidate.id)).toEqual(["acted", "familiar"]);
    const clusters = earlyClusters(picked.items, picked.waiting);
    expect(clusters.map(cluster => cluster.decision)).not.toContain("drop");
    const waited = clusters.find(cluster => cluster.members.some(member => member.candidate.id === "acted"))!;
    expect(waited).toMatchObject({ decision: "propose", waiting: true });
    expect(learnedStatus(waited.waiting, false, true, false, 1)).toBe("proposed");
    expect(learnedStatus(false, false, true, false, 1)).toBe("proposed");
    expect(learnedStatus(false, false, true, false, 2)).toBe("active");
  });

  it("does not write an early member again, and keeps a waiting rule waiting when a quote covers only part of it", () => {
    const first = item({ id: "a", pull: 3, lesson, actedOn: true });
    const samePull = item({ id: "b", pull: 3, lesson, at: "2026-05-02T00:00:00Z" });
    const [cluster] = earlyClusters([first, samePull], true);
    expect(cluster.members.map(member => member.candidate.id).sort()).toEqual(["a", "b"]);
    expect(cluster).toMatchObject({ decision: "propose", waiting: true, support: 1 });
    const early = new Set(cluster.members.map(member => member.candidate.id));
    expect(alreadyWrittenEarly(cluster, early)).toBe(true);
    const later = item({ id: "c", pull: 40, lesson, strong: true });
    const joined = { ...cluster, members: [...cluster.members, later] };
    expect(alreadyWrittenEarly(joined, early)).toBe(false);
    const backed = backedBy(cluster, new Set(["a"]));
    expect(backed).toMatchObject({ decision: "propose", waiting: true });
    expect(backed.members.map(member => member.candidate.id)).toEqual(["a"]);
  });
});
