import { execFileSync, spawn, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { runSetupNext } from "../src/setup/next.js";
import { readNextGraph } from "../src/setup/next-graph.js";
/**
 * End-to-end setup coverage (#292): the real headless setup engine and the
 * real population launcher, with the scripted agent from
 * `support/scripted-agent.ts` behind `claude` and `codex` shims. Covers each
 * supported agent, an interruption at every phase and inside population and
 * the finish step, a fresh clone of a committed setup, and two setups at
 * once. Runs on every platform CI uses, Windows included (storage-portability).
 *
 * The built CLI is required: `npm ci` builds it through `prepare`.
 */
import { existsSync, readFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  inspectSetupStatus,
  runHeadlessSetup,
  type HeadlessSetupResult,
  type SetupProgressStep,
} from "../src/setup/headless.js";
import { SetupError } from "../src/setup/errors.js";
import { SETUP_LOCK_FILE } from "../src/setup/setup-lock.js";
import { loadPlanState } from "../src/setup/subsystem-state.js";
import {
  KNOWLEDGE_FILES,
  fixtureRepository,
  git,
  removeScratch,
  scaffoldEntities,
  scaffoldFiles,
  scratch,
} from "./support/setup-e2e.js";
import {
  SCRIPTED_FACT_TITLE,
  SCRIPTED_PATTERN,
  installScriptedAgent,
  type ScriptedAgentStop,
} from "./support/scripted-agent.js";

const CLI = resolve("dist/cli.js");
const RUN_TIMEOUT = 180_000;

type Provider = "claude" | "codex";

let scriptedRoot: string;
let originalPath: string | undefined;
let originalHome: string | undefined;
let originalAgents: string | undefined;
let originalSubsystems: string | undefined;

beforeAll(() => {
  if (!existsSync(CLI))
    throw new Error(
      "dist/cli.js is missing: run `npm run build` (npm ci runs it) before this suite.",
    );
  const root = scratch("mex-setup-e2e-agent-");
  scriptedRoot = root;
  const shimBin = installScriptedAgent(root, CLI);
  // The shims must win over any agent installed on the machine. Windows keeps
  // one case-insensitive PATH; setting `PATH` replaces it.
  originalAgents = process.env.MEX_SETUP_BACKGROUND_AGENTS;
  originalSubsystems = process.env.MEX_SETUP_PER_SUBSYSTEM;
  process.env.MEX_SETUP_BACKGROUND_AGENTS = "1";
  process.env.MEX_SETUP_PER_SUBSYSTEM = "0";
  originalPath = process.env.PATH;
  process.env.PATH = `${shimBin}${delimiter}${originalPath ?? ""}`;
  originalHome = process.env.MEX_HOME;
  process.env.MEX_HOME = join(root, "home");
});

afterAll(() => {
  if (originalAgents === undefined)
    delete process.env.MEX_SETUP_BACKGROUND_AGENTS;
  else process.env.MEX_SETUP_BACKGROUND_AGENTS = originalAgents;
  if (originalSubsystems === undefined)
    delete process.env.MEX_SETUP_PER_SUBSYSTEM;
  else process.env.MEX_SETUP_PER_SUBSYSTEM = originalSubsystems;
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  if (originalHome === undefined) delete process.env.MEX_HOME;
  else process.env.MEX_HOME = originalHome;
});

afterEach(() => {
  delete process.env.MEX_E2E_AGENT_STOP;
});

afterAll(removeScratch);

describe("setup end to end with a launched population agent (#292)", () => {
  it.each(["claude", "codex"] as const)(
    "%s populates through the real launcher and setup finishes",
    async (provider) => {
      const project = fixtureRepository();
      const result = await setup(project, provider);

      expect(result).toMatchObject({
        stage: "ready",
        ready: true,
        populationTool: provider,
      });
      expect(agentStarts(project)).toBe(1);
      assertFinishedScaffold(project);
    },
    RUN_TIMEOUT,
  );

  // Every phase setup reports, plus a kill inside population and inside the
  // finish step. Each interruption must leave a checkout the next plain run
  // finishes, with nothing duplicated and nothing lost.
  const PHASES: SetupProgressStep[] = [
    "detect",
    "scaffold",
    "tools",
    "skills",
    "identity",
    "scan",
    "graph",
    "population",
    "finalize",
  ];
  it.each(PHASES)(
    "an interruption at %s resumes to a finished setup",
    async (step) => {
      const project = fixtureRepository();
      const abort = new AbortController();
      await expect(
        setup(project, "claude", {
          signal: abort.signal,
          onProgress: (update) => {
            if (update.step === step) abort.abort();
          },
        }),
      ).rejects.toThrow(/cancel/iu);
      expect(inspectSetupStatus(project).ready).toBe(false);

      const resumed = await setup(project, "claude");
      expect(resumed).toMatchObject({ stage: "ready", ready: true });
      assertFinishedScaffold(project);
    },
    RUN_TIMEOUT,
  );

  it.each(["placeholders", "pattern"] as const)(
    "a population agent killed after its %s step resumes with only what is missing",
    async (stop: ScriptedAgentStop) => {
      const project = fixtureRepository();
      const abort = new AbortController();
      process.env.MEX_E2E_AGENT_STOP = stop;
      const started = setup(project, "claude", { signal: abort.signal });
      await waitFor(() => agentLog(project).includes(`stopped:${stop}`));
      abort.abort();
      await expect(started).rejects.toThrow(/cancel/iu);
      delete process.env.MEX_E2E_AGENT_STOP;
      expect(inspectSetupStatus(project).ready).toBe(false);

      const resumed = await setup(project, "claude");
      expect(resumed).toMatchObject({ stage: "ready", ready: true });
      // Authored work is retained and the missing fact is written exactly once.
      assertFinishedScaffold(project);
    },
    RUN_TIMEOUT,
  );

  it(
    "an interruption inside the finish step resumes without repopulating",
    async () => {
      const project = fixtureRepository();
      const abort = new AbortController();
      await expect(
        setup(project, "claude", {
          signal: abort.signal,
          onMessage: (message) => {
            if (message === "Linking Wiki sections...") abort.abort();
          },
        }),
      ).rejects.toThrow(/cancel/iu);
      expect(inspectSetupStatus(project).populated).toBe(true);

      const resumed = await setup(project, "claude");
      expect(resumed).toMatchObject({ stage: "ready", ready: true });
      expect(agentStarts(project)).toBe(1);
      assertFinishedScaffold(project);
    },
    RUN_TIMEOUT,
  );

  // On Windows the clone checks managed skills out with CRLF (#308).
  it(
    "a fresh clone of a set-up, committed repository finishes without population",
    async () => {
      const project = fixtureRepository();
      await setup(project, "claude");
      git(project, "add", "-A");
      git(project, "commit", "--quiet", "-m", "Accept MEX setup");
      const idsBefore = entityIds(project);

      const clone = join(scratch("mex-setup-e2e-clone-"), "clone");
      git(project, "clone", "--quiet", project, clone);
      const before = inspectSetupStatus(clone);
      expect(before).toMatchObject({
        hasScaffold: true,
        populated: true,
        ready: false,
      });
      expect(loadPlanState(clone).state).toBeNull();

      const result = await setup(clone, "claude");
      expect(result).toMatchObject({
        stage: "ready",
        ready: true,
        populationTool: null,
      });
      expect(agentStarts(clone)).toBe(0);
      // The committed Wiki is the clone's Wiki: no id is minted again.
      expect(entityIds(clone)).toEqual(idsBefore);
      assertFinishedScaffold(clone);
    },
    RUN_TIMEOUT,
  );

  // One setup per checkout (#313): the second flow refuses with the exact
  // message while the first holds the lock, and the first still finishes.
  it(
    "a second setup in a checkout that is already being set up refuses and the first finishes",
    async () => {
      const project = fixtureRepository();
      const lock = join(project, ".mex", SETUP_LOCK_FILE);
      const first = setup(project, "claude");
      // Wait for the state the refusal depends on, not for a guessed delay.
      await waitFor(() => existsSync(lock));
      const refusal = await setup(project, "claude").then(
        () => null,
        (error: unknown) => error,
      );
      expect(refusal).toBeInstanceOf(SetupError);
      expect((refusal as Error).message).toMatch(
        /^Another MEX setup is already running in this checkout \(process (\d+), started \S+\)\. Wait for it to finish or stop it, then rerun setup\.$/u,
      );
      expect((refusal as Error).message).toContain(`process ${process.pid},`);
      // The refused flow neither took over nor released the first one's lock.
      expect(existsSync(lock)).toBe(true);

      const finished = await first;
      expect(finished).toMatchObject({ stage: "ready", ready: true });
      expect(agentStarts(project)).toBe(1);
      expect(existsSync(lock)).toBe(false);
      assertFinishedScaffold(project);
    },
    RUN_TIMEOUT,
  );
});

describe("setup recovery across current entry points", () => {
  it(
    "pauses at a usage limit and resumes the stored single-session plan",
    async () => {
      const project = fixtureRepository();
      process.env.MEX_E2E_AGENT_STOP = "usage-limit";
      const paused = await setup(project, "claude");
      expect(paused).toMatchObject({ ready: false, stage: "needs_population" });
      expect(paused.message).toMatch(/limit/iu);
      expect(loadPlanState(project).state?.shared.reason).toBe("usage_limit");
      delete process.env.MEX_E2E_AGENT_STOP;
      expect(await setup(project, "claude")).toMatchObject({ ready: true });
      assertFinishedScaffold(project);
    },
    RUN_TIMEOUT,
  );

  it(
    "reruns successfully after the built setup process is killed",
    async () => {
      const project = fixtureRepository();
      const child = spawn(
        process.execPath,
        [CLI, "setup", "--yes", "--tool", "none"],
        {
          cwd: project,
          env: { ...process.env, MEX_SETUP_BACKGROUND_AGENTS: "0" },
          stdio: "ignore",
          windowsHide: true,
          detached: process.platform !== "win32",
        },
      );
      const exited = new Promise<void>((done) =>
        child.once("exit", () => done()),
      );
      try {
        await waitFor(() =>
          existsSync(join(project, ".mex/context/architecture.md")),
        );
        expect(child.exitCode).toBeNull();
      } finally {
        if (child.pid && child.exitCode === null) {
          if (process.platform === "win32")
            spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
              windowsHide: true,
            });
          else process.kill(-child.pid, "SIGKILL");
        }
        await exited;
      }
      expect(await setup(project, "claude")).toMatchObject({ ready: true });
      assertFinishedScaffold(project);
    },
    RUN_TIMEOUT,
  );

  it(
    "one-paste receipts, retry and a new-chat start complete with the same fake agent",
    async () => {
      const project = fixtureRepository();
      const first = await runSetupNext({ projectRoot: project });
      expect(first.status).toBe("task");
      const retried = await runSetupNext({
        projectRoot: project,
        retry: "single",
      });
      expect(retried.status).toBe("task");
      const resumed = await runSetupNext({ projectRoot: project, start: true });
      const file = resumed.taskFile ?? retried.taskFile!;
      await waitFor(() => readNextGraph(project)?.status === "ready");
      execFileSync(
        process.execPath,
        [
          join(scriptedRoot, "agent.mjs"),
          "claude",
          "-p",
          `Read the full MEX population prompt from \`${join(project, file)}\``,
          "stream-json",
        ],
        { cwd: project, encoding: "utf8", windowsHide: true },
      );
      const complete = await runSetupNext({ projectRoot: project });
      expect(complete.status).toBe("complete");
      expect(loadPlanState(project).state?.queue?.finalized).toBe(true);
      assertFinishedScaffold(project);
    },
    RUN_TIMEOUT,
  );
});

function setup(
  project: string,
  provider: Provider,
  extra: Partial<Parameters<typeof runHeadlessSetup>[0]> = {},
): Promise<HeadlessSetupResult> {
  return runHeadlessSetup({
    projectRoot: project,
    mode: "code-repo",
    tools: [provider],
    ...extra,
  });
}

/** What every finished setup must hold, however it got there. */
function assertFinishedScaffold(project: string): void {
  const mexDir = join(project, ".mex");
  const entities = scaffoldEntities(project);
  const ids = entities.map((entity) => entity.id);
  expect(new Set(ids).size, "an entity id appears twice").toBe(ids.length);
  for (const file of KNOWLEDGE_FILES) {
    expect(
      entities.filter(
        (entity) => entity.file === file && entity.kind === "frontmatter",
      ),
      file,
    ).toHaveLength(1);
  }
  const facts = entities.filter(
    (entity) => entity.title === SCRIPTED_FACT_TITLE,
  );
  expect(facts, "the code-linked fact was lost or created twice").toHaveLength(
    1,
  );
  expect(facts[0]!.groundsTo).toHaveLength(1);
  const architecture = entities.find(
    (entity) =>
      entity.file === "context/architecture.md" &&
      entity.kind === "frontmatter",
  )!;
  expect(facts[0]!.relations).toEqual([
    expect.objectContaining({ type: "refines", target: architecture.id }),
  ]);
  expect(scaffoldFiles(project)).toContain(SCRIPTED_PATTERN);
  expect(existsSync(join(mexDir, "local/setup-state.json"))).toBe(false);
  expect(existsSync(join(mexDir, "wiki.db"))).toBe(true);
  expect(inspectSetupStatus(project)).toMatchObject({
    ready: true,
    graphReady: true,
    wikiReady: true,
  });
}

function entityIds(project: string): string[] {
  return scaffoldEntities(project)
    .map((entity) => entity.id)
    .sort();
}

function agentLog(project: string): string {
  const path = join(project, ".mex", "local", "e2e-agent.log");
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function agentStarts(project: string): number {
  return agentLog(project)
    .split("\n")
    .filter((line) => line.startsWith("start:")).length;
}

async function waitFor(
  condition: () => boolean,
  timeoutMs = 90_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline)
      throw new Error("Timed out waiting for the population agent.");
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
}
