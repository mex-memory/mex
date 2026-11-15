/**
 * Bare `mex` (and `mex setup`): the yes for this repository.
 *
 * Install hooks, register the checkout and its worktrees, hide `.mex/` through
 * git's exclude file, run the free local reads, queue background work, and
 * show the first screen. No network, no model, no repository command; the
 * only git commands are read-only and bounded.
 */
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { performance } from "node:perf_hooks";
import type { CheckoutRow, RecordWriter } from "../record/index.js";
import { detectCaller, type Caller } from "./caller.js";
import { classifyPlace, displayPath, type Place } from "./place.js";
import { renderDone, renderFindings, renderHeader, renderNotes, screenMode, type Finding } from "./screen.js";
import type { FinishJob } from "./finish.js";

/** Test-only: kill the process at a step boundary to prove each one leaves a clean state. */
export const KILL_AT_VARIABLE = "MEX_REPO_START_KILL_AT";
export const KILL_POINTS = ["installed", "registered", "hidden", "queued", "free-step", "facts", "waiting"] as const;
/** How long `mex` waits for its own work before leaving it to the background process. */
export const WAIT_CAP_MS = { person: 10 * 60_000, other: 100_000 } as const;
export type KillPoint = typeof KILL_POINTS[number];

export interface RepoStartOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Lines go here; defaults to stdout. */
  write?: (line: string) => void;
  /** Milliseconds since command start; defaults to the process clock. */
  elapsed?: () => number;
  caller?: Caller;
  /** Defaults to MEX_INSTALL_AUTO; tests and the background process skip hook installation. */
  install?: boolean;
  /** `--folder`: the yes for a folder that isn't a git repo, without the question. */
  folder?: boolean;
  /** Whether questions may be asked; defaults to true only for a person at a terminal. */
  interactive?: boolean;
  ask?: (lines: readonly string[]) => Promise<boolean>;
  /** `--no-wait`: leave the file index and git history to the background process. Waiting is the default. */
  wait?: boolean;
  /** How long to wait before handing the work on; defaults to WAIT_CAP_MS for the caller. */
  waitCapMs?: number;
}
export interface RepoStartResult {
  exitCode: number;
  place: Place["kind"];
  projectId?: string;
  /** True when MEX is on here after this run. */
  turnedOn: boolean;
  /** A folder without git that only a person can turn on. */
  folderQuestion?: true;
  /** A paid offer that is due; agents and scripts only print its command. */
  offer?: { question: string; estimate: string; command: string };
  /** Stopped waiting with work still running in this process: the caller exits now, and the background process takes over. */
  exitNow?: true;
}

/** Test-only: a short wait, to prove a run that stops waiting hands its work on. */
function testWaitCap(env: NodeJS.ProcessEnv): number | undefined {
  const value = Number(env.MEX_TEST_WAIT_CAP_MS);
  return env.MEX_TEST_WAIT_CAP_MS !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function killAt(point: KillPoint, env: NodeJS.ProcessEnv): void {
  if (env[KILL_AT_VARIABLE] === point) process.kill(process.pid, "SIGKILL");
}

function checkoutOn(row: CheckoutRow, now = Date.now()): boolean {
  if (row.state === "on") return true;
  return row.state === "off until" && Number.isFinite(Date.parse(String(row.off_until))) && Date.parse(String(row.off_until)) <= now;
}

const AGENT_NAMES = { "claude-code": "Claude Code", codex: "Codex" } as const;
const MEMORY_NAMES = { "claude-code": "Claude", codex: "Codex" } as const;
function list(names: string[]): string {
  return names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}
function message(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.split(/\r?\n/u)[0]!.slice(0, 200);
}

interface HookSummary { note?: string; notices: string[]; }
async function installHooks(): Promise<HookSummary> {
  try {
    const { installAgents } = await import("../install/index.js");
    const result = await installAgents();
    if (!result.agents.length) return { note: "No supported agent found. Install Claude Code or Codex, then run `mex install`.", notices: [] };
    const where = result.agents.map(agent => AGENT_NAMES[agent]);
    return {
      note: `Hooks: ${list(where)}, in your user settings.`,
      // The trust and timing notices matter when hooks first change; repeat runs stay quiet.
      notices: result.changes.length ? result.notices : [],
    };
  } catch (error) {
    return { note: `Hooks weren't installed: ${message(error)} (\`mex install\` shows the details).`, notices: [] };
  }
}

interface NotesFound { count: number; agents: string[]; }
async function readAgentMemory(root: string): Promise<NotesFound | undefined> {
  try {
    const { refreshHints, hintStatus } = await import("../knowledge/hints.js");
    const refreshed = refreshHints({ projectPath: root });
    const agents = (Object.keys(MEMORY_NAMES) as Array<keyof typeof MEMORY_NAMES>)
      .filter(agent => refreshed.agents[agent] !== undefined && refreshed.agents[agent] !== "missing")
      .map(agent => MEMORY_NAMES[agent]);
    return { count: hintStatus({ projectPath: root }).active, agents };
  } catch { return undefined; }
}

/** Read the repo's rule files (knowledge-05) and save their scan; the line names `mex rules` when some need review. */
async function readRules(root: string, listing?: Promise<string[] | undefined>): Promise<{ files: number; conflicts: number; line: string } | undefined> {
  try {
    const { refreshRuleFiles } = await import("../knowledge/rule-cache.js");
    const cache = refreshRuleFiles({ projectPath: root }, new Date(), await listing);
    const conflicts = cache.review.filter(item => item.kind === "conflict").length;
    const stale = cache.review.filter(item => item.kind === "stale").length;
    const parts = [`${cache.files.length} rule ${cache.files.length === 1 ? "file" : "files"} read`];
    if (conflicts) parts.push(`${conflicts} ${conflicts === 1 ? "disagrees" : "disagree"}`);
    if (stale) parts.push(`${stale} ${stale === 1 ? "mention" : "mentions"} out of date`);
    return { files: cache.files.length, conflicts, line: `${parts.join("; ")}${conflicts || stale ? ", see `mex rules`" : ""}` };
  } catch { return undefined; }
}

/** Read recipes and save recipes.json; a failure leaves the line out rather than stopping the screen. */
async function readRecipes(root: string, projectId: string, env: NodeJS.ProcessEnv) {
  try {
    const [{ scanRecipes }, { nativeBinary }, { recordLocation }, { writeFactFile }] = await Promise.all([
      import("./recipes/index.js"), import("../knowledge/check.js"), import("../record/location.js"), import("./facts.js"),
    ]);
    const location = recordLocation();
    const file = scanRecipes({ root, binary: nativeBinary(env), projectId, recordDirectory: location.directory });
    writeFactFile(location, projectId, "recipes.json", file);
    return file;
  } catch { return undefined; }
}

/** Ask a yes/no question on the terminal; anything but y or yes is no. */
export async function askYesNo(lines: readonly string[], write: (line: string) => void): Promise<boolean> {
  const { createInterface } = await import("node:readline");
  for (const line of lines.slice(0, -1)) write(line);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>(resolve => {
      rl.question(`${lines.at(-1)} `, resolve);
      rl.once("close", () => resolve(""));
    });
    return /^\s*y(es)?\s*$/iu.test(answer);
  } finally { rl.close(); }
}

export async function runRepoStart(options: RepoStartOptions = {}): Promise<RepoStartResult> {
  const env = options.env ?? process.env;
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const elapsed = options.elapsed ?? (() => performance.now());
  const caller = options.caller ?? detectCaller({ env });
  // Only a person at a terminal is ever asked; agents and scripts get the exact command.
  const interactive = options.interactive ?? caller === "person";
  const ask = options.ask ?? ((lines: readonly string[]) => askYesNo(lines, write));
  const mode = screenMode({ env });
  const install = options.install ?? (env.MEX_INSTALL_AUTO !== "0" && env.MEX_BACKGROUND !== "1");

  const hooks: HookSummary = install ? await installHooks() : { notices: [] };
  killAt("installed", env);

  const place = classifyPlace(options.cwd ?? process.cwd());
  if (place.kind === "refused") {
    write(place.reason === "drive-root"
      ? `MEX doesn't turn on at a drive root (${displayPath(place.root)}). Run \`mex\` inside a project folder.`
      : `MEX doesn't turn on in your home folder or above it (${displayPath(place.root)}); its hooks would cover every session below. Run \`mex\` inside a project folder.`);
    return { exitCode: 1, place: place.kind, turnedOn: false };
  }

  const { openRecord } = await import("../record/index.js");
  if (place.kind === "folder") {
    const { FOLDER_COMMAND, FOLDER_QUESTION } = await import("./folder.js");
    // A folder already turned on needs no question.
    const { openRecordReadOnly } = await import("../record/index.js");
    const reader = openRecordReadOnly();
    let known = false;
    try { known = !!reader?.get("SELECT 1 AS found FROM checkouts WHERE path=?", place.root); } finally { reader?.close(); }
    if (!known && !options.folder) {
      if (!interactive) {
        write(`${displayPath(place.root)} isn't a git repo, so MEX didn't turn it on. To turn it on for this folder, run: ${FOLDER_COMMAND}`);
        return { exitCode: 0, place: place.kind, turnedOn: false, folderQuestion: true };
      }
      if (!await ask(FOLDER_QUESTION)) {
        write("MEX stays off here.");
        return { exitCode: 0, place: place.kind, turnedOn: false };
      }
    }
  }

  const findings: Finding[] = [];
  const notes: string[] = [];
  const finishJobs: FinishJob[] = [];
  const waiting = options.wait !== false;
  let writer: RecordWriter | undefined = openRecord();
  let projectId: string, checkout: CheckoutRow, hidden = false;
  const git = place.kind === "git";
  const shallow = place.kind === "git" && place.shallow;
  try {
    if (place.kind === "git") {
      const { turnOnRepository } = await import("./turn-on.js");
      const turnedOn = turnOnRepository(writer, place.root, undefined, { top: place.root, shallow: place.shallow, commonDir: place.commonDir });
      projectId = turnedOn.projectId; checkout = turnedOn.checkout;
    } else {
      const { turnOnFolder } = await import("./folder.js");
      const turnedOn = turnOnFolder(writer, place.root);
      projectId = turnedOn.projectId; checkout = turnedOn.checkout;
    }
    killAt("registered", env);
    if (!checkoutOn(checkout)) {
      write(`MEX is off for this ${git ? "repo" : "folder"}${checkout.state === "off until" ? ` until ${checkout.off_until}` : ""}. Run \`mex on\` to turn it back on.`);
      return { exitCode: 0, place: place.kind, projectId, turnedOn: false };
    }

    if (place.kind === "git") {
      const { ensureExcludeBlock, REPO_START_BLOCK, REPO_START_LINES } = await import("./exclude.js");
      try {
        ensureExcludeBlock(writer, place.excludeFile, REPO_START_BLOCK, REPO_START_LINES);
        hidden = true;
      } catch (error) {
        findings.push({ state: "attention", text: `Couldn't hide .mex/ in git's exclude file: ${message(error)}` });
      }
    } else {
      const { writeFolderMarker } = await import("./folder.js");
      try { writeFolderMarker(writer, checkout.path, projectId); } catch { /* the marker only helps a later reattach */ }
    }
    killAt("hidden", env);

    const { automaticWorkEnabled } = await import("../controls/index.js");
    if (!automaticWorkEnabled(writer, projectId)) {
      findings.push({ state: "attention", text: "MEX is off everywhere, so nothing was read or queued. `mex on --all` turns it back on." });
    } else {
      // The rule-file scan's file list walks the whole tree for untracked files; start it now so
      // it runs while recipes are read.
      const { listRepositoryFilesAsync } = await import("../knowledge/rule-files.js");
      const listing = listRepositoryFilesAsync(checkout.path);
      const { queueIndexBuild } = await import("../file-index/command.js");
      finishJobs.push({ id: queueIndexBuild(writer, projectId, checkout.path), kind: "file-index" });
      // Queued after the index, so layer rules can read its imports.
      if (git && !shallow) {
        const { queueJob } = await import("../record/background.js");
        finishJobs.push({ id: queueJob(writer, { kind: "code-facts", projectId, params: { checkout: checkout.path } }).job.id, kind: "code-facts" });
      }
      killAt("queued", env);
      writer.close(); writer = undefined;

      // The free step: local reads only, no network, no model, no repository command.
      const recipes = await readRecipes(checkout.path, projectId, env);
      if (recipes) {
        const { recipeSummary } = await import("./recipes/index.js");
        const summary = recipeSummary(recipes);
        findings.push({ state: "ok", text: git ? summary.line : summary.line.replace("this repo", "this folder") });
        for (const note of summary.notes.slice(0, 3)) findings.push({ state: "attention", text: note });
      }
      const rules = await readRules(checkout.path, listing);
      if (rules && rules.files > 0) findings.push({ state: "ok", text: rules.line });
      const memory = await readAgentMemory(checkout.path);
      if (memory && memory.count > 0) {
        findings.push({ state: "ok", text: `${memory.count} ${memory.count === 1 ? "note" : "notes"} from your ${list(memory.agents) || "agents'"} memory` });
      }
      killAt("free-step", env);
      if (shallow) findings.push({ state: "attention", text: "Git history: skipped, this is a shallow clone (`git fetch --unshallow` to add it)" });
      // Waiting, the results take these lines' place once the work is done.
      if (!waiting) {
        if (shallow) findings.push({ state: "background", text: "The file index: in the background (`mex jobs`)" });
        else if (git) findings.push({ state: "background", text: "Git history and the file index: in the background (`mex jobs`)" });
        else findings.push({ state: "background", text: "The file index: in the background (`mex jobs`); no git history here" });
      }

      const { recordLocation } = await import("../record/location.js");
      const { writeFactFile } = await import("./facts.js");
      try {
        writeFactFile(recordLocation(), projectId, "setup.json", {
          version: 1, last_run: new Date().toISOString(), ms: Math.round(elapsed()), caller,
          found: {
            packages: new Set(recipes?.recipes.map(recipe => recipe.package) ?? []).size, recipes: recipes?.recipes.length ?? 0,
            rule_files: rules?.files ?? 0, rule_conflicts: rules?.conflicts ?? 0, hints: memory?.count ?? 0,
          },
          exclude: { file: place.kind === "git" ? place.excludeFile : null, block: hidden },
        });
      } catch { /* the screen doesn't depend on its record */ }
      if (!git || shallow) {
        try {
          const { skippedFacts } = await import("./history/job.js");
          writeFactFile(recordLocation(), projectId, "code-facts.json", skippedFacts(shallow ? "shallow clone" : "no git"));
        } catch { /* readers treat a missing file as nothing found */ }
      }
      killAt("facts", env);
    }
  } finally { writer?.close(); }

  if (git && existsSync(join(checkout.path, ".mex", "ROUTER.md"))) notes.push("This repo has MEX 0.8 project files; `mex hub` opens them.");
  if (hooks.note) notes.push(hooks.note);
  notes.push(...hooks.notices);
  const name = basename(displayPath(checkout.path));
  for (const line of renderHeader({ name, ms: elapsed(), costUsd: 0, hidden }, mode)) write(line);
  if (mode.color) write("");
  for (const line of renderFindings(findings, mode)) write(line);

  let exitNow = false, exitCode = 0;
  if (waiting && finishJobs.length) {
    const { finishWork } = await import("./finish.js");
    // Ctrl+C while waiting stops the wait, not the work: the background process takes it over.
    let onInterrupt: (() => void) | undefined;
    const interrupt = new Promise<void>(resolve => { onInterrupt = resolve; });
    const handler = () => onInterrupt?.();
    process.once("SIGINT", handler);
    const finishWriter = openRecord();
    try {
      const finished = await finishWork({
        writer: finishWriter, projectId, jobs: finishJobs, mode, live: mode.color,
        capMs: options.waitCapMs ?? testWaitCap(env) ?? (caller === "person" ? WAIT_CAP_MS.person : WAIT_CAP_MS.other),
        interrupt, onFirstProgress: () => killAt("waiting", env),
      });
      for (const line of renderFindings(finished.findings, mode)) write(line);
      exitNow = finished.handedOff;
      if (finished.interrupted) exitCode = 130;
    } finally {
      process.removeListener("SIGINT", handler);
      finishWriter.close();
    }
  }
  for (const line of renderNotes(notes, mode)) write(line);
  if (waiting && finishJobs.length && !exitNow) for (const line of renderDone(elapsed(), mode)) write(line);
  const ended = exitNow ? { exitNow: true as const } : {};

  // The offer slot: empty in beta.1; learning-03 registers its question.
  const { dueOffer } = await import("./offers.js");
  const context = { projectId, root: checkout.path };
  const offer = dueOffer(context);
  if (!offer || exitCode) return { exitCode, place: place.kind, projectId, turnedOn: true, ...ended };
  const summary = { question: offer.question, estimate: offer.estimate, command: offer.command };
  if (!interactive) {
    write(`${offer.question} (${offer.estimate}). Nothing paid was started; to start it, run: ${offer.command}`);
    return { exitCode: 0, place: place.kind, projectId, turnedOn: true, offer: summary, ...ended };
  }
  if (await ask([`${offer.question} ${offer.estimate}. [y/n]`])) write(await offer.start(context));
  else write(`Not started. \`${offer.command}\` starts it later.`);
  return { exitCode: 0, place: place.kind, projectId, turnedOn: true, offer: summary, ...ended };
}
