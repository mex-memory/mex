import {
  MachineSetupSchema,
  type MachineProject,
  type MachineRepoSetup,
  type MachineSetup,
  type MachineSetupQuote,
  type MachineSetupStep,
} from "@mex/hub-contracts/machine";
import { setupJobTokens, type SetupStepAction } from "./setup-model";
import type { HubJob } from "./types";

export const localSetupProject = {
  id: "field-notes",
  name: "Field notes",
  kind: "git",
  shared: false,
  provisional: null,
  checkouts: [{ path: "/work/field-notes", state: "on", offUntil: null, exists: true }],
} satisfies MachineProject;

const noCost = { uncachedInput: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
type StepSeed = Omit<MachineSetupStep, "scope" | "cost" | "startedAt" | "finishedAt"> & { cost?: MachineSetupStep["cost"] };

export function fixtureSetup(now: number): MachineSetup {
  function run(
    repoId: string,
    age: number,
    steps: StepSeed[],
    summary: MachineRepoSetup["summary"],
    options: Partial<Pick<MachineRepoSetup, "learnDeeper" | "questions" | "unavailableSteps">> = {},
  ): MachineRepoSetup {
    const checkout = "/work/" + repoId;
    const started = now - age * 60_000;
    return {
      repoId, checkout, summary, questions: [], ...options,
      steps: steps.map((step, index) => ({
        ...step, scope: checkout, cost: step.cost ?? noCost,
        startedAt: new Date(started + index * 1_000).toISOString(),
        finishedAt: step.state === "running" ? null : new Date(started + (index + 1) * 1_000).toISOString(),
      })),
    };
  }

  return MachineSetupSchema.parse({
    repos: [
      run("storefront", 3, [
        { kind: "file-index", jobId: "storefront-index", label: "File index", state: "done", summary: "Indexed 4,280 files." },
        {
          kind: "code-facts", jobId: "storefront-facts", label: "Code facts from git history", state: "done",
          summary: "312 commits read, with 5 file pairs that change together, 2 layer rules and 14 generated files.",
        },
        {
          kind: "graph-build", jobId: "storefront-map", label: "Code map", state: "running",
          progress: { done: 1_504, total: 4_280, unit: "files", message: "1,504 of 4,280 files" },
        },
      ], {
        elapsedMs: 8_400, commandsSaved: true, findings: [
          { label: "Commands", text: "Test and build commands for 3 packages." },
          { label: "Rule files", text: "Read AGENTS.md, CLAUDE.md and apps/web/AGENTS.md. One rule disagrees." },
          { label: "Agent memory", text: "4 notes from Claude Code, offered to your agents as hints." },
        ],
      }, {
        learnDeeper: {
          state: "offered",
          quote: {
            agent: "Claude Code", tokens: 48_000, seconds: 240, ceilingTokens: 72_000,
            recentUse: "About 1.8% of your recorded use in the past week.", weekly: true, privateRepo: false,
          },
        },
        questions: [
          {
            id: "storefront-checkout-rules", type: "rule-conflict", suggested: "1",
            question: '`AGENTS.md` says `apps/web`, `CLAUDE.md` says `packages/ui` (under "Checkout UI"). Which is right?',
            details: [],
            choices: [{ key: "1", label: "AGENTS.md is right" }, { key: "2", label: "CLAUDE.md is right" }],
          },
          {
            id: "storefront-test-command", type: "test-command",
            question: "This repo has two test commands: `npm test` (package.json) and `make test` (Makefile). Which is the real one?",
            details: [],
            choices: [{ key: "1", label: "`npm test`" }, { key: "2", label: "`make test`" }, { key: "3", label: "both" }],
          },
        ],
      }),
      run("design-kit", 360, [
        { kind: "file-index", jobId: "design-kit-index", label: "File index", state: "done", summary: "Indexed 424 files." },
        {
          kind: "code-facts", jobId: "design-kit-facts", label: "Code facts from git history", state: "done",
          summary: "94 commits read, with 3 file pairs that change together and 1 layer rule.",
        },
        {
          kind: "graph-build", jobId: "design-kit-map", label: "Code map", state: "done with gaps",
          summary: "Code map built: 420 files, 1,286 definitions. Four files couldn’t be read.",
        },
        {
          kind: "learn-deeper", jobId: "design-kit-learn", label: "Learn deeper", state: "done",
          estimate: { tokens: 36_000, seconds: 180 },
          cost: { uncachedInput: 8_400, cacheWrite: 2_400, cacheRead: 16_800, output: 3_600 },
          summary: "Learned 7 rules from past reviews and docs.",
        },
      ], {
        elapsedMs: 5_200, commandsSaved: true, findings: [
          { label: "Commands", text: "Test and build commands for this repo." },
          { label: "Rule files", text: "Read AGENTS.md and CLAUDE.md. They agree." },
        ],
      }),
      run("docs-site", 690, [
        { kind: "file-index", jobId: "docs-site-index", label: "File index", state: "done", summary: "Indexed 96 files." },
        {
          kind: "graph-build", jobId: "docs-site-map", label: "Code map", state: "failed",
          error: "Couldn’t read the repo folder.",
        },
      ], {
        elapsedMs: 850, findings: [{ label: "Commands", text: "No test or build commands found in config." }],
      }, {
        unavailableSteps: [{ kind: "code-facts", reason: "Git history skipped. This is a shallow clone." }],
        learnDeeper: { state: "unavailable", reason: "The repo folder is missing. Restore it and run `mex` in the repo to try again." },
      }),
      run("field-notes", 34, [
        { kind: "file-index", jobId: "field-notes-index", label: "File index", state: "done", summary: "Indexed 58 files." },
        {
          kind: "code-facts", jobId: "field-notes-facts", label: "Code facts from git history", state: "done",
          summary: "18 commits read. No files change together often enough yet.",
        },
        {
          kind: "graph-build", jobId: "field-notes-map", label: "Code map", state: "done",
          summary: "Code map built: 58 files, 144 definitions.",
        },
      ], {
        elapsedMs: 760, findings: [{ label: "Rule files", text: "Read AGENTS.md." }],
      }, { learnDeeper: { state: "no-review-remote" } }),
    ],
  });
}

function jobState(step: MachineSetupStep): HubJob["state"] {
  switch (step.state) {
    case "running": return { phase: "running", pausing: step.pending === "pause", stopping: step.pending === "cancel" };
    case "done with gaps": return { phase: "doneWithGaps" };
    case "cancelled": return { phase: "stopped" };
    case "failed": return { phase: "failed", cause: step.error ?? "The job could not finish", identicalFailures: 3 };
    case "waiting": return { phase: "waiting", reason: step.error ?? "ready when work can continue" };
    default: return { phase: step.state };
  }
}

export function fixtureSetupJobs({ repos }: MachineSetup): HubJob[] {
  return repos.flatMap(({ repoId, steps }) => steps.map((step): HubJob => {
    const { progress, estimate } = step;
    return {
      id: step.jobId, repoId, label: step.label, kind: step.kind, state: jobState(step),
      activity: progress?.message ?? step.summary ?? step.error,
      progress: progress?.done !== undefined && progress.total ? { completed: progress.done, total: progress.total } : undefined,
      cost: estimate?.tokens === undefined ? null : { estimatedTokens: estimate.tokens, usedTokens: setupJobTokens(step) },
      started: step.startedAt,
    };
  })).sort((a, b) => b.started!.localeCompare(a.started!));
}

export function updateFixtureStep(setup: MachineSetup, jobId: string, update: (step: MachineSetupStep) => MachineSetupStep): MachineSetup {
  return { repos: setup.repos.map((repo) => repo.steps.some((step) => step.jobId === jobId)
    ? { ...repo, steps: repo.steps.map((step) => step.jobId === jobId ? update(step) : step) } : repo) };
}

export function requestFixtureStep(step: MachineSetupStep, action: SetupStepAction, at: string): MachineSetupStep {
  const { state } = step;
  if (step.pending || state === "done" || state === "done with gaps" || state === "cancelled") return step;
  if (action === "resume") {
    if (state !== "paused" && state !== "waiting" && state !== "failed") return step;
    return { ...step, state: "queued", error: undefined, finishedAt: null };
  }
  if (state === "running") return { ...step, pending: action };
  if (action === "pause") return state === "queued" || state === "waiting" ? { ...step, state: "paused" } : step;
  return { ...step, state: "cancelled", error: undefined, progress: undefined, finishedAt: at };
}

export function settleFixtureStep(step: MachineSetupStep, action: SetupStepAction, at: string): MachineSetupStep {
  if (action === "resume" && step.state === "queued" && step.progress) return { ...step, state: "running" };
  if (step.pending !== action) return step;
  if (action === "pause") return { ...step, state: "paused", pending: undefined };
  return { ...step, state: "cancelled", pending: undefined, progress: undefined, finishedAt: at };
}

export function updateFixtureRepo(setup: MachineSetup, repoId: string, update: (repo: MachineRepoSetup) => MachineRepoSetup): MachineSetup {
  return { repos: setup.repos.map((repo) => repo.repoId === repoId ? update(repo) : repo) };
}

export function startFixtureLearning(repo: MachineRepoSetup, quote: MachineSetupQuote, at: string): MachineRepoSetup {
  if (repo.learnDeeper?.state !== "offered" || repo.learnDeeper.quote !== quote) return repo;
  return {
    ...repo, learnDeeper: undefined,
    steps: [...repo.steps, {
      kind: "learn-deeper", jobId: repo.repoId + "-learn", label: "Learn deeper", state: "queued",
      scope: repo.checkout, estimate: { tokens: quote.tokens, seconds: quote.seconds },
      cost: noCost, startedAt: at, finishedAt: null,
    }],
  };
}

export function skipFixtureLearning(repo: MachineRepoSetup): MachineRepoSetup {
  return repo.learnDeeper?.state === "offered" ? { ...repo, learnDeeper: { state: "skipped" } } : repo;
}

export function replyFixtureQuestions(repo: MachineRepoSetup, reply?: { questionId: string; choice: string }): MachineRepoSetup {
  return {
    ...repo, questions: repo.questions.map((question) => {
      if (question.outcome || reply && reply.questionId !== question.id) return question;
      if (!reply || reply.choice === "skip") return { ...question, outcome: { status: "skipped" } };
      if (!question.choices.some(({ key }) => key === reply.choice)) return question;
      return { ...question, outcome: { status: "saved", line: 'Saved: your agents get it as "you said"' } };
    }),
  };
}
