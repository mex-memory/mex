/**
 * Setup job rows (contracts/setup-jobs.md): the real code map and learn-deeper kinds give
 * readers one row shape, the code map writes the progress and summary lines the screen reads,
 * the views act only through the jobs API, and the new miners and caller signals behave as
 * setup expects. A change to the code map job's label, progress or summary fails here.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = mkdtempSync(join(tmpdir(), "mex-setup-steps-"));
vi.stubEnv("MEX_HOME", join(base, "home"));

const { openRecord } = await import("../../record/index.js");
const { enqueueJob, runOneBatch, jobKind } = await import("../../record/jobs.js");
await import("../../record/job-kinds.js");
const { graphBuildProgress } = await import("../../graph/jobs.js");
const { labelled } = await import("../rich.js");
const { actOnStep, parseProgress, readSetupSteps, SETUP_STEP_KINDS } = await import("../steps.js");
const { handEdited, layerExceptions } = await import("../history/mine.js");
const { detectCaller, isAgentCaller, AGENT_VARIABLES } = await import("../caller.js");

let writer: ReturnType<typeof openRecord>, projectId: string, checkout: string;
const reader = () => ({ all: (sql: string, ...args: unknown[]) => writer.db.prepare(sql).all(...(args as never[])) as never });

beforeAll(() => {
  checkout = join(base, "repo"); mkdirSync(join(checkout, "src"), { recursive: true });
  writeFileSync(join(checkout, "package.json"), JSON.stringify({ name: "steps-fixture", version: "1.0.0" }));
  writeFileSync(join(checkout, "src", "a.ts"), "export function add(a: number, b: number) { return a + b; }\n");
  writeFileSync(join(checkout, "src", "b.ts"), "import { add } from \"./a\";\nexport const three = () => add(1, 2);\n");
  writer = openRecord();
  const now = new Date().toISOString();
  projectId = "g-0123456789abcdef01234567";
  writer.db.prepare("INSERT INTO projects(id,root_path,kind,shared,created_at) VALUES (?,?,?,?,?)").run(projectId, checkout, "git", 0, now);
});
afterAll(() => { writer?.close(); vi.unstubAllEnvs(); rmSync(base, { recursive: true, force: true, maxRetries: 5 }); });

describe("setup job rows", () => {
  it("has every setup kind registered under the labels the screen and the Hub show, and reserves session learning", () => {
    expect(SETUP_STEP_KINDS).toEqual(["file-index", "code-facts", "graph-build", "learn-deeper"]);
    for (const kind of SETUP_STEP_KINDS) expect(jobKind(kind), kind).toBeDefined();
    expect(jobKind("graph-build")?.label).toBe("Code map");
    expect(() => enqueueJob(writer, { kind: "session-learn", projectId })).toThrow();
  });

  it("reads the code map's progress lines as counts", () => {
    expect(parseProgress(graphBuildProgress({ phase: "parse", completed: 1200, total: 4500 })))
      .toEqual({ done: 1200, total: 4500, unit: "files", message: "1,200 of 4,500 files" });
    for (const phase of ["discover", "stage", "parse", "resolve", "validate", "write"]) {
      const line = graphBuildProgress({ phase });
      expect(parseProgress(line), phase).toEqual({ message: line });
    }
  });

  it("gives the code map and learn deeper one row shape, and the code map a summary the screen labels", async () => {
    const graph = enqueueJob(writer, { kind: "graph-build", projectId, params: { checkout } }).job;
    // Queued only: learn deeper never runs without a model here.
    const learn = enqueueJob(writer, { kind: "learn-deeper", projectId, params: { checkout }, tokensEstimate: 48_000 }).job;
    const queued = readSetupSteps(reader(), projectId);
    expect(queued.map(step => [step.kind, step.state, step.label])).toEqual([["graph-build", "queued", "Code map"], ["learn-deeper", "queued", "Learn deeper"]]);
    const fields = (step: object) => Object.keys(step).filter(key => !["estimate", "progress", "summary", "error"].includes(key)).sort();
    expect(fields(queued[0]!)).toEqual(fields(queued[1]!));
    expect(queued[1]!.estimate).toEqual({ tokens: 48_000, seconds: 240 });
    expect(queued[0]!.scope).toBe(checkout);
    expect(queued[0]!.cost).toEqual({ uncachedInput: 0, cacheWrite: 0, cacheRead: 0, output: 0 });

    for (let batch = 0; batch < 5 && !["done", "done with gaps", "failed"].includes(readSetupSteps(reader(), projectId)[0]!.state); batch++) {
      await runOneBatch(writer, "test", { only: new Set([graph.id]) });
    }
    const done = readSetupSteps(reader(), projectId).find(step => step.kind === "graph-build")!;
    expect(done.state).toBe("done");
    expect(done.summary).toMatch(/^Code map built: 2 files, \d+ definitions?$/u);
    // The rich screen gives it the "Code map" label, not a raw line.
    expect(labelled(done.summary!)).toMatchObject({ label: "Code map" });
    expect(done.progress).toBeUndefined();
    expect(done.finishedAt).toBeTruthy();

    // The views act through the jobs API only.
    expect(actOnStep(writer, learn.id, "pause").state).toBe("paused");
    expect(actOnStep(writer, learn.id, "resume").state).toBe("queued");
    expect(actOnStep(writer, learn.id, "cancel").state).toBe("cancelled");
  });

  it("reads progress the way every setup job writes it", () => {
    expect(parseProgress("4,210 of 12,306 files")).toEqual({ done: 4210, total: 12306, unit: "files", message: "4,210 of 12,306 files" });
    expect(parseProgress("connecting calls and imports")).toEqual({ message: "connecting calls and imports" });
    expect(parseProgress(null)).toBeUndefined();
  });
});

describe("what code facts keeps for the questions", () => {
  const edges = (pairs: Array<[string, string, number]>) => {
    const map = new Map<string, Map<string, number>>();
    for (const [from, to, n] of pairs) { if (!map.has(from)) map.set(from, new Map()); map.get(from)!.set(to, n); }
    return map;
  };
  it("keeps a near-rule broken in one or two places, not a two-way dependency", () => {
    const files = new Map([["packages/db\0packages/ui", ["packages/db/x.ts"]]]);
    expect(layerExceptions(edges([["packages/ui", "packages/db", 14], ["packages/db", "packages/ui", 1]]), files))
      .toEqual([{ from: "packages/db", to: "packages/ui", imports: 14, back: 1, files: ["packages/db/x.ts"] }]);
    expect(layerExceptions(edges([["a", "b", 6], ["b", "a", 3]]))).toEqual([]);
    expect(layerExceptions(edges([["a", "b", 6]]))).toEqual([]);
    expect(layerExceptions(edges([["a", "b", 5], ["b", "a", 2]]))).toEqual([]);
  });
  it("counts commits that changed only a generated file", () => {
    const generated = new Map([["gen.ts", "marker"], ["hist.ts", "history"]]);
    const commits = [{ hash: "1", files: ["gen.ts"] }, { hash: "2", files: ["gen.ts"] }, { hash: "3", files: ["gen.ts", "schema.json"] }, { hash: "4", files: ["hist.ts"] }, { hash: "5", files: ["hist.ts"] }];
    expect(handEdited(commits, generated)).toEqual([{ path: "gen.ts", commits: 2 }]);
    expect(handEdited(commits.slice(0, 1), generated)).toEqual([]);
  });
});

describe("who ran mex", () => {
  it("knows every supported agent's shell, and a person only at a terminal", () => {
    for (const key of AGENT_VARIABLES) expect(isAgentCaller({ [key]: "1" }), key).toBe(true);
    expect(isAgentCaller({ AI_AGENT: "claude-code_2_agent" })).toBe(true);
    for (const value of ["0", "false", "no", "off", ""]) expect(isAgentCaller({ AI_AGENT: value })).toBe(false);
    expect(detectCaller({ env: { GEMINI_CLI: "1" }, stdinTTY: true, stdoutTTY: true })).toBe("agent");
    expect(detectCaller({ env: { CI: "true" }, stdinTTY: true, stdoutTTY: true })).toBe("script");
    expect(detectCaller({ env: {}, stdinTTY: true, stdoutTTY: false })).toBe("script");
    expect(detectCaller({ env: {}, stdinTTY: true, stdoutTTY: true })).toBe("person");
  });
});
