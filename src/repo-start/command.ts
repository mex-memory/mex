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
import { classifyPlace, type Place } from "./place.js";
import { renderScreen, screenMode, type Finding, type ScreenModel } from "./screen.js";

/** Test-only: kill the process at a step boundary to prove each one leaves a clean state. */
export const KILL_AT_VARIABLE = "MEX_REPO_START_KILL_AT";
export const KILL_POINTS = ["installed", "registered", "hidden", "queued", "free-step", "facts"] as const;
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
}
export interface RepoStartResult { exitCode: number; place: Place["kind"]; projectId?: string; }

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

export async function runRepoStart(options: RepoStartOptions = {}): Promise<RepoStartResult> {
  const env = options.env ?? process.env;
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const elapsed = options.elapsed ?? (() => performance.now());
  const caller = options.caller ?? detectCaller({ env });
  const mode = screenMode({ env });
  const install = options.install ?? (env.MEX_INSTALL_AUTO !== "0" && env.MEX_BACKGROUND !== "1");

  const hooks: HookSummary = install ? await installHooks() : { notices: [] };
  killAt("installed", env);

  const place = classifyPlace(options.cwd ?? process.cwd());
  if (place.kind === "refused") {
    write(place.reason === "drive-root"
      ? `MEX doesn't turn on at a drive root (${place.root}). Run \`mex\` inside a project folder.`
      : `MEX doesn't turn on in your home folder or above it (${place.root}); its hooks would cover every session below. Run \`mex\` inside a project folder.`);
    return { exitCode: 1, place: place.kind };
  }
  if (place.kind === "folder") {
    write(`${place.root} isn't a git repo, so MEX didn't turn on here. Run \`mex\` inside a git repo.`);
    return { exitCode: 0, place: place.kind };
  }

  const { openRecord } = await import("../record/index.js");
  const { turnOnRepository } = await import("./turn-on.js");
  const findings: Finding[] = [];
  const notes: string[] = [];
  let writer: RecordWriter | undefined = openRecord();
  let projectId: string, checkout: CheckoutRow, hidden = false;
  try {
    const turnedOn = turnOnRepository(writer, place.root);
    projectId = turnedOn.projectId; checkout = turnedOn.checkout;
    killAt("registered", env);
    if (!checkoutOn(checkout)) {
      write(`MEX is off for this repo${checkout.state === "off until" ? ` until ${checkout.off_until}` : ""}. Run \`mex on\` to turn it back on.`);
      return { exitCode: 0, place: place.kind, projectId };
    }

    const { ensureExcludeBlock, REPO_START_BLOCK, REPO_START_LINES } = await import("./exclude.js");
    try {
      ensureExcludeBlock(writer, place.excludeFile, REPO_START_BLOCK, REPO_START_LINES);
      hidden = true;
    } catch (error) {
      findings.push({ state: "attention", text: `Couldn't hide .mex/ in git's exclude file: ${message(error)}` });
    }
    killAt("hidden", env);

    const { automaticWorkEnabled } = await import("../controls/index.js");
    if (!automaticWorkEnabled(writer, projectId)) {
      findings.push({ state: "attention", text: "MEX is off everywhere, so nothing was read or queued. `mex on --all` turns it back on." });
    } else {
      const { queueIndexBuild } = await import("../file-index/command.js");
      queueIndexBuild(writer, projectId, checkout.path);
      // Queued after the index, so layer rules can read its imports.
      if (!place.shallow) {
        const { queueJob } = await import("../record/background.js");
        queueJob(writer, { kind: "code-facts", projectId, params: { checkout: checkout.path } });
      }
      killAt("queued", env);
      writer.close(); writer = undefined;

      // The free step: local reads only. Later steps add rule files and history.
      const recipes = await readRecipes(checkout.path, projectId, env);
      if (recipes) {
        const { recipeSummary } = await import("./recipes/index.js");
        const summary = recipeSummary(recipes);
        findings.push({ state: "ok", text: summary.line });
        for (const note of summary.notes.slice(0, 3)) findings.push({ state: "attention", text: note });
      }
      const memory = await readAgentMemory(checkout.path);
      if (memory && memory.count > 0) {
        findings.push({ state: "ok", text: `${memory.count} ${memory.count === 1 ? "note" : "notes"} from your ${list(memory.agents) || "agents'"} memory` });
      }
      killAt("free-step", env);
      if (place.shallow) {
        findings.push({ state: "attention", text: "Git history: skipped, this is a shallow clone (`git fetch --unshallow` to add it)" });
        findings.push({ state: "background", text: "The file index: in the background (`mex jobs`)" });
      } else findings.push({ state: "background", text: "Git history and the file index: in the background (`mex jobs`)" });

      const { recordLocation } = await import("../record/location.js");
      const { writeFactFile } = await import("./facts.js");
      try {
        writeFactFile(recordLocation(), projectId, "setup.json", {
          version: 1, last_run: new Date().toISOString(), ms: Math.round(elapsed()), caller,
          found: {
            packages: new Set(recipes?.recipes.map(recipe => recipe.package) ?? []).size, recipes: recipes?.recipes.length ?? 0,
            rule_files: 0, rule_conflicts: 0, hints: memory?.count ?? 0,
          },
          exclude: { file: place.excludeFile, block: hidden },
        });
      } catch { /* the screen doesn't depend on its record */ }
      if (place.shallow) {
        try {
          const { skippedFacts } = await import("./history/job.js");
          writeFactFile(recordLocation(), projectId, "code-facts.json", skippedFacts("shallow clone"));
        } catch { /* readers treat a missing file as nothing found */ }
      }
      killAt("facts", env);
    }
  } finally { writer?.close(); }

  if (existsSync(join(checkout.path, ".mex", "ROUTER.md"))) notes.push("This repo has MEX 0.8 project files; `mex hub` opens them.");
  if (hooks.note) notes.push(hooks.note);
  notes.push(...hooks.notices);
  const model: ScreenModel = { name: basename(checkout.path), ms: elapsed(), costUsd: 0, hidden, findings, notes };
  for (const line of renderScreen(model, mode)) write(line);
  return { exitCode: 0, place: place.kind, projectId };
}
