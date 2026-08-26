import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openGraphDatabase } from "../src/graph/db/database.js";
import { GraphStore } from "../src/graph/db/store.js";
import { createApiRouter, parseSetupBody, type ApiRouter } from "../src/ui/api.js";
import { JobRegistry, type Job } from "../src/ui/jobs.js";
import type { HeadlessSetupResult } from "../src/ui/setup-runner.js";

let root: string;
let jobs: JobRegistry;
let call: ApiRouter;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mex-ui-api-"));
  jobs = new JobRegistry();
  const router = createApiRouter({ root, jobs });
  call = (request) => router(request);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function get(path: string, query: Record<string, string> = {}) {
  return call({ method: "GET", path, query: new URLSearchParams(query) });
}

function post(path: string, body?: unknown) {
  return call({ method: "POST", path, query: new URLSearchParams(), body });
}

function writeScaffold(files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, ".mex", path);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, content);
  }
}

/** Pull a real node id out of a freshly built graph, so tests never invent one. */
function findNodeId(projectRoot: string, name: string): string {
  const db = openGraphDatabase(join(projectRoot, ".mex", "graph.db"), { readOnly: true });
  try {
    const node = new GraphStore(db).getAllNodes().find((entry) => entry.name === name);
    if (!node) throw new Error(`No graph node named ${name}`);
    return node.id;
  } finally {
    db.close();
  }
}

function waitForCompletion(id: string, timeoutMs = 60_000): Promise<Job> {
  return new Promise((resolve, reject) => {
    const current = jobs.get(id);
    if (current && current.status !== "running") {
      resolve(current);
      return;
    }
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Job ${id} did not finish within ${timeoutMs}ms`));
    }, timeoutMs);
    const unsubscribe = jobs.subscribe(id, (job) => {
      if (job.status === "running") return;
      clearTimeout(timer);
      unsubscribe();
      resolve(job);
    });
  });
}

describe("API — reads", () => {
  it("serves health with the running version", async () => {
    const response = await get("/api/health");
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: true, root });
    expect((response.body as { version: string }).version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("serves the snapshot for an empty project", async () => {
    const response = await get("/api/snapshot");
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: "empty" });
  });

  it("serves a setup plan", async () => {
    const response = await get("/api/setup/plan");
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ hasScaffold: false, state: "fresh" });
  });

  it("reports a missing graph as unavailable rather than failing", async () => {
    const response = await get("/api/graph");
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      available: false,
      unavailable: { reason: "missing" },
      totals: { nodes: 0, edges: 0, files: 0 },
    });
  });

  it("returns a structured 409 for drift when there is no scaffold", async () => {
    const response = await get("/api/drift");
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      error: { code: "SCAFFOLD_UNAVAILABLE" },
    });
  });

  it("runs a drift check against a real scaffold", async () => {
    writeScaffold({ "ROUTER.md": "# Router\n" });
    const response = await get("/api/drift");
    expect(response.status).toBe(200);
    const body = response.body as { report: { score: number }; warnings: string[] };
    expect(typeof body.report.score).toBe("number");
    expect(Array.isArray(body.warnings)).toBe(true);
  });

  it("returns activity with heartbeat, honouring the limit", async () => {
    writeScaffold({ "ROUTER.md": "# Router\n" });
    const events = Array.from({ length: 5 }, (_, i) =>
      JSON.stringify({
        timestamp: `2026-05-1${i}T00:00:00.000Z`,
        kind: "note",
        message: `note ${i}`,
        files: [],
        cwd: ".",
      }),
    ).join("\n");
    mkdirSync(join(root, ".mex", "events"), { recursive: true });
    writeFileSync(join(root, ".mex", "events", "decisions.jsonl"), events + "\n");

    const response = await get("/api/activity", { limit: "2" });
    expect(response.status).toBe(200);
    const body = response.body as { events: Array<{ message: string }>; heartbeat: { ok: boolean } };
    expect(body.events).toHaveLength(2);
    // Newest first.
    expect(body.events[0].message).toBe("note 4");
    expect(typeof body.heartbeat.ok).toBe("boolean");
  });

  it("404s unknown API routes", async () => {
    const response = await get("/api/nope");
    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ error: { code: "NOT_FOUND" } });
  });

  it("404s a job id that does not exist", async () => {
    const response = await get("/api/jobs/00000000-0000-0000-0000-000000000000");
    expect(response.status).toBe(404);
  });
});

describe("API — read endpoints have no side effects", () => {
  it("does not create .mex/ or config.json while reading", async () => {
    await get("/api/health");
    await get("/api/snapshot");
    await get("/api/setup/plan");
    await get("/api/graph");
    await get("/api/drift");
    await get("/api/activity");

    expect(existsSync(join(root, ".mex"))).toBe(false);
  });

  it("does not mint an identity into an existing scaffold", async () => {
    writeScaffold({ "ROUTER.md": "# Router\n" });
    await get("/api/snapshot");
    await get("/api/drift");
    await get("/api/activity");

    expect(existsSync(join(root, ".mex", "config.json"))).toBe(false);
  });
});

describe("parseSetupBody", () => {
  it("defaults mode, tools, and buildGraph", () => {
    expect(parseSetupBody({})).toEqual({ mode: "code-repo", tools: [], buildGraph: true });
  });

  it("accepts a full payload and dedupes tools", () => {
    expect(
      parseSetupBody({ mode: "agent-memory", tools: ["claude", "cursor", "claude"], buildGraph: false }),
    ).toEqual({ mode: "agent-memory", tools: ["claude", "cursor"], buildGraph: false });
  });

  it("rejects an unknown mode", () => {
    expect(() => parseSetupBody({ mode: "nope" })).toThrow(/Unknown setup mode/);
  });

  it("rejects an unknown tool instead of dropping it", () => {
    expect(() => parseSetupBody({ tools: ["claude", "emacs"] })).toThrow(/Unknown AI tool "emacs"/);
  });

  it("rejects non-object bodies and wrong field types", () => {
    expect(() => parseSetupBody(null)).toThrow(/JSON object/);
    expect(() => parseSetupBody([])).toThrow(/JSON object/);
    expect(() => parseSetupBody({ tools: "claude" })).toThrow(/must be an array/);
    expect(() => parseSetupBody({ buildGraph: "yes" })).toThrow(/must be a boolean/);
  });
});

describe("API — setup job", () => {
  it("rejects an invalid body with 400", async () => {
    const response = await post("/api/setup", { mode: "nope" });
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: { code: "INVALID_REQUEST" } });
  });

  it("refuses to scaffold the mex repository itself", async () => {
    const router = createApiRouter({ root: process.cwd(), jobs });
    const response = await router({
      method: "POST",
      path: "/api/setup",
      query: new URLSearchParams(),
      body: { mode: "code-repo", tools: [], buildGraph: false },
    });
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ error: { code: "MEX_REPO" } });
  });

  it("scaffolds a project end to end and returns a population prompt", async () => {
    const accepted = await post("/api/setup", {
      mode: "code-repo",
      tools: ["claude"],
      buildGraph: false,
    });
    expect(accepted.status).toBe(202);

    const { job } = accepted.body as { job: Job };
    const finished = await waitForCompletion(job.id);
    expect(finished.status).toBe("succeeded");

    const result = finished.result as HeadlessSetupResult;
    expect(result.prompt.length).toBeGreaterThan(0);
    expect(result.scaffold.some((f) => f.file === "ROUTER.md" && f.action === "copied")).toBe(true);
    expect(result.toolConfigs).toEqual([
      { tool: "claude", dest: "CLAUDE.md", action: "copied" },
    ]);
    expect(result.identity?.scaffold_id).toBeTruthy();

    // The scaffold, tool config, and identity all landed on disk.
    expect(existsSync(join(root, ".mex", "ROUTER.md"))).toBe(true);
    expect(existsSync(join(root, ".mex", "context", "stack.md"))).toBe(true);
    expect(existsSync(join(root, "CLAUDE.md"))).toBe(true);
    const config = JSON.parse(readFileSync(join(root, ".mex", "config.json"), "utf-8"));
    expect(config.aiTools).toEqual(["claude"]);
    expect(typeof config.scaffold_id).toBe("string");

    // The graph step was explicitly declined, not silently attempted.
    const graphStep = finished.steps.find((step) => step.id === "graph");
    expect(graphStep?.status).toBe("skipped");
    expect(existsSync(join(root, ".mex", "graph.db"))).toBe(false);
  });

  it("skips the tools step when no tool is selected", async () => {
    const accepted = await post("/api/setup", { mode: "code-repo", tools: [], buildGraph: false });
    const { job } = accepted.body as { job: Job };
    const finished = await waitForCompletion(job.id);

    expect(finished.steps.find((step) => step.id === "tools")?.status).toBe("skipped");
    expect(existsSync(join(root, "CLAUDE.md"))).toBe(false);
  });

  it("is idempotent — a second run keeps populated files", async () => {
    const first = await post("/api/setup", { mode: "code-repo", tools: [], buildGraph: false });
    await waitForCompletion((first.body as { job: Job }).job.id);

    writeFileSync(join(root, ".mex", "ROUTER.md"), "# Router\n\nHand-written content.\n");

    const second = await post("/api/setup", { mode: "code-repo", tools: [], buildGraph: false });
    const finished = await waitForCompletion((second.body as { job: Job }).job.id);
    const result = finished.result as HeadlessSetupResult;

    expect(result.scaffold.find((f) => f.file === "ROUTER.md")?.action).toBe("skipped");
    expect(readFileSync(join(root, ".mex", "ROUTER.md"), "utf-8")).toContain("Hand-written content.");
  });

  it("exposes running and finished jobs through the jobs endpoints", async () => {
    const accepted = await post("/api/setup", { mode: "code-repo", tools: [], buildGraph: false });
    const { job } = accepted.body as { job: Job };
    await waitForCompletion(job.id);

    const single = await get(`/api/jobs/${job.id}`);
    expect(single.status).toBe(200);
    expect((single.body as { job: Job }).job.status).toBe("succeeded");

    const list = await get("/api/jobs");
    expect((list.body as { jobs: Job[] }).jobs.map((j) => j.id)).toContain(job.id);
  });
});

describe("API — grounding", () => {
  it("reports no coverage and no work to do for a bare project", async () => {
    const response = await get("/api/grounding");
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      graphAvailable: false,
      authored: 0,
      captured: 0,
      needsCapture: false,
      error: null,
    });
  });

  it("refuses to capture without a scaffold", async () => {
    const response = await post("/api/grounding/capture");
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ error: { code: "SCAFFOLD_UNAVAILABLE" } });
  });

  it("refuses to capture without a graph instead of reporting zero baselines", async () => {
    writeScaffold({ "ROUTER.md": "# Router\n" });
    const response = await post("/api/grounding/capture");
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ error: { code: "GRAPH_UNAVAILABLE" } });
  });

  it("captures a baseline for an agent-authored anchor", async () => {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(
      join(root, "src", "math.ts"),
      "export function double(n: number): number {\n  return n * 2;\n}\n" +
        "export function quadruple(n: number): number {\n  return double(double(n));\n}\n",
    );

    const build = await post("/api/graph/build");
    const built = await waitForCompletion((build.body as { job: Job }).job.id);
    expect(built.status).toBe("succeeded");

    // Stand in for the agent: anchor a claim to a node id that really exists.
    const nodeId = findNodeId(root, "double");
    writeScaffold({
      "ROUTER.md": "# Router\n",
      "context/stack.md": [
        "---",
        "name: stack",
        "grounds_to: []",
        'last_updated: "2026-05-01"',
        "---",
        "",
        "# Stack",
        "",
        `Doubling goes through [\`double()\`](mex://${nodeId}).`,
        "",
      ].join("\n"),
    });

    const before = await get("/api/grounding");
    expect(before.body).toMatchObject({
      graphAvailable: true,
      authored: 1,
      captured: 0,
      needsCapture: true,
    });

    const accepted = await post("/api/grounding/capture");
    expect(accepted.status).toBe(202);
    const finished = await waitForCompletion((accepted.body as { job: Job }).job.id);
    expect(finished.status).toBe("succeeded");
    expect(finished.result).toMatchObject({ captured: 1, skipped: 0 });

    const after = await get("/api/grounding");
    expect(after.body).toMatchObject({
      authored: 1,
      captured: 1,
      needsCapture: false,
      files: [{ file: ".mex/context/stack.md", authored: 1, captured: 1 }],
    });
  }, 120_000);

  it("reports an anchor the graph doesn't have as skipped, not captured", async () => {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "math.ts"), "export function double(n: number): number {\n  return n * 2;\n}\n");

    const build = await post("/api/graph/build");
    await waitForCompletion((build.body as { job: Job }).job.id);

    writeScaffold({
      "ROUTER.md": "# Router\n",
      "context/stack.md": "# Stack\n\nA claim about [`ghost()`](mex://function:deadbeef).\n",
    });

    const accepted = await post("/api/grounding/capture");
    const finished = await waitForCompletion((accepted.body as { job: Job }).job.id);
    expect(finished.status).toBe("succeeded");
    expect(finished.result).toMatchObject({ captured: 0, skipped: 1 });
    expect(finished.log.some((entry) => entry.message.includes("function:deadbeef"))).toBe(true);
  }, 120_000);
});

describe("API — graph build job", () => {
  it("builds a real graph and then reports stats", async () => {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(
      join(root, "src", "math.ts"),
      "export function double(n: number): number {\n  return n * 2;\n}\n" +
        "export function quadruple(n: number): number {\n  return double(double(n));\n}\n",
    );

    const accepted = await post("/api/graph/build");
    expect(accepted.status).toBe(202);

    const { job } = accepted.body as { job: Job };
    const finished = await waitForCompletion(job.id);
    expect(finished.status).toBe("succeeded");
    expect(finished.steps[0].detail).toMatch(/nodes/);

    const stats = await get("/api/graph");
    const body = stats.body as {
      available: boolean;
      totals: { nodes: number; files: number };
      nodesByKind: Array<{ kind: string; count: number }>;
      languages: Array<{ language: string }>;
    };
    expect(body.available).toBe(true);
    expect(body.totals.nodes).toBeGreaterThan(0);
    expect(body.totals.files).toBeGreaterThan(0);
    expect(body.nodesByKind.some((entry) => entry.kind === "function")).toBe(true);
    expect(body.languages.some((entry) => entry.language === "typescript")).toBe(true);
  }, 120_000);
});
