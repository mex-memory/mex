import type { Candidate } from "./harvest/types.js";
import type { Observation } from "./triage.js";

export interface DraftSupport {
  key: string;
  source: "review" | "docs" | "history";
  members: { candidate: Candidate }[];
  pulls: number[];
  reviewers: number;
  reviewerKeys: string[];
  support: number;
  commits: string[];
  observations: Observation[];
  earlier?: string;
  refused?: boolean;
}

export function draftSupport(members: Candidate[], observations: Observation[], source: DraftSupport["source"], key: string): DraftSupport {
  const pulls = [...new Set(members.flatMap(candidate => candidate.pull === undefined ? [] : [candidate.pull]))];
  const commits = [...new Set(members.filter(candidate => candidate.kind === "revert" || candidate.kind === "cause-commit")
    .flatMap(candidate => /[a-f0-9]{40,64}$/u.exec(candidate.id)?.[0] ?? []))];
  const reviewerKeys = [...new Set(members.flatMap(candidate => candidate.reviewers))];
  return { key, source, members: members.map(candidate => ({ candidate })), observations, pulls, commits,
    reviewers: reviewerKeys.length, reviewerKeys, support: pulls.length || commits.length };
}
