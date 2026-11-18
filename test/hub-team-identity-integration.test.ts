import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  ActivityResponseSchema,
  HomeResponseSchema,
  HubCapabilitiesSchema,
  SpecDetailResponseSchema,
  SpecListResponseSchema,
  TeamCurrentActorResponseSchema,
  TeamMemberListResponseSchema,
  TeamOperationApplyResponseSchema,
  TeamOperationPreviewResponseSchema,
  TeamWorkstreamListResponseSchema,
  TeamWorkstreamSchema,
} from "@mex/hub-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHubApp } from "../src/hub/app.js";
import { HubSessionManager } from "../src/hub/security/session.js";
import {
  createLocalHubReadServices,
  type HubGraphReadService,
  type HubWikiReadService,
} from "../src/hub/services.js";
import { TEAM_RECEIPT_SIGNER_RELATIVE_PATH } from "../src/team/local-state/receipt-signer.js";
import { createRepositoryTeamWorkflowPort } from "../src/team/workflow/repository-team-workflow-port.js";
import { createRepositoryWikiPort } from "../src/wiki/application-adapter.js";
import { rebuildWikiIndex } from "../src/wiki/index/rebuild.js";

const ORIGIN = "http://127.0.0.1:43147";
const HOST = "127.0.0.1:43147";
const BOOTSTRAP_TOKEN = Buffer.alloc(32, 71).toString("base64url");
const roots = new Set<string>();

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

describe("real Project Hub Team identity integration", () => {
  it("serves authenticated C0 reads and exact preview/apply without index maintenance", async () => {
    const root = prepareProject();
    const team = await createRepositoryTeamWorkflowPort(root);
    team.initializeIdentityActivitySigner();
    const adapters = unusedIndexAdapters();
    const hub = await createHarness(root, team, adapters);

    expect((await hub.app.request(`${ORIGIN}/api/v1/members`, {
      headers: { host: HOST },
    })).status).toBe(401);

    const capabilities = HubCapabilitiesSchema.parse(
      await (await hub.get("/api/v1/capabilities")).json(),
    );
    expect(capabilities).toMatchObject({
      activityRecord: { availability: "available" },
      members: {
        read: { availability: "available" },
        canonicalMutation: { availability: "available" },
        localSelection: { availability: "available" },
      },
    });

    const beforeReads = snapshotReadProtectedState(root);
    const initialMembers = TeamMemberListResponseSchema.parse(
      await (await hub.get("/api/v1/members?active=true&limit=1")).json(),
    );
    expect(initialMembers.items).toEqual([]);
    const initialActor = TeamCurrentActorResponseSchema.parse(
      await (await hub.get("/api/v1/actor/current")).json(),
    );
    expect(initialActor).toMatchObject({
      source: "git-fallback",
      actor: { kind: "git", name: "Hub Identity", email: "hub-identity@example.invalid" },
      selection: null,
    });
    expect(snapshotReadProtectedState(root)).toEqual(beforeReads);

    const addPreview = TeamOperationPreviewResponseSchema.parse(
      await (await hub.post("/api/v1/team/operations/preview", {
        operationId: "hub_member_add",
        action: {
          kind: "member.add",
          member: {
            displayName: "Ada Lovelace",
            gitAliases: [{ name: "Hub Identity", email: "hub-identity@example.invalid" }],
          },
        },
        expectedRevisions: [],
      })).json(),
    );
    expect(addPreview.receipt.authority.actor).toEqual(initialActor.actor);
    expect(addPreview.receipt.purposeIds.map((item) => item.purpose)).toEqual([
      "activity",
      "member",
    ]);
    expect(snapshotReadProtectedState(root)).toEqual(beforeReads);

    const indexesBeforeApply = snapshotIndexAndGitInternals(root);
    const added = TeamOperationApplyResponseSchema.parse(
      await (await hub.post("/api/v1/team/operations/apply", addPreview)).json(),
    );
    expect(added).toMatchObject({
      operationId: "hub_member_add",
      applied: true,
      idempotentReplay: false,
      members: [{ displayName: "Ada Lovelace", active: true }],
      events: [{ action: "member.added", actor: initialActor.actor }],
    });
    expect(added.events).toHaveLength(1);
    expect(snapshotIndexAndGitInternals(root)).toEqual(indexesBeforeApply);

    const member = added.members[0]!;
    const memberDetail = await hub.get(`/api/v1/members/${encodeURIComponent(member.id)}`);
    expect(memberDetail.status).toBe(200);
    expect(await memberDetail.json()).toEqual(member);

    const beforeNoOp = snapshotReadProtectedState(root);
    const noOp = await hub.post("/api/v1/team/operations/preview", {
      operationId: "hub_member_noop_update",
      action: {
        kind: "member.update",
        memberId: member.id,
        patch: {
          displayName: member.displayName,
          gitAliases: member.gitAliases,
        },
      },
      expectedRevisions: [{
        target: { kind: "artifact", path: member.sourcePath },
        revision: member.revision,
      }],
    });
    expect(noOp.status).toBe(422);
    expect(await noOp.json()).toMatchObject({
      code: "VALIDATION_FAILED",
      title: "Validation failed",
    });
    expect(snapshotReadProtectedState(root)).toEqual(beforeNoOp);

    const replayed = TeamOperationApplyResponseSchema.parse(
      await (await hub.post("/api/v1/team/operations/apply", addPreview)).json(),
    );
    expect(replayed).toMatchObject({ idempotentReplay: true, operationId: "hub_member_add" });
    expect(ActivityResponseSchema.parse(
      await (await hub.get("/api/v1/activity?source=activity")).json(),
    ).items).toHaveLength(1);

    const selectionPreview = TeamOperationPreviewResponseSchema.parse(
      await (await hub.post("/api/v1/team/operations/preview", {
        operationId: "hub_member_select",
        action: { kind: "member.select", memberId: member.id },
        expectedRevisions: [
          {
            target: { kind: "artifact", path: member.sourcePath },
            revision: member.revision,
          },
          {
            target: { kind: "local", namespace: "member-selection", id: "current" },
            revision: null,
          },
        ],
      })).json(),
    );
    expect(selectionPreview.preview).toMatchObject({ scope: "local", changes: [] });
    const selected = TeamOperationApplyResponseSchema.parse(
      await (await hub.post("/api/v1/team/operations/apply", selectionPreview)).json(),
    );
    expect(selected).toMatchObject({ events: [], members: [], localChanges: [{
      namespace: "member-selection",
      id: "current",
    }] });
    expect(TeamCurrentActorResponseSchema.parse(
      await (await hub.get("/api/v1/actor/current")).json(),
    )).toMatchObject({
      source: "configured-member",
      actor: { kind: "member", memberId: member.id, displayName: "Ada Lovelace" },
      selection: { memberId: member.id },
    });
    expect(ActivityResponseSchema.parse(
      await (await hub.get("/api/v1/activity?source=activity")).json(),
    ).items).toHaveLength(1);

    const directPreview = TeamOperationPreviewResponseSchema.parse(
      await (await hub.post("/api/v1/team/operations/preview", {
        operationId: "hub_activity_record",
        action: {
          kind: "activity.record",
          activity: {
            action: "review.completed",
            subjects: [{ kind: "entity", entity: { id: member.id, kind: "member" } }],
          },
        },
        expectedRevisions: [],
      })).json(),
    );
    const recorded = TeamOperationApplyResponseSchema.parse(
      await (await hub.post("/api/v1/team/operations/apply", directPreview)).json(),
    );
    expect(recorded.events).toHaveLength(1);
    expect(recorded.events[0]).toMatchObject({
      action: "review.completed",
      actor: { kind: "member", memberId: member.id, displayName: "Ada Lovelace" },
      timestamp: directPreview.receipt.authority.occurredAt,
      repoState: directPreview.receipt.authority.repoState,
    });
    const serialized = JSON.stringify({ addPreview, added, selectionPreview, selected, recorded });
    expect(serialized).not.toContain(root);
    expect(serialized).not.toContain("operations.jsonl");
    expect(serialized).not.toContain("team.db");
    expect(serialized).not.toContain("journal");

    const activity = ActivityResponseSchema.parse(
      await (await hub.get("/api/v1/activity?source=activity")).json(),
    );
    expect(activity.items).toHaveLength(2);
    expect(activity.items.find((item) => item.action === "member.added")).toMatchObject({
      recordedActor: initialActor.actor,
      effectiveActor: { kind: "member", memberId: member.id, displayName: "Ada Lovelace" },
    });
    expect(snapshotIndexAndGitInternals(root)).toEqual(indexesBeforeApply);
    expect(adapters.graphCalls).toHaveBeenCalledTimes(0);
    expect(adapters.wikiCalls).toHaveBeenCalledTimes(0);
  });

  it("lets the first C preview provision only its contained local signer", async () => {
    const root = prepareProject();
    const team = await createRepositoryTeamWorkflowPort(root);
    const adapters = unusedIndexAdapters();
    const hub = await createHarness(root, team, adapters);
    const before = snapshotIndexAndGitInternals(root);
    expect(existsSync(join(root, ".mex", "local"))).toBe(false);

    const preview = await hub.post("/api/v1/team/operations/preview", {
      operationId: "hub_signer_fallback",
      action: { kind: "activity.record", activity: { action: "review.previewed", subjects: [] } },
      expectedRevisions: [],
    });
    expect(preview.status).toBe(200);
    TeamOperationPreviewResponseSchema.parse(await preview.json());

    const local = join(root, ".mex", "local");
    expect(readdirSync(local)).toEqual(["identity-activity-signing.key"]);
    const key = join(root, ...TEAM_RECEIPT_SIGNER_RELATIVE_PATH.split("/"));
    expect(readFileSync(key)).toHaveLength(32);
    if (process.platform !== "win32") expect(statSync(key).mode & 0o777).toBe(0o600);
    expect(existsSync(join(local, "team.db"))).toBe(false);
    expect(snapshotIndexAndGitInternals(root)).toEqual(before);
    expect(adapters.graphCalls).toHaveBeenCalledTimes(0);
    expect(adapters.wikiCalls).toHaveBeenCalledTimes(0);
  });

  it("rejects an untracked working scaffold identity before Hub composition", async () => {
    const root = prepareProject();
    const config = join(root, ".mex", "config.json");
    writeFileSync(config, `${JSON.stringify({ scaffold_id: "working-copy-only" }, null, 2)}\n`);
    await expect(createRepositoryTeamWorkflowPort(root)).rejects.toMatchObject({
      problem: { code: "MIGRATION_REQUIRED" },
    });
    expect(existsSync(join(root, ".mex", "local"))).toBe(false);
  });
});

type TeamService = Awaited<ReturnType<typeof createRepositoryTeamWorkflowPort>>;

async function createHarness(
  root: string,
  team: TeamService,
  adapters: ReturnType<typeof unusedIndexAdapters>,
) {
  const services = createLocalHubReadServices({
    projectRoot: root,
    scaffoldId: "hub-team-identity",
    jobs: { list: () => ({ items: [] }) },
    team,
    workstreams: team,
    graph: adapters.graph,
    wiki: adapters.wiki,
  });
  const security = new HubSessionManager({
    bootstrapToken: BOOTSTRAP_TOKEN,
    expectedOrigin: ORIGIN,
    random: (size) => new Uint8Array(size).fill(73),
  });
  const app = createHubApp({
    security,
    services,
    requestId: () => "00000000-0000-4000-8000-000000000147",
  });
  const bootstrap = await app.request(`${ORIGIN}/api/v1/session/bootstrap`, {
    method: "POST",
    headers: { host: HOST, origin: ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ token: BOOTSTRAP_TOKEN }),
  });
  const cookie = bootstrap.headers.get("set-cookie")?.split(";", 1)[0];
  if (bootstrap.status !== 201 || cookie === undefined) throw new Error("Hub bootstrap failed.");
  const session = await app.request(`${ORIGIN}/api/v1/session`, {
    headers: { host: HOST, cookie },
  });
  const csrfToken = (await session.json() as { csrfToken: string }).csrfToken;
  return {
    app,
    get: (path: string) => app.request(`${ORIGIN}${path}`, {
      headers: { host: HOST, cookie },
    }),
    post: (path: string, body: unknown) => app.request(`${ORIGIN}${path}`, {
      method: "POST",
      headers: {
        host: HOST,
        origin: ORIGIN,
        cookie,
        "content-type": "application/json",
        "x-mex-csrf": csrfToken,
      },
      body: JSON.stringify(body),
    }),
  };
}

function unusedIndexAdapters() {
  const graphCalls = vi.fn(async (): Promise<never> => { throw new Error("Graph must not run."); });
  const wikiCalls = vi.fn(async (): Promise<never> => { throw new Error("Wiki must not run."); });
  const graph: HubGraphReadService = {
    inspectStatus: graphCalls,
    searchBundle: graphCalls,
    readSymbolWorkspace: graphCalls,
  };
  const wiki: HubWikiReadService = {
    inspectIndex: wikiCalls,
    listBundle: wikiCalls,
    searchBundle: wikiCalls,
    readKnowledgeWorkspace: wikiCalls,
    knowledgeForCode: wikiCalls,
  };
  return { graph, wiki, graphCalls, wikiCalls };
}

function prepareProject(): string {
  const root = mkdtempSync(join(tmpdir(), "mex-hub-team-identity-"));
  roots.add(root);
  write(root, ".gitignore", ".mex/local/\n.mex/graph.db*\n.mex/wiki.db*\n");
  write(root, "README.md", "# Hub Team identity fixture\n");
  write(root, ".mex/config.json", `${JSON.stringify({
    scaffold_id: "hub-team-identity",
    scaffold_name: "hub-team-identity",
  }, null, 2)}\n`);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Hub Identity");
  git(root, "config", "user.email", "hub-identity@example.invalid");
  git(root, "add", ".gitignore", "README.md", ".mex/config.json");
  git(root, "commit", "-qm", "fixture: tracked Hub Team identity");
  write(root, ".mex/graph.db", "graph-index-sentinel\n");
  write(root, ".mex/wiki.db", "wiki-index-sentinel\n");
  return root;
}

function write(root: string, relativePath: string, contents: string): void {
  const file = join(root, ...relativePath.split("/"));
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, contents);
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function snapshotReadProtectedState(root: string): readonly FileSnapshot[] {
  return snapshotFiles(root, [
    ".mex/config.json",
    ".mex/team",
    ".mex/events",
    ".mex/local",
    ".mex/graph.db",
    ".mex/wiki.db",
    ".git/HEAD",
    ".git/index",
    ".git/refs/heads/main",
  ]);
}

function snapshotIndexAndGitInternals(root: string): readonly FileSnapshot[] {
  return snapshotFiles(root, [
    ".mex/graph.db",
    ".mex/wiki.db",
    ".git/HEAD",
    ".git/index",
    ".git/refs/heads/main",
  ]);
}

interface FileSnapshot {
  path: string;
  bytes: string;
  mtimeMs: number;
  mode: number;
}

function snapshotFiles(root: string, paths: readonly string[]): readonly FileSnapshot[] {
  const snapshots: FileSnapshot[] = [];
  for (const path of paths) collect(root, join(root, ...path.split("/")), snapshots);
  return snapshots.sort((left, right) => left.path.localeCompare(right.path));
}

function collect(root: string, path: string, snapshots: FileSnapshot[]): void {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (stat.isDirectory()) {
    for (const child of readdirSync(path)) collect(root, join(path, child), snapshots);
    return;
  }
  snapshots.push({
    path: relative(root, path),
    bytes: readFileSync(path).toString("base64"),
    mtimeMs: stat.mtimeMs,
    mode: stat.mode,
  });
}
