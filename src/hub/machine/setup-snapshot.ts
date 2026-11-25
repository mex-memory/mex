import type { MachineRepoSetup, MachineSetupRepoStatus, MachineSetupStep } from "@mex/hub-contracts/machine";
import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { checkoutOn } from "../../controls/index.js";
import { containedDirectory } from "../../knowledge/files.js";
import { hasSecret, stripHidden } from "../../knowledge/gates.js";
import type { CheckoutRow, ProjectRow, RecordReader } from "../../record/index.js";
import { TERMINAL_STATES, type JobRow } from "../../record/jobs.js";
import type { RecordLocation } from "../../record/location.js";
import { readFactFile, type SetupRun } from "../../repo-start/facts.js";
import type { CodeFactsFile } from "../../repo-start/history/job.js";
import { readSetupSteps, readSetupStepRows, setupStepCheckout, type SetupStep } from "../../repo-start/steps.js";
import { machineCheckouts, machinePath, machineProjects, machineTime } from "./machine-projects.js";
import { mostRecentCheckout } from "./read.js";

type SetupReader = Pick<RecordReader, "all" | "get" | "setting">;
type StepGuard = Pick<JobRow, "id" | "project_id" | "kind" | "state" | "params" | "request" | "reason">;

export function setupRevision(inputs: unknown): string {
  return createHash("sha256").update(JSON.stringify(inputs)).digest("hex");
}

export function stepRevision({ id, project_id, kind, state, params, request, reason }: StepGuard): string {
  return setupRevision([id, project_id, kind, state, params, request, reason]);
}

function safeLine(value: string) {
  const text = stripHidden(value);
  return text && !hasSecret(text) ? text.slice(0, 1_000) : undefined;
}

export function hubSetupStep(step: SetupStep, row: StepGuard): MachineSetupStep {
  const progress = step.progress && safeLine(step.progress.message);
  return {
    ...step,
    scope: step.scope && machinePath(step.scope) ? step.scope : null,
    startedAt: machineTime(step.startedAt) ?? step.startedAt,
    finishedAt: machineTime(step.finishedAt),
    summary: step.summary && safeLine(step.summary) || undefined,
    error: step.error && safeLine(step.error) || undefined,
    progress: progress ? { ...step.progress, message: progress } : undefined,
    pending: row.state === "running" ? row.request ?? undefined : undefined,
    revision: stepRevision(row),
  };
}

export interface SetupTarget {
  repoId: string;
  kind: ProjectRow["kind"];
  checkout: CheckoutRow;
  run?: SetupRun;
  missing: boolean;
  enabled: boolean;
}

function setupRun(location: RecordLocation, repoId: string) {
  if (!containedDirectory(location.home, ["projects", repoId])) return;
  const run = readFactFile<SetupRun>(location, repoId, "setup.json");
  return run && machineTime(run.last_run) ? run : undefined;
}

function checkoutExists(path: string) {
  return lstatSync(path, { throwIfNoEntry: false })?.isDirectory() === true;
}

function selectTarget(
  reader: SetupReader, hooks: RecordReader | undefined, location: RecordLocation, now: number,
  repoId: string, kind: ProjectRow["kind"], checkouts: CheckoutRow[],
): SetupTarget | undefined {
  const run = setupRun(location, repoId);
  // Older setup records have no checkout. Use the newest earlier free job's
  // scope so a later learning run or index refresh doesn't relabel that setup.
  const job = !run?.checkout && reader.get<Pick<JobRow, "params">>(`SELECT params FROM jobs WHERE project_id=?
    AND kind IN ('file-index','code-facts','graph-build') AND created_at<=?
    ORDER BY created_at DESC, id DESC LIMIT 1`, repoId, run?.last_run ?? new Date(now).toISOString());
  const path = run?.checkout ?? (job && setupStepCheckout(job));
  const checkout = checkouts.find(row => row.path === path)
    ?? checkouts.find(row => row.path === mostRecentCheckout(hooks, repoId, checkouts.map(({ path }) => path)))
    ?? checkouts[0];
  if (!checkout) return;
  return {
    repoId, kind, checkout, run, missing: !checkoutExists(checkout.path),
    enabled: checkoutOn(checkout, now) && reader.setting("global", "enabled") !== "false",
  };
}

export function readSetupTarget(reader: SetupReader, hooks: RecordReader | undefined, location: RecordLocation, repoId: string, now: number) {
  const project = reader.get<ProjectRow>("SELECT id,kind FROM projects WHERE id=?", repoId);
  if (!project) return;
  const { checkouts } = machineCheckouts(reader, repoId);
  return selectTarget(reader, hooks, location, now, repoId, project.kind, checkouts);
}

function statusFor(target: SetupTarget | undefined, rows: readonly JobRow[]): MachineSetupRepoStatus["status"] {
  if (target?.missing) return "missing";
  if (rows.some(({ state }) => state === "failed")) return "failed";
  if (rows.some(({ state }) => !TERMINAL_STATES.includes(state))) return "running";
  if (rows.some(({ state }) => state === "cancelled")) return "stopped";
  if (rows.some(({ state }) => state === "done with gaps")) return "doneWithGaps";
  return target?.run || rows.length ? "done" : "notStarted";
}

export function readSetupIndex(reader: RecordReader | undefined, hooks: RecordReader | undefined, location: RecordLocation, now: number) {
  const { projects } = machineProjects(reader);
  return projects.map(({ id, kind, checkouts }): MachineSetupRepoStatus => {
    const target = selectTarget(reader!, hooks, location, now, id, kind, checkouts);
    return { repoId: id, checkout: target?.checkout.path, status: statusFor(target, readSetupStepRows(reader!, id)) };
  });
}

function plural(count: number, unit: string) {
  return `${count.toLocaleString("en-US")} ${unit}${count === 1 ? "" : "s"}`;
}

function setupSummary(run: SetupRun | undefined): MachineRepoSetup["summary"] {
  const findings: MachineRepoSetup["summary"]["findings"] = [];
  const found = run?.found;
  if (found?.recipes === 0) findings.push({ label: "Commands", text: "No commands found in config." });
  if (Number.isSafeInteger(found?.recipes) && found!.recipes > 0) {
    const packages = Number.isSafeInteger(found!.packages) && found!.packages > 1 ? ` across ${plural(found!.packages, "package")}` : "";
    findings.push({ label: "Commands", text: `Found ${plural(found!.recipes, "command")}${packages} in config.` });
  }
  if (Number.isSafeInteger(found?.rule_files) && found!.rule_files > 0) {
    const conflicts = Number.isSafeInteger(found!.rule_conflicts) && found!.rule_conflicts > 0
      ? ` ${plural(found!.rule_conflicts, "disagreement")} found.` : "";
    findings.push({ label: "Rule files", text: `Read ${plural(found!.rule_files, "file")}.${conflicts}` });
  }
  if (Number.isSafeInteger(found?.hints) && found!.hints > 0) {
    findings.push({ label: "Agent memory", text: `Offered ${plural(found!.hints, "note")} as hints.` });
  }
  return {
    findings,
    ...(run && Number.isSafeInteger(run.ms) && run.ms >= 0 ? { elapsedMs: run.ms } : {}),
    ...(run?.commands_saved === true ? { commandsSaved: true } : {}),
  };
}

export function readSetupFacts(location: RecordLocation, target: SetupTarget, codeFactsCheckout?: string | null) {
  if (!containedDirectory(location.home, ["projects", target.repoId])) return;
  const facts = readFactFile<CodeFactsFile>(location, target.repoId, "code-facts.json");
  if (facts && (facts.checkout ?? codeFactsCheckout ?? target.run?.checkout) === target.checkout.path) return facts;
}

export function setupOfferRevision({ checkout, repoId, run }: SetupTarget) {
  return setupRevision([repoId, checkout.path, run?.last_run]);
}

export function readRepoSetup(
  reader: RecordReader | undefined, hooks: RecordReader | undefined, location: RecordLocation, repoId: string, now: number, env: NodeJS.ProcessEnv,
): MachineRepoSetup | null {
  const target = reader && readSetupTarget(reader, hooks, location, repoId, now);
  if (!reader || !target) return null;
  const steps = readSetupSteps(reader, repoId);
  if (!target.run && !steps.length && !target.missing) return null;
  const rows = reader.all<StepGuard>(`SELECT id,project_id,kind,state,params,request,reason FROM jobs
    WHERE id IN (SELECT value FROM json_each(?))`, JSON.stringify(steps.map(({ jobId }) => jobId)));
  const byId = new Map(rows.map(row => [row.id, row]));
  const stepViews = steps.flatMap(step => {
    const row = byId.get(step.jobId);
    return row && row.state === step.state ? [hubSetupStep(step, row)] : [];
  });
  const repo: MachineRepoSetup = {
    repoId, checkout: target.checkout.path, steps: stepViews, questions: [], summary: setupSummary(target.run),
    ...(target.missing ? { missingCheckout: true } : {}),
  };
  if (target.missing) return repo;
  const codeFacts = steps.find(({ kind }) => kind === "code-facts");
  const facts = readSetupFacts(location, target, codeFacts?.scope);
  if (!codeFacts) {
    if (target.checkout.provisional === "shallow" || facts?.skipped === "shallow clone") {
      repo.unavailableSteps = [{ kind: "code-facts", reason: "Git history skipped. This is a shallow clone." }];
    } else if (facts?.skipped === "no git") {
      repo.unavailableSteps = [{ kind: "code-facts", reason: "Needs a Git repo." }];
    }
  }
  if (!steps.some(({ kind }) => kind === "learn-deeper") && target.run?.caller === "person") {
    if (!target.enabled || env.MEX_OFF === "1") {
      repo.learnDeeper = { state: "unavailable", reason: "MEX is off here. Run `mex on` in the terminal." };
    } else {
      repo.offerRevision = setupOfferRevision(target);
    }
  }
  return repo;
}
