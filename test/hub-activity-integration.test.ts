import { currentGraphPath } from "../src/graph/storage.js";
import { plantGraph } from "../src/graph/__tests__/plant-graph.js";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  ActivityResponseSchema,
  type ActivityResponse,
} from "@mex/hub-contracts";
import { OverviewResponseSchema } from "@mex/hub-contracts/overview";
import { afterEach, describe, expect, it } from "vitest";
import { createHubApp } from "../src/hub/app.js";
import { HubJobManager } from "../src/hub/jobs/index.js";
import {
  startHubNodeServer,
  type RunningHubNodeServer,
} from "../src/hub/node-server.js";
import { HubSessionManager } from "../src/hub/security/session.js";
import { createLocalHubReadServices } from "../src/hub/services.js";
import {
  activityArtifactPath,
  memberArtifactPath,
  serializeActivityArtifact,
  serializeMemberArtifact,
} from "../src/team/artifacts/codecs.js";
import type {
  ActivityEvent,
  ActivityEventV1,
} from "../src/team/contracts/workflow.js";
import { TeamLocalState } from "../src/team/local-state/index.js";
import { createRepositoryTeamWorkflowPort } from "../src/team/workflow/repository-team-workflow-port.js";

const MEMBER_ID = "member_01K3Q080000000000000000001";
const EVENT_ONE = "event_01K3Q080000000000000000001";
const EVENT_TWO = "event_01K3Q080000000000000000002";
const EVENT_THREE = "event_01K3Q080000000000000000003";
const BOOTSTRAP_TOKEN = Buffer.alloc(32, 19).toString("base64url");
const NOW = "2026-08-23T04:00:00.000Z";
const roots = new Set<string>();

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

describe("real Project Hub activity integration", () => {
  it("serves bounded canonical and legacy history with strict read security", async () => {
    const harness = await startHarness(prepareProject());
    try {
      const unauthenticated = await fetch(`${harness.origin}/api/v1/activity`);
      expect(unauthenticated.status).toBe(401);
      expect(unauthenticated.headers.get("content-type")).toContain("application/problem+json");

      const spoofedHost = await harness.app.request(`${harness.origin}/api/v1/activity`, {
        headers: {
          host: `localhost:${harness.server.port}`,
          cookie: harness.cookie,
        },
      });
      expect(spoofedHost.status).toBe(400);

      for (const query of [
        "source=wiki",
        "source=activity&source=legacy",
        "source=activity&unknown=true",
        "since=2026-08-23",
        `cursor=${"x".repeat(4_097)}`,
        "limit=0",
        "limit=101",
      ]) {
        const invalid = await harness.get(`/api/v1/activity?${query}`);
        expect(invalid.status, query).toBe(400);
        expect(await invalid.json(), query).toMatchObject({ code: "INVALID_REQUEST" });
      }

      const first = await harness.get("/api/v1/activity?limit=2");
      expect(first.status).toBe(200);
      expect(first.headers.get("cache-control")).toBe("no-store");
      const firstBody = ActivityResponseSchema.parse(await first.json());
      expect(firstBody.items.map((item) => item.id)).toEqual([EVENT_ONE, EVENT_TWO]);
      expect(firstBody.hasMore).toBe(true);
      expect(firstBody.nextCursor).not.toBeNull();
      expect(firstBody.sourceTruncated).toBe(false);

      const canonical = firstBody.items[0];
      expect(canonical?.source).toBe("activity");
      if (canonical?.source !== "activity") throw new Error("Expected canonical activity.");
      expect(canonical.recordedActor).toEqual({
        kind: "member",
        memberId: MEMBER_ID,
        displayName: "Ada Before Rename",
      });
      expect(canonical.effectiveActor).toEqual({
        kind: "member",
        memberId: MEMBER_ID,
        displayName: "Ada Current",
      });
      expect(canonical.subjects).toHaveLength(8);
      expect(canonical.subjectCount).toBe(10);
      expect(canonical.subjectsTruncated).toBe(true);
      expect(canonical.subjects.map((subject) => subject.kind)).toEqual(
        expect.arrayContaining(["entity", "symbol", "file", "commit"]),
      );
      expect(canonical.repository).toMatchObject({
        branch: "feat/hub-activity-timeline",
        dirty: true,
      });
      expect(canonical.recordOrigin).toEqual({ kind: "unknown" });
      expect(canonical.label).toBeNull();
      expect(firstBody.items[1]).toMatchObject({
        source: "activity",
        action: "relay.closed",
        recordOrigin: { kind: "workflow", operation: "relay.close" },
        label: "Authentication handoff",
      });

      const legacyResponse = await harness.get("/api/v1/activity?source=legacy");
      expect(legacyResponse.status).toBe(200);
      const legacyBody = ActivityResponseSchema.parse(await legacyResponse.json());
      expect(legacyBody.items).toHaveLength(1);
      const legacy = legacyBody.items[0];
      expect(legacy?.source).toBe("legacy");
      if (legacy?.source !== "legacy") throw new Error("Expected legacy activity.");
      expect(legacy).toMatchObject({
        recordedActor: null,
        effectiveActor: null,
        repository: null,
        revision: null,
        message: "Legacy decision retained",
      });
      expect(legacy.subjects).toEqual([{ kind: "file", path: "src/legacy-safe.ts" }]);
      expect(legacyBody.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "LEGACY_ACTIVITY_MALFORMED" }),
      ]));

      const serialized = JSON.stringify({ firstBody, legacyBody });
      for (const secret of [
        "canonical metadata must stay private",
        "/Users/alice/private-project",
        ".mex/traces/private.md",
        "private-agent",
        "private-status",
        "../outside.ts",
        "malformed row secret",
      ]) expect(serialized).not.toContain(secret);
      for (const omitted of ["metadata", "cwd", "trace", "origin", "status", "detail"]) {
        expect(serialized).not.toContain(`\"${omitted}\":`);
      }

      const since = await harness.get(
        "/api/v1/activity?since=2026-08-23T02%3A00%3A00.000Z",
      );
      expect((await since.json() as ActivityResponse).items.map((item) => item.id)).toEqual([
        EVENT_ONE,
        EVENT_TWO,
      ]);

      const overview = await harness.get("/api/v1/overview");
      expect(overview.status).toBe(200);
      const overviewBody = OverviewResponseSchema.parse(await overview.json());
      expect(overviewBody.activity.availability).toBe("available");
      if (overviewBody.activity.availability !== "available") {
        throw new Error("Expected an available bounded Activity preview.");
      }
      expect(overviewBody.activity.items.filter((item) => item.source === "activity")).toHaveLength(2);

      const cursorPage = ActivityResponseSchema.parse(
        await (await harness.get("/api/v1/activity?limit=1")).json(),
      );
      writeActivity(harness.projectRoot, activityEvent({
        id: EVENT_THREE,
        timestamp: "2026-08-23T03:30:00.000Z",
        action: "activity.added_after_cursor",
      }));
      const stale = await harness.get(
        `/api/v1/activity?limit=1&cursor=${encodeURIComponent(cursorPage.nextCursor ?? "")}`,
      );
      expect(stale.status).toBe(409);
      expect(await stale.json()).toMatchObject({ code: "REVISION_CONFLICT" });
    } finally {
      await harness.close();
    }
  });

  it("keeps canonical, local, Git, Graph, and Wiki state byte- and mtime-identical on reads", async () => {
    const harness = await startHarness(prepareProject());
    try {
      const before = snapshotProtectedState(harness.projectRoot);

      const activity = await harness.get("/api/v1/activity?limit=1");
      const first = ActivityResponseSchema.parse(await activity.json());
      expect(activity.status).toBe(200);
      if (first.nextCursor !== null) {
        expect((await harness.get(
          `/api/v1/activity?cursor=${encodeURIComponent(first.nextCursor)}`,
        )).status).toBe(200);
      }
      expect((await harness.get("/api/v1/activity?source=legacy")).status).toBe(200);
      expect((await harness.get("/api/v1/home")).status).toBe(200);
      expect((await harness.get("/api/v1/overview")).status).toBe(200);

      expect(snapshotProtectedState(harness.projectRoot)).toEqual(before);
    } finally {
      await harness.close();
    }
  });

  it("refuses an activity-root symlink without exposing its target or contents", async () => {
    const external = trackedTemp("mex-hub-activity-outside-");
    mkdirSync(join(external, "2026-08"), { recursive: true });
    writeFileSync(join(external, "2026-08", "secret.md"), "outside source secret\n");
    const outsideBefore = snapshotTree(external);
    const harness = await startHarness(prepareProject({ activitySymlinkTarget: external }));
    try {
      const response = await harness.get("/api/v1/activity");
      expect(response.status).toBe(400);
      const body = await response.json() as Record<string, unknown>;
      expect(body).toMatchObject({ code: "PATH_OUTSIDE_PROJECT" });
      expect(JSON.stringify(body)).not.toContain(external);
      expect(JSON.stringify(body)).not.toContain("outside source secret");
      expect(JSON.stringify(body)).not.toContain("private/var");

      const overview = await harness.get("/api/v1/overview");
      expect(overview.status).toBe(200);
      const overviewBody = OverviewResponseSchema.parse(await overview.json());
      expect(overviewBody.activity).toMatchObject({
        availability: "unavailable",
        reason: "Recent team activity could not be read safely.",
      });
      expect(snapshotTree(external)).toEqual(outsideBefore);
    } finally {
      await harness.close();
    }
  });
});

interface Harness {
  projectRoot: string;
  app: ReturnType<typeof createHubApp>;
  server: RunningHubNodeServer;
  origin: string;
  cookie: string;
  get(path: string): Promise<Response>;
  close(): Promise<void>;
}

async function startHarness(projectRoot: string): Promise<Harness> {
  const localState = new TeamLocalState({ projectRoot, scaffoldId: "activity-acceptance" });
  const jobs = new HubJobManager({
    localState,
    now: () => NOW,
    processId: process.pid,
    leaseToken: "a".repeat(64),
  });
  jobs.initialize();
  const team = await createRepositoryTeamWorkflowPort(projectRoot);
  team.initializeIdentityActivitySigner();
  const services = createLocalHubReadServices({
    projectRoot,
    scaffoldId: "activity-acceptance",
    jobs,
    team,
    now: () => new Date(NOW),
  });
  let origin: string | null = null;
  const security = new HubSessionManager({
    bootstrapToken: BOOTSTRAP_TOKEN,
    expectedOrigin: () => origin,
    random: (size) => new Uint8Array(size).fill(29),
  });
  const app = createHubApp({
    security,
    services,
    jobs,
    requestId: () => "00000000-0000-4000-8000-000000000019",
  });
  const server = await startHubNodeServer({ app });
  origin = server.origin;
  const bootstrap = await fetch(`${origin}/api/v1/session/bootstrap`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ token: BOOTSTRAP_TOKEN }),
  });
  const cookie = bootstrap.headers.get("set-cookie")?.split(";", 1)[0];
  if (bootstrap.status !== 201 || cookie === undefined) {
    await server.close();
    await jobs.shutdown();
    throw new Error("Activity acceptance Hub bootstrap failed.");
  }
  return {
    projectRoot,
    app,
    server,
    origin,
    cookie,
    get: (path) => fetch(`${origin}${path}`, { headers: { cookie } }),
    close: async () => {
      await server.close();
      await jobs.shutdown();
    },
  };
}

function prepareProject(options: { activitySymlinkTarget?: string } = {}): string {
  const projectRoot = trackedTemp("mex-hub-activity-acceptance-");
  mkdirSync(join(projectRoot, ".mex", "events"), { recursive: true });
  mkdirSync(join(projectRoot, ".mex", "team", "members"), { recursive: true });
  writeFileSync(join(projectRoot, ".gitignore"), ".mex/local/\n");
  writeFileSync(join(projectRoot, "README.md"), "# Activity acceptance fixture\n");
  plantGraph(projectRoot, "graph sentinel\n");
  writeFileSync(join(projectRoot, ".mex", "wiki.db"), "wiki sentinel\n");
  writeFileSync(join(projectRoot, ".mex", "config.json"), JSON.stringify({
    scaffold_id: "activity-acceptance",
    scaffold_name: "activity-acceptance",
  }, null, 2) + "\n");

  if (options.activitySymlinkTarget === undefined) {
    writeFileSync(
      join(projectRoot, ...memberArtifactPath(MEMBER_ID).split("/")),
      serializeMemberArtifact({
        id: MEMBER_ID,
        displayName: "Ada Current",
        gitAliases: [{ name: "Ada Git", email: "ada@example.test" }],
        active: true,
      }),
    );
    writeActivity(projectRoot, activityEvent());
    const second = activityEvent({
      id: EVENT_TWO,
      timestamp: "2026-08-23T02:00:00.000Z",
      actor: { kind: "git", name: "Grace Git", email: "grace@example.test" },
      action: "relay.closed",
      subjects: [{ kind: "file", path: "src/second.ts" }],
      metadata: undefined,
    });
    writeActivity(projectRoot, {
      ...second,
      schemaVersion: 2,
      origin: { kind: "workflow", operation: "relay.close" },
      label: "Authentication handoff",
    });
    writeFileSync(
      join(projectRoot, ".mex", "events", "activity", "2026-08", "not-an-event.md"),
      "malformed canonical secret /Users/alice/canonical\n",
    );
    writeFileSync(join(projectRoot, ".mex", "events", "decisions.jsonl"), [
      JSON.stringify({
        timestamp: "2026-08-23T01:00:00.000Z",
        kind: "decision",
        message: "Legacy decision retained",
        files: ["src/legacy-safe.ts", "../outside.ts", "/Users/alice/private.ts"],
        cwd: "/Users/alice/private-project",
        trace: ".mex/traces/private.md",
        source: "private-agent",
        status: "private-status",
      }),
      "{\"malformed row secret\":",
      "",
    ].join("\n"));
  } else {
    symlinkSync(options.activitySymlinkTarget, join(projectRoot, ".mex", "events", "activity"), "dir");
  }

  git(projectRoot, ["init", "--quiet", "--initial-branch=main"]);
  git(projectRoot, ["config", "user.name", "Ada Git"]);
  git(projectRoot, ["config", "user.email", "ada@example.test"]);
  git(projectRoot, ["add", ".gitignore", "README.md", ".mex"]);
  git(projectRoot, ["commit", "--quiet", "-m", "activity acceptance fixture"]);
  return projectRoot;
}

function activityEvent(overrides: Partial<ActivityEventV1> = {}): ActivityEventV1 {
  const subjects: ActivityEventV1["subjects"] = [
    { kind: "entity", entity: { id: MEMBER_ID, kind: "member", title: "Ada" } },
    { kind: "code", code: { kind: "symbol", symbolId: "function:activity" } },
    { kind: "code", code: { kind: "file", path: "src/activity.ts" } },
    { kind: "file", path: "src/one.ts" },
    { kind: "commit", hash: "a".repeat(40) },
    ...Array.from({ length: 5 }, (_, index) => ({
      kind: "file" as const,
      path: `src/extra-${index}.ts` as const,
    })),
  ];
  return {
    schemaVersion: 1,
    id: EVENT_ONE,
    timestamp: "2026-08-23T03:00:00.000Z",
    actor: {
      kind: "member",
      memberId: MEMBER_ID,
      displayName: "Ada Before Rename",
    },
    action: "activity.first",
    subjects,
    workstream: { id: "workstream_activity", kind: "workstream", title: "Activity Hub" },
    repoState: {
      branch: "feat/hub-activity-timeline",
      head: "b".repeat(40),
      dirty: true,
      observedAt: "2026-08-23T02:59:59.000Z",
    },
    metadata: { internal_note: "canonical metadata must stay private" },
    ...overrides,
  };
}

function writeActivity(projectRoot: string, event: ActivityEvent): void {
  const path = activityArtifactPath(event);
  const file = join(projectRoot, ...path.split("/"));
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, serializeActivityArtifact(event));
}

interface FileSnapshot {
  path: string;
  bytes: string;
  mtimeNs: string;
}

interface DirectorySnapshot {
  path: string;
  entries: string[];
  mtimeNs: string;
}

function snapshotProtectedState(projectRoot: string): {
  files: FileSnapshot[];
  directories: DirectorySnapshot[];
  gitStatus: string;
} {
  const gitStatus = git(projectRoot, [
    "--no-optional-locks",
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]);
  const rootsToRead = [
    join(projectRoot, ".mex", "events"),
    join(projectRoot, ".mex", "team"),
    join(projectRoot, ".mex", "local"),
    join(projectRoot, ".git", "HEAD"),
    join(projectRoot, ".git", "index"),
    join(projectRoot, ".git", "refs", "heads"),
  ];
  rootsToRead.push(currentGraphPath(projectRoot));
  for (const name of readdirSync(join(projectRoot, ".mex"))) {
    if (name.startsWith("wiki.db")) {
      rootsToRead.push(join(projectRoot, ".mex", name));
    }
  }
  const files: FileSnapshot[] = [];
  const directories: DirectorySnapshot[] = [];
  for (const root of rootsToRead) collectFiles(projectRoot, root, files, directories);
  files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  directories.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return { files, directories, gitStatus };
}

function snapshotTree(root: string): {
  files: FileSnapshot[];
  directories: DirectorySnapshot[];
} {
  const files: FileSnapshot[] = [];
  const directories: DirectorySnapshot[] = [];
  collectFiles(root, root, files, directories);
  files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  directories.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return { files, directories };
}

function collectFiles(
  projectRoot: string,
  path: string,
  files: FileSnapshot[],
  directories: DirectorySnapshot[],
): void {
  if (!existsSync(path)) return;
  const stats = statSync(path, { bigint: true });
  if (stats.isDirectory()) {
    const entries = readdirSync(path).sort();
    directories.push({
      path: relative(projectRoot, path) || ".",
      entries,
      mtimeNs: stats.mtimeNs.toString(),
    });
    for (const name of entries) collectFiles(projectRoot, join(path, name), files, directories);
    return;
  }
  if (!stats.isFile()) return;
  files.push({
    path: relative(projectRoot, path),
    bytes: readFileSync(path).toString("base64"),
    mtimeNs: stats.mtimeNs.toString(),
  });
}

function trackedTemp(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.add(root);
  return root;
}

function git(projectRoot: string, args: readonly string[]): string {
  const result = spawnSync("git", [...args], {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}
