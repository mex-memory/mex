import { isDeepStrictEqual } from "node:util";
import type { RecordWriter } from "../record/index.js";
import { enqueueJob } from "../record/jobs.js";
import { readTeamCoverage, teamRetired, type TeamCoverage } from "./coverage.js";
import { ForgeClient, object, SourceError } from "./forge.js";
import { PinnedTree } from "./git.js";
import { hosts } from "./hosts.js";
import { Plan, reviewWindow, type LearningPlan } from "./plan.js";
import type { WeeklySchedule } from "./weekly-schedule.js";

import { harvestClient } from "./pipeline.js";
import { planHarvest, type HarvestCursor } from "./harvest/index.js";
import { propose } from "../knowledge/gate.js";
import { snapshotNotes } from "../knowledge/personal-store.js";
import type { BatchContext } from "../record/jobs.js";
import { noteKey } from "./coverage.js";

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

export async function planWeekly(client: ForgeClient, schedule: WeeklySchedule, tree: PinnedTree, now: number,
  cursor: HarvestCursor | undefined, issues: boolean): Promise<LearningPlan> {
  const access = await hosts[schedule.origin.host].access(client);
  if (!isDeepStrictEqual(access.source, schedule.source) || access.visibility !== schedule.visibility) {
    throw new RefreshDeferred("Source access changed. Run mex learn to review a new quote before weekly learning continues.");
  }
  const bounds = reviewWindow(new Date(now));
  const start = Math.min(Date.parse(schedule.since), Date.parse(cursor?.weekly?.window.since ?? schedule.since), now - 1);
  const window = { since: new Date(Math.max(Date.parse(bounds.since), start)).toISOString(), until: bounds.until };
  const harvest = await planHarvest({ checkout: schedule.checkout, head: tree.head, defaultHead: tree.head, source: schedule.source,
    agent: schedule.agent, ...window, mode: "weekly", issues }, { client: harvestClient(client, schedule.source), tree }, cursor);
  return Plan.parse({ checkout: schedule.checkout, origin: schedule.origin, source: schedule.source, visibility: schedule.visibility,
    agent: schedule.agent, setup: schedule.setup, preferred: schedule.preferred, head: tree.head, ...window,
    pulls: [], docs: [], gaps: harvest.gaps.slice(0, 12), estimate: Math.max(1, harvest.estimate), ceiling: Math.max(1, harvest.ceiling), harvest });
}

/**
 * Retire the person's copies of rules the team retired on the default branch: by id, by the stable source both were
 * learned from, or by claim (the team may have deleted the rule before manifests existed).
 */
export async function sweepWeeklyRetirements({ writer, job }: BatchContext, plan: LearningPlan, team: TeamCoverage): Promise<void> {
  if (!team.retired.size && !team.retiredIds.size && !team.retiredEvidence.size) return;
  const swept = new Set<string>();
  const notes = snapshotNotes(writer, job.project_id!).files;
  await propose([], {
    projectPath: plan.checkout, home: writer.location.home,
    sweep: { producer: "learn-deeper",
      includes(entry) {
        const retired = teamRetired(team, entry, notes.get(entry.mex.id), writer.setting(job.project_id!, noteKey(entry.mex.id)));
        if (retired) swept.add(entry.mex.id);
        return retired;
      },
      tombstone: { reason: "The matching rule was retired on the default branch.", by: "mex learn" },
    },
    validate(gate) {
      const live = gate.db.prepare("SELECT owner,state FROM jobs WHERE id=?").get(job.id);
      if (live?.owner !== job.owner || live?.state !== "running") throw new Error("Learning lost its job before saving.");
    },
    onAccepted(gate) {
      const remove = gate.db.prepare("DELETE FROM settings WHERE scope=? AND key=?");
      for (const id of swept) remove.run(job.project_id!, noteKey(id));
    },
  });
}

export async function queuePatternRecount(writer: RecordWriter, project: string, checkout: string, team?: TeamCoverage): Promise<void> {
  const [{ registerPatterns }, { snapshotNotes }, { parseEntry }, { indexDirectory, readPatterns }] = await Promise.all([
    import("../knowledge/check.js"), import("../knowledge/personal-store.js"), import("../knowledge/entry.js"), import("../file-index/store.js"),
  ]);
  const personal = [...snapshotNotes(writer, project).files.values()].map(parseEntry).filter(entry => entry.mex.status === "active");
  registerPatterns(writer.location.directory, project, [...(team?.entries ?? []), ...personal]);
  if (readPatterns(indexDirectory(writer.location.directory, project)).length) enqueueJob(writer, { kind: "file-index", projectId: project, params: { checkout, full: true } });
}
