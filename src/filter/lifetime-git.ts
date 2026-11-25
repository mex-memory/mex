import { z } from "zod";
import { nativeBinary } from "../knowledge/check.js";
import { command } from "../learn-deeper/git.js";
import { isVersion, newerVersion } from "../version-order.js";

const Head = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);
const MaybeHead = z.union([Head, z.literal("")]);
export const NoteBranch = z.object({ name: z.string().min(1).max(1024),
  head: Head, unmerged_head: MaybeHead }).strict();
export type NoteBranch = z.infer<typeof NoteBranch>;
const BranchState = z.object({ matches: z.boolean(), unmerged_head: MaybeHead, merged: z.boolean(), tip: MaybeHead }).strict();
const ReleaseTag = z.object({ name: z.string(), time: z.number().int().safe().nonnegative() }).strict();
const Reply = z.object({ branches: z.array(BranchState).max(64), tags: z.array(ReleaseTag).nullable() }).strict();
export interface LifetimeGit {
  branches: ReadonlyMap<string, z.infer<typeof BranchState>>;
  /** null means the repository has no release tag. undefined means it was unobservable. */
  release?: string | null;
  tags?: readonly z.infer<typeof ReleaseTag>[];
}
export const branchKey = (branch: NoteBranch) => JSON.stringify([branch.name, branch.head, branch.unmerged_head]);

export function latestRelease(tags: readonly string[]): string | null {
  let latest: string | null = null;
  for (const tag of tags) {
    const version = tag.replace(/^v/u, "").replace(/\+[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*$/u, "");
    if (isVersion(version) && (latest === null || newerVersion(version, latest))) latest = version;
  }
  return latest;
}

/** Use the native continuity merge check off the hook path. No refs are fetched or changed. */
export async function observeLifetimeGit(checkout: string, sources: readonly NoteBranch[], releases: boolean): Promise<LifetimeGit> {
  const branches = new Map<string, z.infer<typeof BranchState>>();
  const snapshot: LifetimeGit = { branches };
  if (!sources.length && !releases) return snapshot;
  const binary = nativeBinary();
  if (!binary) return snapshot;
  const unique = [...new Map(sources.map(source => [branchKey(source), source])).values()];
  for (let start = 0; start < Math.max(unique.length, 1); start += 64) {
    const batch = unique.slice(start, start + 64);
    const raw = await command(checkout, binary, ["--session-lifetimes"],
      JSON.stringify({ checkout, branches: batch, tags: releases && start === 0 }), 2 << 20, 8_000);
    if (!raw) continue;
    try {
      const response = Reply.parse(JSON.parse(raw));
      if (response.branches.length !== batch.length) continue;
      batch.forEach((source, i) => branches.set(branchKey(source), response.branches[i]!));
      if (start === 0 && response.tags) {
        snapshot.tags = response.tags;
        snapshot.release = latestRelease(response.tags.map(tag => tag.name));
      }
    } catch { /* Missing Git evidence cannot retire a note. */ }
  }
  return snapshot;
}
