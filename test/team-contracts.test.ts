import { fileURLToPath } from "node:url";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  DATA_OWNERSHIP,
  MEX_ERROR_CODES,
  aggregateWikiGroundingHealth,
  isRepoRelativePath,
  isRevision,
} from "../src/team/contracts/index.js";
import { GRAPH_READ_LIMITS } from "../src/team/contracts/graph.js";
import {
  GIT_CHANGE_STATUSES,
  GIT_READ_LIMITS,
} from "../src/team/contracts/git.js";
import {
  PROPOSAL_STATES,
  RELAY_STATES,
  TEAM_READ_LIMITS,
  WORKSTREAM_STATES,
} from "../src/team/contracts/workflow.js";
import type {
  GraphPage,
  GraphPort,
  GraphRefreshResult,
} from "../src/team/contracts/graph.js";
import type {
  ChangedFile,
  GitDiffTarget,
  GitPage,
} from "../src/team/contracts/git.js";
import type { ProjectHealth } from "../src/team/contracts/health.js";
import type { FileChange, RepoState } from "../src/team/contracts/shared.js";
import type {
  PreparedTeamWorkflowCommand,
  TeamWorkflowApplyRequest,
  TeamWorkflowCommand,
} from "../src/team/contracts/workflow.js";

const REQUIRED_ERROR_CODES = [
  "NOT_FOUND",
  "VALIDATION_FAILED",
  "REVISION_CONFLICT",
  "INDEX_MISSING",
  "INDEX_STALE",
  "INDEX_CORRUPT",
  "MIGRATION_REQUIRED",
  "PATH_OUTSIDE_PROJECT",
  "JOB_ALREADY_RUNNING",
  "JOB_FAILED",
] as const;

describe("human-team application contract lock", () => {
  it("keeps every required stable MEX error code unique", () => {
    expect(new Set(MEX_ERROR_CODES).size).toBe(MEX_ERROR_CODES.length);
    for (const code of REQUIRED_ERROR_CODES) expect(MEX_ERROR_CODES).toContain(code);
  });

  it("accepts only lower-case SHA-256 optimistic revisions", () => {
    expect(isRevision("a".repeat(64))).toBe(true);
    expect(isRevision("A".repeat(64))).toBe(false);
    expect(isRevision("a".repeat(63))).toBe(false);
    expect(isRevision(`g${"a".repeat(63)}`)).toBe(false);
  });

  it("accepts only canonical POSIX repository-relative paths", () => {
    expect(isRepoRelativePath(".mex/context/architecture.md")).toBe(true);
    expect(isRepoRelativePath("src/payments.ts")).toBe(true);
    for (const path of [
      "../outside.md",
      "a/../../outside.md",
      "/absolute/path.md",
      "C:/absolute/path.md",
      "src\\windows-path.ts",
      "src//empty.ts",
      "src/./dot.ts",
      "src/evil\0path.ts",
    ]) expect(isRepoRelativePath(path), path).toBe(false);
  });

  it("never marks derived, local, or ephemeral state as Git-tracked", () => {
    const nonCanonical = DATA_OWNERSHIP.filter((rule) => rule.ownership !== "canonical");
    expect(nonCanonical.length).toBeGreaterThan(0);
    expect(nonCanonical.every((rule) => rule.gitTracked === false)).toBe(true);
    expect(DATA_OWNERSHIP).toEqual(expect.arrayContaining([
      expect.objectContaining({ location: ".mex/graph.db*", ownership: "derived" }),
      expect.objectContaining({ location: ".mex/wiki.db*", ownership: "derived" }),
      expect.objectContaining({ location: ".mex/local/team.db*", ownership: "local" }),
      expect.objectContaining({
        location: ".mex/local/identity-activity-signing.key",
        ownership: "local",
        gitTracked: false,
      }),
      expect.objectContaining({
        location: ".mex/events/activity/YYYY-MM/<event-id>.md",
        ownership: "canonical",
        owner: "team-workflows",
      }),
      expect.objectContaining({
        location: ".mex/events/operations.jsonl",
        ownership: "canonical",
        owner: "wiki-adapter",
      }),
    ]));
  });

  it("derives aggregate Wiki grounding health with stable precedence", () => {
    expect(aggregateWikiGroundingHealth([])).toBe("unverified");
    expect(aggregateWikiGroundingHealth([
      {
        state: "ungrounded",
        health: "unverified",
        observedAt: "2026-08-22T00:00:00.000Z",
      },
      {
        state: "missing",
        health: "missing",
        grounding: { node: "function:gone", fingerprint: "mh:64:gone" },
        requestedNode: "function:gone",
        observedAt: "2026-08-22T00:00:00.000Z",
      },
    ])).toBe("missing");
  });

  it("does not leak database drivers, SQL handles, or mutable Git clients into ports", () => {
    const contractsDir = fileURLToPath(new URL("../src/team/contracts/", import.meta.url));
    const sources = readdirSync(contractsDir)
      .filter((file) => file.endsWith(".ts"))
      .map((file) => ({ file, source: readFileSync(join(contractsDir, file), "utf8") }));
    const forbidden = [
      "node:sqlite",
      "graph/db/",
      "SqliteDatabase",
      "DatabaseSync",
      "simple-git",
      "SimpleGit",
    ];
    for (const { file, source } of sources) {
      for (const token of forbidden) expect(source, `${file} contains ${token}`).not.toContain(token);
    }

    const gitPort = sources.find(({ file }) => file === "git.ts")!.source;
    for (const method of ["stage", "commit", "push", "checkout", "reset", "createBranch", "raw"]) {
      expect(gitPort, `GitPort exposes ${method}`).not.toMatch(new RegExp(`\\b${method}\\s*\\(`));
    }
  });

  it("keeps graph DTOs independent from persisted graph rows", () => {
    const graphContract = readFileSync(
      new URL("../src/team/contracts/graph.ts", import.meta.url),
      "utf8",
    );
    expect(graphContract).not.toContain("../../graph/");
    for (const typeName of [
      "GraphNode",
      "GraphEdge",
      "NodeSearchOptions",
      "SourceChunkMatch",
    ]) {
      expect(graphContract, `graph.ts contains ${typeName}`).not.toMatch(
        new RegExp(`\\b${typeName}\\b`),
      );
    }

    type NodeSearchResult = Awaited<ReturnType<GraphPort["searchNodes"]>>;
    expectTypeOf<NodeSearchResult>().toMatchTypeOf<GraphPage<unknown>>();
    expectTypeOf<GraphRefreshResult["state"]>().toEqualTypeOf<"succeeded">();
  });

  it("publishes hard read bounds and truncation-aware pages", () => {
    expect(GRAPH_READ_LIMITS.defaultPageSize).toBeGreaterThan(0);
    expect(GRAPH_READ_LIMITS.maxPageSize).toBeGreaterThanOrEqual(
      GRAPH_READ_LIMITS.defaultPageSize,
    );
    expect(GRAPH_READ_LIMITS.maxSourceBytes).toBeGreaterThan(0);
    expect(GRAPH_READ_LIMITS.maxResolutionCandidates).toBeGreaterThan(0);
    expect(GIT_READ_LIMITS.maxDiffBytes).toBeGreaterThan(0);
    expect(TEAM_READ_LIMITS.maxPageSize).toBeGreaterThanOrEqual(
      TEAM_READ_LIMITS.defaultPageSize,
    );
    expectTypeOf<GitPage<unknown>>()
      .toMatchTypeOf<{ nextCursor: string | null; truncated: boolean }>();
  });

  it("uses discriminated Git diff targets and changed-file statuses", () => {
    const workingTree: GitDiffTarget = {
      kind: "working-tree",
      includeStaged: true,
      includeUnstaged: false,
    };
    const range: GitDiffTarget = { kind: "range", base: "main", head: "HEAD" };
    const rename: ChangedFile = {
      status: "renamed",
      previousPath: "src/old.ts",
      path: "src/new.ts",
    };

    expect(workingTree.kind).toBe("working-tree");
    expect(range.kind).toBe("range");
    expect(rename.previousPath).toBe("src/old.ts");
    expect(GIT_CHANGE_STATUSES).toEqual([
      "added",
      "modified",
      "deleted",
      "renamed",
      "copied",
      "type_changed",
    ]);
  });

  it("uses typed workflow commands with revision-bound preview application", () => {
    type WikiPlan = { readonly operations: readonly { readonly kind: string }[] };
    const command: TeamWorkflowCommand<WikiPlan> = {
      operationId: "op-1",
      expectedRevisions: [{
        target: { kind: "entity", id: "ws_contract" },
        revision: "b".repeat(64),
        semanticRevision: 1,
      }],
      action: {
        kind: "workstream.update",
        workstreamId: "ws_contract",
        patch: { summary: "Checkpoint 0 contracts locked" },
      },
    };
    const prepared: PreparedTeamWorkflowCommand<WikiPlan> = {
      ...command,
      authority: {
        actor: { kind: "unknown" },
        occurredAt: "2026-08-22T00:00:00.000Z",
        repoState: {
          branch: "integration/human-team-memory-v1",
          head: "a".repeat(40),
          dirty: false,
          observedAt: "2026-08-22T00:00:00.000Z",
        },
      },
    };
    const request: TeamWorkflowApplyRequest<WikiPlan> = {
      command: prepared,
      expectedPreviewRevision: "a".repeat(64),
    };

    expect(command.action.kind).toBe("workstream.update");
    expect(command.expectedRevisions).toHaveLength(1);
    expect(request.expectedPreviewRevision).toHaveLength(64);
    expect(WORKSTREAM_STATES).toEqual([
      "planned",
      "active",
      "blocked",
      "done",
      "archived",
    ]);
    expect(PROPOSAL_STATES).toContain("stale");
    expect(RELAY_STATES).toEqual(["published", "acknowledged", "closed"]);

    const workflowContract = readFileSync(
      new URL("../src/team/contracts/workflow.ts", import.meta.url),
      "utf8",
    );
    expect(workflowContract).toContain("export type TeamWorkflowCommand");
    expect(workflowContract).toContain("expectedRevisions: NonEmptyRevisionExpectations");
    expect(workflowContract).toContain(
      "action: TeamWorkflowRevisionBoundAction<TWikiOperationPlan>",
    );
    for (const bypass of ["saveLocalDraft(", "deleteLocalDraft(", "markCaughtUp("]) {
      expect(workflowContract, `workflow.ts exposes ${bypass}`).not.toContain(bypass);
    }
  });

  it("discriminates canonical file-change revisions by operation kind", () => {
    type CreateChange = Extract<FileChange, { kind: "create" }>;
    type MoveChange = Extract<FileChange, { kind: "move" }>;

    expectTypeOf<CreateChange["beforeRevision"]>().toEqualTypeOf<null>();
    expectTypeOf<CreateChange["afterRevision"]>().toEqualTypeOf<string>();
    expectTypeOf<MoveChange["previousPath"]>().toEqualTypeOf<string>();
  });

  it("requires a fixed aggregate health shape", () => {
    type HealthyGit = Extract<ProjectHealth["git"], { status: "healthy" }>;
    type UnavailableGit = Extract<ProjectHealth["git"], { status: "unavailable" }>;
    type ReadyMigration = Extract<ProjectHealth["migration"], { status: "healthy" }>;

    expectTypeOf<HealthyGit["repo"]>().toEqualTypeOf<RepoState>();
    expectTypeOf<UnavailableGit["repo"]>().toEqualTypeOf<null>();
    expectTypeOf<ReadyMigration["state"]>().toEqualTypeOf<"ready">();

    const health: ProjectHealth = {
      status: "degraded",
      observedAt: "2026-08-22T00:00:00.000Z",
      git: {
        status: "healthy",
        summary: "clean",
        diagnostics: [],
        repo: {
          branch: "main",
          head: "48da30ceea54c8716b561c7ba08541df99024e9b",
          dirty: false,
          observedAt: "2026-08-22T00:00:00.000Z",
        },
      },
      graph: { status: "unavailable", summary: "missing", diagnostics: [], index: null },
      wiki: { status: "unavailable", summary: "missing", diagnostics: [], index: null },
      migration: {
        status: "healthy",
        summary: "ready",
        diagnostics: [],
        state: "ready",
        fromVersion: null,
        toVersion: null,
      },
      localState: {
        status: "healthy",
        summary: "ready",
        diagnostics: [],
        state: "ready",
        schemaVersion: 1,
      },
      diagnostics: [],
    };

    expect(Object.keys(health)).toEqual([
      "status",
      "observedAt",
      "git",
      "graph",
      "wiki",
      "migration",
      "localState",
      "diagnostics",
    ]);
  });
});
