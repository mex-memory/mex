import { currentGraphPath } from "../src/graph/storage.js";
import { plantGraph } from "../src/graph/__tests__/plant-graph.js";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  CodeWorkspaceResponseSchema,
  HealthResponseSchema,
  HubCapabilitiesSchema,
  HubJobSnapshotSchema,
  SearchResponseSchema,
} from "@mex/hub-contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createRepositoryGraphPort } from "../src/graph/application-adapter.js";
import { createHubApp } from "../src/hub/app.js";
import { HubJobManager } from "../src/hub/jobs/index.js";
import { createGraphJobExecutors } from "../src/hub/jobs/graph.js";
import { HubSessionManager } from "../src/hub/security/session.js";
import { createLocalHubReadServices } from "../src/hub/services.js";
import { createRepositoryTeamWorkflowPort } from "../src/team/workflow/repository-team-workflow-port.js";
import { TeamLocalState } from "../src/team/local-state/index.js";

const ORIGIN = "http://127.0.0.1:48481";
const HOST = "127.0.0.1:48481";
const BOOTSTRAP_TOKEN = Buffer.alloc(32, 41).toString("base64url");
const roots = new Set<string>();

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

describe("real Project Hub graph integration", () => {
  it("serves one fresh bounded graph snapshot and leaves repository state untouched", async () => {
    const harness = await createHarness(await prepareProject());
    try {
      expect((await harness.app.request(`${ORIGIN}/api/v1/search?q=service`, {
        headers: { host: HOST },
      })).status).toBe(401);

      const before = snapshotProtectedState(harness.root);
      const capabilities = await harness.get("/api/v1/capabilities");
      expect(capabilities.status).toBe(200);
      expect(HubCapabilitiesSchema.parse(await capabilities.json())).toMatchObject({
        graph: {
          read: { availability: "available" },
          refresh: { availability: "available" },
          rebuild: { availability: "available" },
        },
        wiki: {
          read: { availability: "unavailable" },
          refresh: { availability: "unavailable" },
          rebuild: { availability: "unavailable" },
        },
      });

      const searchResponse = await harness.get("/api/v1/search?q=service&limit=1");
      expect(searchResponse.status).toBe(200);
      const search = SearchResponseSchema.parse(await searchResponse.json());
      expect(search.groups.wiki.status).toBe("unavailable");
      expect(search.groups.symbols.status).toBe("available");
      expect(search.groups.sources.status).toBe("available");
      expect(search.groups.symbols.items).toHaveLength(1);
      expect(search.groups.sources.items).toHaveLength(1);
      expect(search.groups.symbols.revision).toBe(search.groups.sources.revision);
      const symbol = search.groups.symbols.items[0];
      if (symbol?.kind !== "code_symbol") throw new Error("Expected a code symbol result.");

      const workspaceResponse = await harness.get(
        `/api/v1/code/symbols/${encodeURIComponent(symbol.id)}?view=callers&limit=25`,
      );
      expect(workspaceResponse.status).toBe(200);
      const workspace = CodeWorkspaceResponseSchema.parse(await workspaceResponse.json());
      expect(workspace.symbol.id).toBe(symbol.id);
      expect(workspace.source.items[0]?.content).toContain("serviceTarget");
      expect(workspace.traversal.view).toBe("callers");

      const healthResponse = await harness.get("/api/v1/health");
      expect(healthResponse.status).toBe(200);
      const health = HealthResponseSchema.parse(await healthResponse.json());
      const graphHealth = health.components.find((component) => component.id === "graph");
      expect(graphHealth).toMatchObject({
        status: "healthy",
        graph: {
          indexStatus: "fresh",
          allowedJobKinds: ["graph_refresh", "graph_rebuild"],
          recommendedJobKind: null,
        },
      });

      const serialized = JSON.stringify({ search, workspace, health });
      expect(serialized).not.toContain(harness.root);
      expect(serialized).not.toContain("wiki sentinel private body");
      expect(snapshotProtectedState(harness.root)).toEqual(before);

      const duplicateQuery = await harness.get("/api/v1/search?q=one&q=two");
      expect(duplicateQuery.status).toBe(400);
      expect(await duplicateQuery.json()).toMatchObject({ code: "VALIDATION_FAILED" });

      writeFileSync(join(harness.root, "src", "service.ts"), changedSource());
      const stale = await harness.get("/api/v1/search?q=service");
      expect(stale.status).toBe(200);
      const staleSearch = SearchResponseSchema.parse(await stale.json());
      expect(staleSearch.groups.symbols).toMatchObject({
        status: "failed",
        code: "INDEX_STALE",
        items: [],
      });
      expect(staleSearch.groups.sources).toMatchObject({
        status: "failed",
        code: "INDEX_STALE",
        items: [],
      });
      expect(staleSearch.groups.wiki.status).toBe("unavailable");
      expect(JSON.stringify(staleSearch)).not.toContain(harness.root);
    } finally {
      await harness.close();
    }
  }, 30_000);

  it("runs refresh and rebuild only after authenticated explicit job requests", async () => {
    const harness = await createHarness(await prepareProject());
    try {
      writeFileSync(join(harness.root, "src", "service.ts"), changedSource());
      expect((await harness.graph.inspectStatus()).status).toBe("stale");

      const refresh = await harness.postJob("graph_refresh");
      expect(refresh.status).toBe(202);
      const refreshJob = HubJobSnapshotSchema.parse(await refresh.json());
      const refreshed = await waitForTerminal(harness.jobs, refreshJob.id);
      expect(refreshed.state).toBe("succeeded");
      expect((await harness.graph.inspectStatus()).status).toBe("fresh");

      plantGraph(harness.root, "intentionally corrupt graph\n");
      expect((await harness.graph.inspectStatus()).status).toBe("corrupt");

      const rebuild = await harness.postJob("graph_rebuild");
      expect(rebuild.status).toBe(202);
      const rebuildJob = HubJobSnapshotSchema.parse(await rebuild.json());
      const rebuilt = await waitForTerminal(harness.jobs, rebuildJob.id);
      expect(rebuilt.state).toBe("succeeded");
      expect((await harness.graph.inspectStatus()).status).toBe("fresh");
      const repairedSearch = await harness.get("/api/v1/search?q=service");
      expect(repairedSearch.status).toBe(200);
      expect(SearchResponseSchema.parse(await repairedSearch.json()).groups.symbols.status).toBe("available");

      const jobs = await harness.get("/api/v1/jobs");
      expect(jobs.status).toBe(200);
      expect(JSON.stringify(await jobs.json())).not.toContain(harness.root);
    } finally {
      await harness.close();
    }
  }, 45_000);
});

interface Harness {
  root: string;
  graph: ReturnType<typeof createRepositoryGraphPort>;
  jobs: HubJobManager;
  app: ReturnType<typeof createHubApp>;
  cookie: string;
  csrfToken: string;
  get(path: string): Promise<Response>;
  postJob(kind: "graph_refresh" | "graph_rebuild"): Promise<Response>;
  close(): Promise<void>;
}

async function createHarness(root: string): Promise<Harness> {
  const graph = createRepositoryGraphPort(root);
  const localState = new TeamLocalState({ projectRoot: root, scaffoldId: "hub-graph-integration" });
  const jobs = new HubJobManager({
    localState,
    executors: createGraphJobExecutors(graph),
    shutdownTimeoutMs: 60_000,
  });
  jobs.initialize();
  const team = await createRepositoryTeamWorkflowPort(root);
  team.initializeIdentityActivitySigner();
  const services = createLocalHubReadServices({
    projectRoot: root,
    scaffoldId: "hub-graph-integration",
    jobs,
    team,
    graph,
  });
  const security = new HubSessionManager({
    bootstrapToken: BOOTSTRAP_TOKEN,
    expectedOrigin: ORIGIN,
    random: (size) => new Uint8Array(size).fill(47),
  });
  const app = createHubApp({
    security,
    services,
    jobs,
    requestId: () => "00000000-0000-4000-8000-000000000041",
  });
  const bootstrap = await app.request(`${ORIGIN}/api/v1/session/bootstrap`, {
    method: "POST",
    headers: {
      host: HOST,
      origin: ORIGIN,
      "content-type": "application/json",
    },
    body: JSON.stringify({ token: BOOTSTRAP_TOKEN }),
  });
  const cookie = bootstrap.headers.get("set-cookie")?.split(";", 1)[0];
  if (bootstrap.status !== 201 || cookie === undefined) throw new Error("Hub bootstrap failed.");
  const session = await app.request(`${ORIGIN}/api/v1/session`, {
    headers: { host: HOST, cookie },
  });
  const csrfToken = (await session.json() as { csrfToken: string }).csrfToken;
  return {
    root,
    graph,
    jobs,
    app,
    cookie,
    csrfToken,
    get: (path) => app.request(`${ORIGIN}${path}`, {
      headers: { host: HOST, cookie },
    }),
    postJob: (kind) => app.request(`${ORIGIN}/api/v1/jobs`, {
      method: "POST",
      headers: {
        host: HOST,
        origin: ORIGIN,
        cookie,
        "content-type": "application/json",
        "x-mex-csrf": csrfToken,
      },
      body: JSON.stringify({ kind }),
    }),
    close: () => jobs.shutdown(),
  };
}

async function prepareProject(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "mex-hub-graph-integration-"));
  roots.add(root);
  write(root, ".gitignore", ".mex/graph.db*\n.mex/local/\n");
  write(root, "src/service.ts", originalSource());
  write(root, ".mex/wiki.db", "wiki sentinel private body\n");
  write(root, ".mex/events/decisions.jsonl", "");
  write(root, ".mex/config.json", `${JSON.stringify({ scaffold_id: "hub-graph-integration" }, null, 2)}\n`);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Hub Graph Test");
  git(root, "config", "user.email", "hub-graph@example.invalid");
  git(root, "add", ".");
  git(root, "commit", "-qm", "fixture");
  await createRepositoryGraphPort(root).rebuild();
  return root;
}

function originalSource(): string {
  return [
    "export function serviceTarget(input: number): number {",
    "  return input * 2;",
    "}",
    "",
    "export function serviceCaller(): number {",
    "  return serviceTarget(21);",
    "}",
    "",
  ].join("\n");
}

function changedSource(): string {
  return [
    "export function serviceTarget(input: number): number {",
    "  return input * 3;",
    "}",
    "",
    "export function serviceCaller(): number {",
    "  return serviceTarget(21);",
    "}",
    "",
  ].join("\n");
}

function write(root: string, path: string, contents: string): void {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents);
}

function git(root: string, ...args: string[]): void {
  execFileSync("git", args, {
    cwd: root,
    stdio: "ignore",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
}

async function waitForTerminal(jobs: HubJobManager, id: string) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const job = jobs.get(id);
    if (job && job.state !== "queued" && job.state !== "running") return job;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw new Error(`Job ${id} did not finish before the test deadline.`);
}

function snapshotProtectedState(root: string): Record<string, unknown> {
  const paths = [
    "src/service.ts",
    ".mex/wiki.db",
    ".mex/events/decisions.jsonl",
    ".mex/local/team.db",
    ".git/HEAD",
    ".git/index",
  ];
  return {
    files: Object.fromEntries(paths.map((path) => [path, snapshotFile(join(root, path))])),
    graph: snapshotFile(currentGraphPath(root)),
    graphDirectory: directoryEntries(dirname(currentGraphPath(root))),
    graphEntries: directoryEntries(join(root, ".mex")),
    localEntries: directoryEntries(join(root, ".mex", "local")),
    gitStatus: execFileSync("git", ["status", "--porcelain=v2", "-z"], {
      cwd: root,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    }).toString("base64"),
  };
}

function snapshotFile(path: string): unknown {
  if (!existsSync(path)) return null;
  const stat = statSync(path);
  return {
    bytes: readFileSync(path).toString("base64"),
    mtimeMs: stat.mtimeMs,
    size: stat.size,
  };
}

function directoryEntries(path: string): string[] {
  return existsSync(path) ? readdirSync(path).sort() : [];
}
