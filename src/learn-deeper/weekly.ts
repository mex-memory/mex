import { isDeepStrictEqual } from "node:util";
import type { RecordWriter } from "../record/index.js";
import { enqueueJob } from "../record/jobs.js";
import { readTeamCoverage, type TeamCoverage } from "./coverage.js";
import { ForgeClient, object, SourceError } from "./forge.js";
import { command, PinnedTree } from "./git.js";
import { hosts } from "./hosts.js";
import { MAX_DOCS, Plan, quoteCeiling, quoteTokens, reviewWindow, type LearningPlan } from "./plan.js";
import type { WeeklySchedule } from "./weekly-schedule.js";

const MAX_WEEKLY_PULLS = 24;

export class RefreshDeferred extends Error {}

/** Verify the current hosted default before reading a local commit. No Git refs are written. */
export async function weeklyHead(client: ForgeClient): Promise<string> {
  if (client.anonymous) throw new SourceError("login");
  const github = client.repo.host === "github.com";
  const base = github ? `/repos/${client.repo.slug}` : `/projects/${encodeURIComponent(client.repo.slug)}`;
  const metadata = object((await client.get(base))?.value);
  const branch = metadata?.default_branch;
  if (typeof branch !== "string" || !branch || branch.length > 255 || /[\x00-\x20\x7f]/u.test(branch)) throw new SourceError("unavailable");
  const fields = object((await client.get(`${base}${github ? "" : "/repository"}/branches/${encodeURIComponent(branch)}`))?.value);
  const commit = object(fields?.commit);
  const head = github ? commit?.sha : commit?.id;
  if (typeof head !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(head)) throw new SourceError("unavailable");
  return head;
}

export async function weeklySources(client: ForgeClient, schedule: WeeklySchedule, now: number): Promise<{ tree: PinnedTree; team: TeamCoverage }> {
  const head = await weeklyHead(client);
  const tree = await PinnedTree.open(schedule.checkout, head);
  if (!tree) throw new RefreshDeferred("The hosted default revision isn't available in this checkout. Fetch it to continue weekly learning.");
  const team = await readTeamCoverage(schedule.checkout, head, reviewWindow(new Date(now)).since);
  return { tree, team };
}

export async function quoteRefresh(client: ForgeClient, schedule: WeeklySchedule, tree: PinnedTree, now: number): Promise<LearningPlan> {
  const bounds = reviewWindow(new Date(now));
  const window = { since: new Date(Math.max(Date.parse(bounds.since), Math.min(Date.parse(schedule.since), now - 1))).toISOString(), until: bounds.until };
  const inventory = await hosts[schedule.origin.host].inventory(client, window, MAX_WEEKLY_PULLS);
  if (!isDeepStrictEqual(inventory.source, schedule.source) || inventory.visibility !== schedule.visibility) {
    throw new RefreshDeferred("Source access changed. Run `mex learn` to review a new quote before weekly learning continues.");
  }
  const changes = schedule.head === tree.head ? "" : await command(schedule.checkout, "git", ["diff", "--name-only", "--no-renames", "-z", schedule.head, tree.head, "--"], undefined, 512 << 10);
  const changed = changes === undefined ? undefined : new Set(changes.split("\0"));
  const docs = tree.docs().filter(path => !changed || changed.has(path));
  const gaps = [
    ...(inventory.more ? ["Some merged changes were outside the weekly scan limit."] : []),
    ...(docs.length > MAX_DOCS ? ["Some docs were outside the weekly scan limit."] : []),
  ];
  const estimate = quoteTokens(inventory.pulls.length, Math.min(docs.length, MAX_DOCS), schedule.agent, schedule.setup);
  return Plan.parse({ checkout: schedule.checkout, origin: schedule.origin, source: schedule.source, visibility: schedule.visibility,
    agent: schedule.agent, setup: schedule.setup, preferred: schedule.preferred, head: tree.head, ...window, pulls: inventory.pulls,
    docs: docs.slice(0, MAX_DOCS), gaps, estimate, ceiling: quoteCeiling(estimate) });
}

export async function queuePatternRecount(writer: RecordWriter, project: string, checkout: string, team?: TeamCoverage): Promise<void> {
  const [{ registerPatterns }, { snapshotNotes }, { parseEntry }, { indexDirectory, readPatterns }] = await Promise.all([
    import("../knowledge/check.js"), import("../knowledge/personal-store.js"), import("../knowledge/entry.js"), import("../file-index/store.js"),
  ]);
  const personal = [...snapshotNotes(writer, project).files.values()].map(parseEntry).filter(entry => entry.mex.status === "active");
  registerPatterns(writer.location.directory, project, [...(team?.entries ?? []), ...personal]);
  if (readPatterns(indexDirectory(writer.location.directory, project)).length) enqueueJob(writer, { kind: "file-index", projectId: project, params: { checkout, full: true } });
}
