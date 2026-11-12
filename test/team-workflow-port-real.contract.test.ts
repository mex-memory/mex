import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  defineTeamWorkflowPortContract,
  type InvalidTeamWorkflowCommandCase,
  type PreparedCommandAlteration,
  type TeamWorkflowCommandCase,
  type TeamWorkflowContractPhase,
  type TeamWorkflowContractScenario,
  type TeamWorkflowJournalInspection,
  type TeamWorkflowLocalSchemaInspection,
  type TeamWorkflowPhasePause,
  type TeamWorkflowPortContractFactory,
  type TeamWorkflowPortContractHarness,
  type TeamWorkflowPortContractSnapshot,
} from "./contracts/team-workflow-port.contract.js";
import { parseActivityArtifact } from "../src/team/artifacts/codecs.js";
import { generateArtifactId } from "../src/team/artifacts/ulid.js";
import {
  InboxProposalRepository,
  PlaybookRepository,
  PlaybookRunRepository,
  RelayRepository,
  WorkstreamRepository,
  WORKFLOW_REPOSITORY_LIMITS,
} from "../src/team/artifacts/workflow-repositories.js";
import type {
  ActorRef,
  JsonValue,
  RepoRelativePath,
  Revision,
  RevisionExpectation,
} from "../src/team/contracts/shared.js";
import type {
  InboxDraftInput,
  PreparedTeamWorkflowCommand,
  TeamWorkflowCommand,
  TeamWorkflowPort,
} from "../src/team/contracts/workflow.js";
import type {
  WikiPort,
  WikiRevisionExpectation,
} from "../src/team/contracts/wiki.js";
import { createRepositoryGitPort } from "../src/team/git/git-port.js";
import { MemberRepository } from "../src/team/identity/member-repository.js";
import { TeamLocalState } from "../src/team/local-state/index.js";
import { MockWikiPort } from "../src/team/testing/wiki/mock-wiki-port.js";
import { POPULATED_WIKI_FIXTURE } from "../src/team/testing/wiki/populated-fixture.js";
import {
  createRepositoryTeamWorkflowPortWithDependencies,
  type RepositoryTeamWorkflowPort,
  WorkflowPhaseInterruption,
} from "../src/team/workflow/repository-team-workflow-port.js";
import {
  createRepositoryWikiPort,
  type RepositoryWikiPort,
} from "../src/wiki/application-adapter.js";

const NOW = "2026-08-27T04:05:06.000Z";
const LATER = "2026-08-27T04:05:07.000Z";
const SCAFFOLD_ID = "team_workflow_conformance_v1";
const MEMBER_ID = artifactId("member", 1);
const ACTIVE_WORKSTREAM_ID = artifactId("ws", 2);
const ARCHIVED_WORKSTREAM_ID = artifactId("ws", 3);
const PROPOSAL_ID = artifactId("proposal", 4);
const RELAY_ID = artifactId("relay", 5);
const PLAYBOOK_ID = artifactId("playbook", 6);
const RUN_ID = artifactId("run", 7);
const LOCAL_DRAFT_ID = "inbox_contract_baseline";
const REAL_WIKI_ENTITY = "mx_01K4FAM7W8N9R3T5Y6Q2ZBCHJD";
const ACTOR: ActorRef = {
  kind: "member",
  memberId: MEMBER_ID,
  displayName: "Ada Lovelace",
};
const PRIVACY_SENTINELS = [
  "contract-private-source-body",
  "contract-private-prompt-transcript",
] as const;

type ContractPort = RepositoryTeamWorkflowPort<JsonValue, unknown>;
type PortableWikiRequest = InboxDraftInput<JsonValue>["request"];

const repositoryFactory: TeamWorkflowPortContractFactory<JsonValue> = {
  open: (scenario) => RepositoryContractHarness.open(scenario),
};

defineTeamWorkflowPortContract("repository adapter", repositoryFactory);

describe("repository TeamWorkflowPort durable Wiki recovery", () => {
  it("resumes a completed-child Wiki prefix from the bounded journal manifest", async () => {
    const container = mkdtempSync(join(tmpdir(), "mex-team-wiki-recovery-"));
    const root = join(container, "repository");
    mkdirSync(root);
    try {
      initGit(root);
      write(root, ".gitignore", ".mex/local/\n.mex/wiki.db*\n.mex/graph.db*\n");
      write(root, ".mex/config.json", `${JSON.stringify({ scaffold_id: SCAFFOLD_ID }, null, 2)}\n`);
      const document = realWikiDocument();
      const destination = "# Recovery destination\n";
      write(root, ".mex/context/architecture.md", document);
      write(root, ".mex/context/recovery.md", destination);
      write(root, ".mex/events/operations.jsonl", "");

      let crashed = false;
      const interruptedWiki = createRepositoryWikiPort(root, {
        now: () => NOW,
        __internal: {
          onOperationCompleted: () => {
            if (crashed) return;
            crashed = true;
            throw new Error("simulated process death between Wiki batch children");
          },
        },
      });
      await interruptedWiki.rebuildIndex();
      const entity = await interruptedWiki.getEntity(REAL_WIKI_ENTITY);
      if (entity === null) throw new Error("real Wiki recovery fixture entity is missing");
      const destinationRevision = hash(destination);
      const wikiRequest: PortableWikiRequest = {
        operation: {
          opId: "wiki_team_recovery",
          type: "update-entry",
          entityId: REAL_WIKI_ENTITY,
          baseRevision: entity.version.semanticRevision,
          baseContentHash: entity.version.contentHash,
          reason: "Exercise Team-owned durable Wiki recovery.",
          payload: {
            operations: [
              {
                type: "update-entry",
                entityId: REAL_WIKI_ENTITY,
                summary: "The first child landed before restart.",
              },
              {
                type: "create-entry",
                payload: {
                  file: "context/recovery.md",
                  insertAt: { at: "end-of-file" },
                  type: "convention",
                  title: "Resume through the Team journal",
                  body: "Persist only bounded IDs, revisions, paths, hashes, and audit state.",
                  headingDepth: 2,
                },
              },
            ],
          },
        },
        expectedRevisions: [
          { target: { kind: "entity", id: REAL_WIKI_ENTITY }, version: entity.version },
          {
            target: { kind: "artifact", path: ".mex/context/recovery.md" },
            contentHash: destinationRevision,
          },
        ],
      };
      const targetRevisions: readonly RevisionExpectation[] = [
        entityExpectation(REAL_WIKI_ENTITY, entity.version),
        artifactExpectation(".mex/context/recovery.md", destinationRevision),
      ];
      await seedCanonicalTeamArtifacts(root, wikiRequest, targetRevisions);
      git(root, ["add", "--", "."]);
      git(root, ["commit", "-q", "-m", "durable Wiki recovery baseline"]);

      const proposal = await requiredArtifact(
        new InboxProposalRepository<JsonValue>(root).get(PROPOSAL_ID),
      );
      const command: TeamWorkflowCommand<JsonValue> = {
        operationId: "team_wiki_recovery",
        action: { kind: "inbox.approve", proposalId: PROPOSAL_ID },
        expectedRevisions: [artifactExpectation(proposal.sourcePath, proposal.revision)],
      };
      const interrupted = createRepositoryTeamWorkflowPortWithDependencies<JsonValue, unknown>(root, {
        scaffoldId: SCAFFOLD_ID,
        wiki: interruptedWiki as unknown as WikiPort<unknown, JsonValue, unknown, unknown>,
        git: createRepositoryGitPort(root, { now: () => new Date(NOW) }),
        now: () => new Date(NOW),
        pid: 41_001,
        processStatus: () => "alive",
        idFactories: {
          activity: () => generateArtifactId("event", {
            now: Date.parse(NOW),
            random: new Uint8Array(10).fill(91),
          }),
          leaseToken: () => hash("interrupted-team-wiki-recovery-lease"),
        },
      });
      const preview = await interrupted.preview(command);
      const applyRequest = {
        command: preview.command,
        expectedPreviewRevision: preview.previewRevision,
      };
      await expect(interrupted.apply(applyRequest)).rejects.toThrow();
      expect(readFileSync(join(root, ".mex/context/architecture.md"), "utf8"))
        .toContain("The first child landed before restart.");
      expect(readFileSync(join(root, ".mex/context/recovery.md"), "utf8"))
        .not.toContain("Resume through the Team journal");
      expect(readFileSync(join(root, ".mex/events/operations.jsonl"), "utf8"))
        .toContain("wiki_team_recovery_item_01");
      expect((await new InboxProposalRepository<JsonValue>(root).get(PROPOSAL_ID))?.state)
        .toBe("pending");

      const resumedWiki = createRepositoryWikiPort(root, { now: () => NOW });
      const restarted = createRepositoryTeamWorkflowPortWithDependencies<JsonValue, unknown>(root, {
        scaffoldId: SCAFFOLD_ID,
        wiki: resumedWiki as unknown as WikiPort<unknown, JsonValue, unknown, unknown>,
        git: createRepositoryGitPort(root, { now: () => new Date(NOW) }),
        now: () => new Date(NOW),
        pid: 41_002,
        processStatus: (pid) => pid === 41_001 ? "dead" : "alive",
        idFactories: {
          leaseToken: () => hash("resumed-team-wiki-recovery-lease"),
        },
      });
      const result = await restarted.apply(applyRequest);
      expect(result.idempotentReplay).toBe(true);
      expect(result.events).toHaveLength(1);
      expect((await new InboxProposalRepository<JsonValue>(root).get(PROPOSAL_ID))?.state)
        .toBe("approved");
      expect(readFileSync(join(root, ".mex/context/recovery.md"), "utf8"))
        .toContain("Resume through the Team journal");
      expect((await resumedWiki.getEntity(REAL_WIKI_ENTITY))?.summary)
        .toBe("The first child landed before restart.");
      // Proposal and Activity publication happen after Wiki recovery and are
      // intentionally not hidden behind automatic index maintenance.
      expect((await resumedWiki.inspectIndex()).state).toBe("stale");
      expect(activityEvents(root)).toHaveLength(1);
      await expect(restarted.apply(applyRequest)).resolves.toMatchObject({
        idempotentReplay: true,
      });
      expect(activityEvents(root)).toHaveLength(1);
    } finally {
      rmSync(container, { recursive: true, force: true });
    }
  });

  it("retains the journal when Wiki audit is absent but canonical effects changed", async () => {
    const container = mkdtempSync(join(tmpdir(), "mex-team-wiki-audit-loss-"));
    const root = join(container, "repository");
    mkdirSync(root);
    try {
      initGit(root);
      write(root, ".gitignore", ".mex/local/\n.mex/wiki.db*\n.mex/graph.db*\n");
      write(root, ".mex/config.json", `${JSON.stringify({ scaffold_id: SCAFFOLD_ID }, null, 2)}\n`);
      const document = realWikiDocument();
      write(root, ".mex/context/architecture.md", document);
      write(root, ".mex/events/operations.jsonl", "");

      const wiki = createRepositoryWikiPort(root, { now: () => NOW });
      await wiki.rebuildIndex();
      const entity = await wiki.getEntity(REAL_WIKI_ENTITY);
      if (entity === null) throw new Error("real Wiki audit-loss fixture entity is missing");
      const wikiRequest = portableWikiUpdate(
        "wiki_team_audit_loss",
        REAL_WIKI_ENTITY,
        entity.version,
        {
          operations: [{
            type: "update-entry",
            entityId: REAL_WIKI_ENTITY,
            summary: "The canonical effect landed before its audit disappeared.",
          }],
        },
      );
      const targetRevisions: readonly RevisionExpectation[] = [
        entityExpectation(REAL_WIKI_ENTITY, entity.version),
      ];
      await seedCanonicalTeamArtifacts(root, wikiRequest, targetRevisions);
      git(root, ["add", "--", "."]);
      git(root, ["commit", "-q", "-m", "Wiki audit-loss recovery baseline"]);

      const proposal = await requiredArtifact(
        new InboxProposalRepository<JsonValue>(root).get(PROPOSAL_ID),
      );
      const command: TeamWorkflowCommand<JsonValue> = {
        operationId: "team_wiki_audit_loss",
        action: { kind: "inbox.approve", proposalId: PROPOSAL_ID },
        expectedRevisions: [artifactExpectation(proposal.sourcePath, proposal.revision)],
      };
      let failedAfterPrimary = false;
      const interrupted = createRepositoryTeamWorkflowPortWithDependencies<JsonValue, unknown>(root, {
        scaffoldId: SCAFFOLD_ID,
        wiki: wiki as unknown as WikiPort<unknown, JsonValue, unknown, unknown>,
        git: createRepositoryGitPort(root, { now: () => new Date(NOW) }),
        now: () => new Date(NOW),
        pid: 42_001,
        processStatus: () => "alive",
        afterPrimaryApply: () => {
          if (failedAfterPrimary) return;
          failedAfterPrimary = true;
          write(root, ".mex/events/operations.jsonl", "");
          throw new Error("simulated Wiki audit loss after canonical publication");
        },
        idFactories: {
          activity: () => generateArtifactId("event", {
            now: Date.parse(NOW),
            random: new Uint8Array(10).fill(92),
          }),
          leaseToken: () => hash("interrupted-team-wiki-audit-loss-lease"),
        },
      });
      const preview = await interrupted.preview(command);
      const applyRequest = {
        command: preview.command,
        expectedPreviewRevision: preview.previewRevision,
      };

      await expect(interrupted.apply(applyRequest)).rejects.toThrow(
        "simulated Wiki audit loss after canonical publication",
      );
      expect((await new InboxProposalRepository<JsonValue>(root).get(PROPOSAL_ID))?.state)
        .toBe("approved");
      expect(readFileSync(join(root, ".mex/context/architecture.md"), "utf8"))
        .toContain("The canonical effect landed before its audit disappeared.");
      expect(activityEvents(root)).toHaveLength(0);
      expect(new TeamLocalState(localOptions(root)).getIncompleteWorkflowOperation())
        .toMatchObject({ operationId: command.operationId, phase: "intent" });

      const restarted = createRepositoryTeamWorkflowPortWithDependencies<JsonValue, unknown>(root, {
        scaffoldId: SCAFFOLD_ID,
        wiki: createRepositoryWikiPort(root, { now: () => NOW }) as unknown as WikiPort<unknown, JsonValue, unknown, unknown>,
        git: createRepositoryGitPort(root, { now: () => new Date(NOW) }),
        now: () => new Date(NOW),
        pid: 42_002,
        processStatus: (pid) => pid === 42_001 ? "dead" : "alive",
        idFactories: {
          leaseToken: () => hash("restarted-team-wiki-audit-loss-lease"),
        },
      });
      await expect(restarted.apply(applyRequest)).rejects.toMatchObject({
        problem: { code: "REVISION_CONFLICT" },
      });
      expect(new TeamLocalState(localOptions(root)).getIncompleteWorkflowOperation())
        .toMatchObject({ operationId: command.operationId, phase: "intent" });
      expect(activityEvents(root)).toHaveLength(0);
    } finally {
      rmSync(container, { recursive: true, force: true });
    }
  });
});

class RepositoryContractHarness implements TeamWorkflowPortContractHarness<JsonValue> {
  readonly fixture: TeamWorkflowPortContractHarness<JsonValue>["fixture"];
  readonly container: string;
  readonly root: string;
  readonly outsideRoot: string;
  readonly scenario: TeamWorkflowContractScenario;
  readonly deadPids = new Set<number>();
  readonly pids = new Set<number>();
  readonly idCounters = new Map<string, number>();
  readonly baselineArtifactIds = new Set([
    MEMBER_ID,
    ACTIVE_WORKSTREAM_ID,
    ARCHIVED_WORKSTREAM_ID,
    PROPOSAL_ID,
    RELAY_ID,
    PLAYBOOK_ID,
    RUN_ID,
  ]);

  port!: ContractPort;
  oracle!: TeamWorkflowPortContractHarness<JsonValue>["oracle"];
  wiki!: WikiPort<unknown, JsonValue, unknown, unknown>;
  mockWiki: MockWikiPort | null = null;
  realWiki: RepositoryWikiPort | null = null;
  wikiRequest!: PortableWikiRequest;
  wikiTargetRevisions!: readonly RevisionExpectation[];
  wikiTargetId!: string;
  boundRoot: string;
  gitRoot: string;
  phaseFailure: TeamWorkflowContractPhase | null = null;
  phasePause: PauseControl | null = null;
  nextPid = 10_000;
  operationSequence = 0;
  repositoryChangeSequence = 0;
  peerRoot: string | null = null;
  peerWiki: MockWikiPort | null = null;
  peerWorkflowPort: ContractPort | null = null;
  invalidClock = false;
  closed = false;

  private constructor(scenario: TeamWorkflowContractScenario) {
    this.scenario = scenario;
    this.container = mkdtempSync(join(tmpdir(), "mex-team-workflow-contract-"));
    this.root = join(this.container, "primary");
    this.outsideRoot = join(this.container, "outside");
    mkdirSync(this.root);
    mkdirSync(this.outsideRoot);
    this.boundRoot = this.root;
    this.gitRoot = this.root;
    this.fixture = {
      filesystem: "real",
      localState: "real",
      git: "real",
      wiki: scenario === "real-wiki" ? "real-adapter" : "behavioral-mock",
    };
  }

  static async open(
    scenario: TeamWorkflowContractScenario,
  ): Promise<RepositoryContractHarness> {
    const harness = new RepositoryContractHarness(scenario);
    try {
      await harness.initialize();
      return bindHarness(harness);
    } catch (error) {
      await harness.close();
      throw error;
    }
  }

  private async initialize(): Promise<void> {
    initGit(this.root);
    write(this.root, ".gitignore", ".mex/local/\n.mex/wiki.db*\n.mex/graph.db*\n");
    write(this.root, ".mex/config.json", `${JSON.stringify({ scaffold_id: SCAFFOLD_ID }, null, 2)}\n`);
    await this.initializeWiki();
    await seedCanonicalTeamArtifacts(
      this.root,
      this.wikiRequest,
      this.wikiTargetRevisions,
    );
    const legacyV3 = this.scenario === "legacy-v3" || this.scenario === "legacy-v3-invalid";
    if (legacyV3) {
      seedLegacyV3State(this.root);
    } else if (this.scenario !== "uninitialized-local") {
      seedLocalDraft(this.root, this.wikiRequest, this.wikiTargetRevisions);
    }
    if (this.realWiki !== null) await this.realWiki.rebuildIndex();
    git(this.root, ["add", "--", "."]);
    git(this.root, ["commit", "-q", "-m", "contract baseline"]);

    if (
      this.scenario === "containment:canonical"
      || this.scenario === "containment:activity"
      || this.scenario === "containment:local"
    ) {
      write(this.root, ".contract-dirty", "keep repository authority dirty\n");
    }
    if (this.scenario === "source-bound") installSourceBound(this.root);

    this.port = this.createPort("primary");
    const repositoryState = await createRepositoryGitPort(this.root, {
      now: () => new Date(NOW),
    }).getRepoState();
    const active = await new WorkstreamRepository(this.root).get(ACTIVE_WORKSTREAM_ID);
    const archived = await new WorkstreamRepository(this.root).get(ARCHIVED_WORKSTREAM_ID);
    if (active === null || archived === null) throw new Error("workstream seed failed");
    this.oracle = {
      configuredActor: ACTOR,
      fixedNow: NOW,
      repositoryState,
      artifactsByKind: {
        member: { id: MEMBER_ID, kind: "member" },
        workstream: { id: ACTIVE_WORKSTREAM_ID, kind: "workstream" },
        proposal: { id: PROPOSAL_ID, kind: "proposal" },
        relay: { id: RELAY_ID, kind: "relay" },
        playbook: { id: PLAYBOOK_ID, kind: "playbook" },
        playbook_run: { id: RUN_ID, kind: "playbook_run" },
      },
      activeArtifact: {
        ref: active.ref,
        kind: "workstream",
        state: "active",
      },
      archivedArtifact: {
        ref: archived.ref,
        kind: "workstream",
        state: "archived",
      },
      secondKind: "relay",
      localDraft: { id: LOCAL_DRAFT_ID, kind: "inbox" },
      journalPrivacySentinels: PRIVACY_SENTINELS,
      projectRoot: this.root,
    };
  }

  private async initializeWiki(): Promise<void> {
    if (this.scenario === "real-wiki") {
      const document = realWikiDocument();
      write(this.root, ".mex/context/architecture.md", document);
      write(this.root, ".mex/events/operations.jsonl", "");
      this.realWiki = createRepositoryWikiPort(this.root, { now: () => NOW });
      this.wiki = this.realWiki as unknown as WikiPort<unknown, JsonValue, unknown, unknown>;
      const contentHash = hash(Buffer.from(document, "utf8"));
      const version = { semanticRevision: 1, contentHash };
      this.wikiTargetId = REAL_WIKI_ENTITY;
      this.wikiRequest = portableWikiUpdate(
        "wiki_contract_real_update",
        REAL_WIKI_ENTITY,
        version,
        { body: "The approved Team proposal keeps the queue recoverable." },
      );
      this.wikiTargetRevisions = [entityExpectation(REAL_WIKI_ENTITY, version)];
      return;
    }

    this.mockWiki = new MockWikiPort({ now: () => NOW });
    this.wiki = this.mockWiki as unknown as WikiPort<unknown, JsonValue, unknown, unknown>;
    for (const [path, body] of Object.entries(this.mockWiki.snapshot().files)) {
      write(this.root, path, body);
    }
    this.wikiTargetId = POPULATED_WIKI_FIXTURE.refs.spec;
    const entity = await this.mockWiki.getEntity(this.wikiTargetId);
    if (entity === null) throw new Error("mock Wiki target is missing");
    this.wikiRequest = portableWikiUpdate(
      "wiki_contract_mock_update",
      this.wikiTargetId,
      entity.version,
      {
        operations: [{
          type: "update-entry",
          entityId: this.wikiTargetId,
          summary: "Approved through the Team workflow conformance contract.",
        }],
      },
    );
    this.wikiTargetRevisions = [entityExpectation(this.wikiTargetId, entity.version)];
  }

  private createPort(driver: "primary" | "peer" | "contender" | "restart"): ContractPort {
    const root = driver === "peer" ? requiredPeerRoot(this.peerRoot) : this.boundRoot;
    const wiki = driver === "peer"
      ? requiredPeerWiki(this.peerWiki) as unknown as WikiPort<unknown, JsonValue, unknown, unknown>
      : this.wiki;
    const pid = this.nextPid++;
    this.pids.add(pid);
    return createRepositoryTeamWorkflowPortWithDependencies<JsonValue, unknown>(root, {
      scaffoldId: SCAFFOLD_ID,
      wiki,
      git: createRepositoryGitPort(root, { now: () => new Date(NOW) }),
      now: () => this.invalidClock ? new Date(Number.NaN) : new Date(NOW),
      pid,
      processStatus: (observedPid) => this.deadPids.has(observedPid) ? "dead" : "alive",
      phaseHook: (boundary) => this.onPhase(boundary),
      idFactories: {
        member: () => this.nextArtifactId("member", driver),
        workstream: () => this.nextArtifactId("ws", driver),
        proposal: () => this.nextArtifactId("proposal", driver),
        relay: () => this.nextArtifactId("relay", driver),
        playbook: () => this.nextArtifactId("playbook", driver),
        playbookRun: () => this.nextArtifactId("run", driver),
        activity: () => this.nextArtifactId("event", driver),
        localDraft: (kind) => `${kind}_contract_${driver}_${this.nextCounter(`draft:${driver}`)}`,
        leaseToken: () => hash(`lease:${driver}:${pid}`),
      },
    });
  }

  private async onPhase(boundary: TeamWorkflowContractPhase): Promise<void> {
    if (this.phaseFailure === boundary) {
      this.phaseFailure = null;
      throw new WorkflowPhaseInterruption(boundary, {
        cause: new Error(PRIVACY_SENTINELS.join(" ")),
      });
    }
    const pause = this.phasePause;
    if (pause?.boundary !== boundary) return;
    pause.reachedResolve();
    await pause.wait;
    if (this.phasePause === pause) this.phasePause = null;
  }

  private nextCounter(key: string): number {
    const value = (this.idCounters.get(key) ?? 0) + 1;
    this.idCounters.set(key, value);
    return value;
  }

  private nextArtifactId(
    prefix: "member" | "ws" | "proposal" | "relay" | "playbook" | "run" | "event",
    driver: string,
  ): string {
    const counter = this.nextCounter(`${driver}:${prefix}`);
    const driverOffset = driver === "peer" ? 150 : driver === "restart" ? 100 : 50;
    return generateArtifactId(prefix, {
      now: Date.parse(NOW) + driverOffset + counter,
      random: new Uint8Array(10).fill((driverOffset + counter) % 255),
    });
  }

  private nextOperationId(label: string, driver = "primary"): string {
    this.operationSequence += 1;
    return `contract_${driver}_${label}_${this.operationSequence}`;
  }

  async makeCommand(kind: TeamWorkflowCommandCase): Promise<TeamWorkflowCommand<JsonValue>> {
    switch (kind) {
      case "canonical-create":
        return {
          operationId: this.nextOperationId("workstream_create"),
          action: {
            kind: "workstream.create",
            workstream: {
              title: "Contract release lane",
              goal: "Prove the repository Team workflow boundary.",
              summary: "A bounded canonical create for conformance.",
              owners: [ACTOR],
              nextMilestone: "Complete the consumer contract.",
            },
          },
          expectedRevisions: [],
        };
      case "canonical-update": {
        const workstream = await requiredArtifact(
          new WorkstreamRepository(this.boundRoot).get(ACTIVE_WORKSTREAM_ID),
        );
        return {
          operationId: this.nextOperationId("workstream_update"),
          action: {
            kind: "workstream.update",
            workstreamId: ACTIVE_WORKSTREAM_ID,
            patch: { summary: "Updated through an exact optimistic preview." },
          },
          expectedRevisions: [artifactExpectation(workstream.sourcePath, workstream.revision)],
        };
      }
      case "local-draft-create":
        return {
          operationId: this.nextOperationId("draft_create"),
          action: {
            kind: "inbox.draft.save",
            draft: draftInput(this.wikiRequest, this.wikiTargetRevisions),
          },
          expectedRevisions: [],
        };
      case "mixed-publish": {
        const draft = new TeamLocalState(localOptions(this.boundRoot)).getLocalDraft(LOCAL_DRAFT_ID);
        if (draft === null) throw new Error("baseline local draft is missing");
        return {
          operationId: this.nextOperationId("inbox_publish"),
          action: { kind: "inbox.publish", draftId: LOCAL_DRAFT_ID },
          expectedRevisions: [localExpectation("inbox-draft", LOCAL_DRAFT_ID, draft.revision)],
        };
      }
      case "wiki-approve": {
        const proposal = await requiredArtifact(
          new InboxProposalRepository<JsonValue>(this.boundRoot).get(PROPOSAL_ID),
        );
        return {
          operationId: this.nextOperationId("inbox_approve"),
          action: { kind: "inbox.approve", proposalId: PROPOSAL_ID },
          expectedRevisions: [artifactExpectation(proposal.sourcePath, proposal.revision)],
        };
      }
    }
  }

  async makeInvalidCommand(kind: InvalidTeamWorkflowCommandCase): Promise<unknown> {
    if (kind === "missing-target-expectation" || kind === "unrelated-target-expectation") {
      const command = await this.makeCommand("canonical-update");
      if (kind === "missing-target-expectation") return { ...command, expectedRevisions: [] };
      const archived = await requiredArtifact(
        new WorkstreamRepository(this.boundRoot).get(ARCHIVED_WORKSTREAM_ID),
      );
      return {
        ...command,
        expectedRevisions: [artifactExpectation(archived.sourcePath, archived.revision)],
      };
    }
    const command = await this.makeCommand("canonical-create");
    if (kind === "forged-actor") return { ...command, actor: { kind: "unknown" } };
    if (kind === "forged-time") return { ...command, occurredAt: LATER };
    return { ...command, repoState: this.oracle.repositoryState };
  }

  async alterPreparedCommand(
    command: PreparedTeamWorkflowCommand<JsonValue>,
    alteration: PreparedCommandAlteration,
  ): Promise<PreparedTeamWorkflowCommand<JsonValue>> {
    const changed = structuredClone(command) as PreparedTeamWorkflowCommand<JsonValue>;
    if (alteration === "intent") {
      if (changed.action.kind !== "workstream.create") throw new Error("expected create command");
      changed.action.workstream.title = "Altered command reuse";
    } else if (alteration === "actor") {
      changed.authority.actor = { kind: "unknown" };
    } else if (alteration === "time") {
      changed.authority.occurredAt = LATER;
    } else {
      changed.authority.repoState = {
        ...changed.authority.repoState,
        branch: "altered-authority",
      };
    }
    return changed;
  }

  async makeConcurrentTargetEdit(): Promise<void> {
    const target = join(this.boundRoot, ".mex/workstreams", `${ACTIVE_WORKSTREAM_ID}.md`);
    writeFileSync(target, `${readFileSync(target, "utf8")}\nConcurrent target edit.\n`, "utf8");
  }

  async makeConcurrentDraftEdit(): Promise<void> {
    const state = new TeamLocalState(localOptions(this.boundRoot));
    const current = state.getLocalDraft<InboxDraftInput<JsonValue>>(LOCAL_DRAFT_ID);
    if (current === null) throw new Error("baseline draft is missing");
    state.saveLocalDraft({
      id: current.id,
      kind: "inbox",
      payload: { ...current.payload, rationale: "Concurrent checkout-local edit." },
      expectedRevision: current.revision,
      updatedAt: LATER,
    });
  }

  async makeWikiTargetEdit(): Promise<void> {
    if (this.mockWiki === null) throw new Error("Wiki target edits use the behavioral fixture");
    this.mockWiki.simulateManualBodyEdit(
      this.wikiTargetId,
      "A concurrent manual Wiki edit invalidated the reviewed target.",
    );
  }

  async makeRepositoryStateChange(): Promise<void> {
    this.repositoryChangeSequence += 1;
    git(this.gitRoot, [
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      `authority drift ${this.repositoryChangeSequence}`,
    ]);
  }

  async tamperPublishedCanonicalEffect(): Promise<void> {
    const directory = join(this.boundRoot, ".mex/inbox");
    const candidate = readdirSync(directory)
      .filter((name) => name.endsWith(".md"))
      .map((name) => name.slice(0, -3))
      .find((id) => id !== PROPOSAL_ID);
    if (candidate === undefined) throw new Error("published proposal was not found");
    const target = join(directory, `${candidate}.md`);
    writeFileSync(target, `${readFileSync(target, "utf8")}\nTampered after publication.\n`, "utf8");
  }

  async armPhaseFailure(phase: TeamWorkflowContractPhase): Promise<void> {
    this.phaseFailure = phase;
  }

  async pauseAtPhase(phase: TeamWorkflowContractPhase): Promise<TeamWorkflowPhasePause> {
    if (this.phasePause !== null) throw new Error("a phase pause is already armed");
    let reachedResolve!: () => void;
    let releaseResolve!: () => void;
    const reached = new Promise<void>((resolve) => { reachedResolve = resolve; });
    const wait = new Promise<void>((resolve) => { releaseResolve = resolve; });
    let released = false;
    this.phasePause = { boundary: phase, reachedResolve, wait, releaseResolve };
    return {
      reached,
      release: () => {
        if (released) return;
        released = true;
        releaseResolve();
      },
    };
  }

  async restart(): Promise<TeamWorkflowPort<JsonValue>> {
    for (const pid of this.pids) this.deadPids.add(pid);
    return this.createPort("restart");
  }

  async contendingPort(): Promise<TeamWorkflowPort<JsonValue>> {
    return this.createPort("contender");
  }

  async swapProjectRoot(): Promise<void> {
    const moved = join(this.container, "bound-after-swap");
    renameSync(this.root, moved);
    mkdirSync(this.root);
    write(this.root, "replacement.txt", "replacement checkout\n");
    this.boundRoot = moved;
    this.gitRoot = moved;
  }

  async installEscapingAncestor(target: "canonical" | "activity" | "local"): Promise<void> {
    const relativeTarget = target === "canonical"
      ? ".mex/workstreams"
      : target === "activity"
        ? ".mex/events/activity"
        : ".mex/local";
    const path = join(this.boundRoot, ...relativeTarget.split("/"));
    const preserved = join(this.container, `preserved-${target}`);
    if (existsSync(path)) renameSync(path, preserved);
    mkdirSync(dirname(path), { recursive: true });
    const outside = join(this.outsideRoot, target);
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, path);
  }

  async peerPort(): Promise<TeamWorkflowPort<JsonValue>> {
    if (this.peerWorkflowPort !== null) return this.peerWorkflowPort;
    this.peerRoot = join(this.container, "peer");
    git(this.container, ["clone", "--config", "core.autocrlf=false", "-q", "--no-hardlinks", this.gitRoot, this.peerRoot]);
    git(this.peerRoot, ["config", "user.name", "Ada Lovelace"]);
    git(this.peerRoot, ["config", "user.email", "ada@example.test"]);
    this.peerWiki = new MockWikiPort({ now: () => NOW });
    this.peerWorkflowPort = this.createPort("peer");
    return this.peerWorkflowPort;
  }

  async makePeerCommand(kind: TeamWorkflowCommandCase): Promise<TeamWorkflowCommand<JsonValue>> {
    if (kind !== "canonical-create") {
      throw new Error(`peer command ${kind} is outside this conformance scenario`);
    }
    return {
      operationId: this.nextOperationId("workstream_create", "peer"),
      action: {
        kind: "workstream.create",
        workstream: {
          title: "Peer clone release lane",
          goal: "Converge canonical Team memory across clones.",
          summary: "A distinct portable peer artifact.",
          owners: [ACTOR],
          nextMilestone: "Synchronize the clones.",
        },
      },
      expectedRevisions: [],
    };
  }

  async synchronizeClones(): Promise<void> {
    const peer = requiredPeerRoot(this.peerRoot);
    copyPortableCanonical(this.boundRoot, peer);
    copyPortableCanonical(peer, this.boundRoot);
  }

  async peerSnapshot(): Promise<TeamWorkflowPortContractSnapshot> {
    return this.snapshotAt(
      requiredPeerRoot(this.peerRoot),
      requiredPeerRoot(this.peerRoot),
      requiredPeerWiki(this.peerWiki),
    );
  }

  async inspectPeerJournal(): Promise<TeamWorkflowJournalInspection> {
    return inspectJournalAt(requiredPeerRoot(this.peerRoot), this.oracle);
  }

  async snapshot(): Promise<TeamWorkflowPortContractSnapshot> {
    return this.snapshotAt(this.boundRoot, this.gitRoot, this.mockWiki);
  }

  private async snapshotAt(
    root: string,
    gitRoot: string,
    mockWiki: MockWikiPort | null,
  ): Promise<TeamWorkflowPortContractSnapshot> {
    const canonicalFilesystem = canonicalDigest(root);
    const mockSnapshot = mockWiki?.snapshot() ?? null;
    const wikiCanonicalDigest = mockSnapshot?.canonicalDigest ?? wikiFilesDigest(root);
    const wikiIndexDigest = mockSnapshot?.indexDigest ?? databaseDigest(join(root, ".mex/wiki.db"))!;
    const localStateDigest = databaseDigest(join(root, ".mex/local/team.db"), true);
    return {
      boundRootDigest: hash(`${canonicalFilesystem}:${wikiCanonicalDigest}`),
      activeRootDigest: hash(`${canonicalDigest(this.root)}:${wikiCanonicalDigest}`),
      canonicalDigest: hash(`${canonicalFilesystem}:${wikiCanonicalDigest}`),
      localStateDigest,
      gitHead: gitText(gitRoot, ["rev-parse", "HEAD"]).trim() || null,
      gitIndexDigest: hash(gitBytes(gitRoot, ["ls-files", "--stage", "-z"])),
      gitStatusDigest: hash(gitBytes(gitRoot, ["status", "--porcelain=v1", "-z"])),
      gitTrackedPaths: splitNul(gitBytes(gitRoot, ["ls-files", "-z"])),
      wikiCanonicalDigest,
      wikiIndexDigest,
      outsideDigest: treeDigest(this.outsideRoot),
      artifactIds: artifactIds(root),
      localDraftIds: localDraftIds(root),
      activities: activityEvents(root),
      modelInvocations: 0,
      outboundRequests: 0,
    };
  }

  async inspectJournal(): Promise<TeamWorkflowJournalInspection> {
    return inspectJournalAt(this.boundRoot, this.oracle);
  }

  async inspectLocalSchema(): Promise<TeamWorkflowLocalSchemaInspection> {
    return inspectLocalSchemaAt(this.boundRoot);
  }

  async armLegacyMigrationFailure(): Promise<void> {
    if (this.scenario !== "legacy-v3-invalid") {
      throw new Error("legacy migration failure is outside this conformance scenario");
    }
    this.invalidClock = true;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.phasePause?.releaseResolve();
    rmSync(this.container, { recursive: true, force: true });
  }
}

function bindHarness(harness: RepositoryContractHarness): RepositoryContractHarness {
  return new Proxy(harness, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

interface PauseControl {
  boundary: TeamWorkflowContractPhase;
  reachedResolve(): void;
  wait: Promise<void>;
  releaseResolve(): void;
}

async function seedCanonicalTeamArtifacts(
  root: string,
  wikiRequest: PortableWikiRequest,
  wikiTargetRevisions: readonly RevisionExpectation[],
): Promise<void> {
  await new MemberRepository(root).create({
    id: MEMBER_ID,
    displayName: "Ada Lovelace",
    gitAliases: [{ name: "Ada Lovelace", email: "ada@example.test" }],
    active: true,
  });

  const workstreams = new WorkstreamRepository(root);
  const active = await applyCreate(workstreams, workstreamInput(ACTIVE_WORKSTREAM_ID, "Active release lane"));
  await applyUpdate(workstreams, ACTIVE_WORKSTREAM_ID, {
    ...workstreamReplacement(active),
    state: "active",
    currentState: "In progress",
    updatedAt: LATER,
  }, active.revision);
  const archived = await applyCreate(
    workstreams,
    workstreamInput(ARCHIVED_WORKSTREAM_ID, "Archived release lane"),
  );
  await applyUpdate(workstreams, ARCHIVED_WORKSTREAM_ID, {
    ...workstreamReplacement(archived),
    state: "archived",
    updatedAt: LATER,
  }, archived.revision);

  const proposals = new InboxProposalRepository<JsonValue>(root);
  await applyCreate(proposals, {
    id: PROPOSAL_ID,
    author: ACTOR,
    rationale: "Apply one deterministic Wiki update.",
    evidence: [],
    request: wikiRequest,
    targetRevisions: wikiTargetRevisions,
  });

  await applyCreate(new RelayRepository(root), {
    id: RELAY_ID,
    sender: ACTOR,
    recipients: [ACTOR],
    workstream: { id: ACTIVE_WORKSTREAM_ID, kind: "workstream" },
    summary: "Conformance handoff",
    completed: ["Fixture seeded"],
    inProgress: [],
    decisions: [],
    blockers: [],
    unresolvedQuestions: [],
    changedFiles: [],
    code: [],
    evidence: [],
    nextActions: ["Run the contract"],
  });

  await applyCreate(new PlaybookRepository(root), {
    id: PLAYBOOK_ID,
    title: "Release verification",
    purpose: "Verify the repository workflow boundary.",
    trigger: "Checkpoint review",
    owners: [ACTOR],
    prerequisites: [],
    steps: [{
      id: "verify",
      title: "Verify",
      instructions: "Run the bounded conformance suite.",
      requiredChecks: ["typecheck"],
      expectedOutputs: ["green contract"],
    }],
    related: [],
  });

  await applyCreate(new PlaybookRunRepository(root), {
    id: RUN_ID,
    playbook: { id: PLAYBOOK_ID, kind: "playbook" },
    workstream: { id: ACTIVE_WORKSTREAM_ID, kind: "workstream" },
    steps: [{ stepId: "verify" }],
    startedBy: ACTOR,
    startedAt: NOW,
  });
}

function seedLocalDraft(
  root: string,
  wikiRequest: PortableWikiRequest,
  wikiTargetRevisions: readonly RevisionExpectation[],
): void {
  new TeamLocalState(localOptions(root)).saveLocalDraft({
    id: LOCAL_DRAFT_ID,
    kind: "inbox",
    payload: draftInput(wikiRequest, wikiTargetRevisions),
    expectedRevision: null,
    updatedAt: NOW,
  });
}

function seedLegacyV3State(root: string): void {
  new TeamLocalState(localOptions(root)).configureMember({
    memberId: MEMBER_ID,
    expectedRevision: null,
    updatedAt: NOW,
  });
  const database = join(root, ".mex/local/team.db");
  const db = new DatabaseSync(database);
  try {
    db.exec(`
      BEGIN IMMEDIATE;
      DROP TABLE inbox_drafts;
      DROP TABLE relay_drafts;
      DROP TABLE team_workflow_lease;
      DROP TABLE team_workflow_operations;
      UPDATE local_state_schema
      SET version = 3, applied_at = '${NOW}'
      WHERE singleton = 1;
      COMMIT;
      VACUUM;
    `);
  } finally {
    db.close();
  }
}

function localOptions(root: string) {
  return {
    projectRoot: root,
    scaffoldId: SCAFFOLD_ID,
    now: () => NOW,
    processStatus: () => "alive" as const,
  };
}

function draftInput(
  request: PortableWikiRequest,
  targetRevisions: readonly RevisionExpectation[],
): InboxDraftInput<JsonValue> {
  return {
    request: structuredClone(request),
    rationale: "Publish a portable declarative Wiki request.",
    evidence: [{ kind: "manual", note: "Consumer contract fixture" }],
    targetRevisions: structuredClone(targetRevisions),
  };
}

function portableWikiUpdate(
  opId: string,
  entityId: string,
  version: { semanticRevision: number; contentHash: Revision },
  payload: JsonValue,
): PortableWikiRequest {
  const expectedRevisions: readonly WikiRevisionExpectation[] = [{
    target: { kind: "entity", id: entityId },
    version,
  }];
  return {
    operation: {
      opId,
      type: "update-entry",
      entityId,
      baseRevision: version.semanticRevision,
      baseContentHash: version.contentHash,
      reason: "Exercise Inbox-governed Wiki publication.",
      payload,
    },
    expectedRevisions,
  };
}

function entityExpectation(
  id: string,
  version: { semanticRevision: number; contentHash: Revision },
): RevisionExpectation {
  return {
    target: { kind: "entity", id },
    revision: version.contentHash,
    semanticRevision: version.semanticRevision,
  };
}

function artifactExpectation(path: string, revision: Revision): RevisionExpectation {
  return { target: { kind: "artifact", path }, revision };
}

function localExpectation(
  namespace: "inbox-draft" | "relay-draft",
  id: string,
  revision: Revision,
): RevisionExpectation {
  return { target: { kind: "local", namespace, id }, revision };
}

function workstreamInput(id: string, title: string) {
  return {
    id,
    title,
    goal: "Ship a safe Team workflow foundation.",
    summary: "Consumer-owned conformance fixture.",
    owners: [ACTOR],
    contributors: [],
    paths: [],
    code: [],
    topics: [],
    components: [],
    related: [],
    blockers: [],
    currentState: "Planned",
    nextMilestone: "Verify",
    createdBy: ACTOR,
    createdAt: NOW,
    updatedBy: ACTOR,
    updatedAt: NOW,
  } as const;
}

function workstreamReplacement(workstream: Awaited<ReturnType<WorkstreamRepository["get"]>> & {}) {
  if (workstream === null) throw new Error("workstream is missing");
  return {
    title: workstream.title,
    goal: workstream.goal,
    summary: workstream.summary,
    state: workstream.state,
    owners: workstream.owners,
    contributors: workstream.contributors,
    paths: workstream.paths,
    code: workstream.code,
    topics: workstream.topics,
    components: workstream.components,
    related: workstream.related,
    blockers: workstream.blockers,
    currentState: workstream.currentState,
    nextMilestone: workstream.nextMilestone,
    createdBy: workstream.createdBy,
    createdAt: workstream.createdAt,
    updatedBy: workstream.updatedBy,
    updatedAt: workstream.updatedAt,
  };
}

async function applyCreate<
  TRepository extends {
    previewCreate(input: any): Promise<any>;
    apply(plan: any, revision: Revision): Promise<{ artifact: any }>;
  },
>(repository: TRepository, input: Parameters<TRepository["previewCreate"]>[0]) {
  const preview = await repository.previewCreate(input);
  return (await repository.apply(preview, preview.previewRevision)).artifact;
}

async function applyUpdate<
  TRepository extends {
    previewUpdate(id: string, input: any, revision: Revision): Promise<any>;
    apply(plan: any, revision: Revision): Promise<{ artifact: any }>;
  },
>(
  repository: TRepository,
  id: string,
  input: Parameters<TRepository["previewUpdate"]>[1],
  revision: Revision,
) {
  const preview = await repository.previewUpdate(id, input, revision);
  return (await repository.apply(preview, preview.previewRevision)).artifact;
}

function inspectJournalAt(
  root: string,
  oracle: TeamWorkflowPortContractHarness<JsonValue>["oracle"],
): TeamWorkflowJournalInspection {
  const database = join(root, ".mex/local/team.db");
  const durablePaths = [database, `${database}-wal`, `${database}-shm`, `${database}-journal`]
    .filter((path) => existsSync(path));
  const durableStorageBytes = durablePaths.reduce((total, path) => total + statSync(path).size, 0);
  const forbidden = new Set<string>();
  for (const path of durablePaths) {
    const bytes = readFileSync(path);
    for (const sentinel of oracle.journalPrivacySentinels) {
      if (bytes.includes(Buffer.from(sentinel, "utf8"))) forbidden.add(sentinel);
    }
  }
  if (!existsSync(database)) {
    return {
      rowCount: 0,
      incompleteCount: 0,
      operationIds: [],
      rows: [],
      durableStorageBytes,
      durableStorageForbiddenMatches: [...forbidden].sort(compare),
    };
  }
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    const selected = db.prepare(`
      SELECT scaffold_id, operation_id, command_revision, preview_revision, phase,
        effects_json, created_at, updated_at, revision
      FROM team_workflow_operations
      WHERE scaffold_id = ?
      ORDER BY operation_id ASC
    `).all(SCAFFOLD_ID) as unknown as JournalRow[];
    const rows = selected.map((row) => {
      const effects = JSON.parse(row.effects_json) as readonly unknown[];
      return {
        operationId: row.operation_id,
        phase: row.phase,
        effectCount: effects.length,
        effectJsonBytes: Buffer.byteLength(row.effects_json, "utf8"),
        serializedEffects: row.effects_json,
        serializedRow: JSON.stringify({
          scaffoldId: row.scaffold_id,
          operationId: row.operation_id,
          commandRevision: row.command_revision,
          previewRevision: row.preview_revision,
          phase: row.phase,
          effects,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          revision: row.revision,
        }),
      };
    });
    return {
      rowCount: rows.length,
      incompleteCount: rows.filter((row) => row.phase !== "complete").length,
      operationIds: rows.map((row) => row.operationId),
      rows,
      durableStorageBytes,
      durableStorageForbiddenMatches: [...forbidden].sort(compare),
    };
  } finally {
    db.close();
  }
}

function inspectLocalSchemaAt(root: string): TeamWorkflowLocalSchemaInspection {
  const database = join(root, ".mex/local/team.db");
  if (!existsSync(database)) return { version: null, objects: [] };
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    const row = db.prepare(`
      SELECT version
      FROM local_state_schema
      WHERE singleton = 1
    `).get() as { version?: unknown } | undefined;
    const version = typeof row?.version === "number" && Number.isSafeInteger(row.version)
      ? row.version
      : null;
    const objects = (db.prepare(`
      SELECT type, name, sql
      FROM sqlite_master
      WHERE name NOT LIKE 'sqlite_%'
      ORDER BY type ASC, name ASC
    `).all() as Array<{ type: unknown; name: unknown; sql: unknown }>).map((item) => (
      JSON.stringify({ type: item.type, name: item.name, sql: item.sql })
    ));
    return { version, objects };
  } finally {
    db.close();
  }
}

interface JournalRow {
  scaffold_id: string;
  operation_id: string;
  command_revision: string;
  preview_revision: string;
  phase: "intent" | "canonical_published" | "local_finalized" | "complete";
  effects_json: string;
  created_at: string;
  updated_at: string;
  revision: string;
}

function artifactIds(root: string): readonly string[] {
  const directories = [
    ".mex/team/members",
    ".mex/workstreams",
    ".mex/inbox",
    ".mex/relays",
    ".mex/playbooks",
    ".mex/playbooks/runs",
  ];
  const ids: string[] = [];
  for (const relativePath of directories) {
    const directory = join(root, ...relativePath.split("/"));
    if (!isRealDirectory(directory)) continue;
    for (const name of readdirSync(directory).sort(compare)) {
      const path = join(directory, name);
      if (!name.endsWith(".md") || !lstatSync(path).isFile()) continue;
      ids.push(name.slice(0, -3));
    }
  }
  return [...new Set(ids)].sort(compare);
}

function localDraftIds(root: string): readonly string[] {
  try {
    return new TeamLocalState(localOptions(root)).listLocalDrafts({ limit: 100 })
      .items.map((draft) => draft.id)
      .sort(compare);
  } catch {
    return [];
  }
}

function activityEvents(root: string) {
  const activityRoot = join(root, ".mex/events/activity");
  if (!isRealDirectory(activityRoot)) return [];
  const events = [];
  for (const path of regularFiles(activityRoot)) {
    if (!path.endsWith(".md")) continue;
    const relativePath = path.slice(root.length + 1).split("\\").join("/") as RepoRelativePath;
    try {
      events.push(parseActivityArtifact(readFileSync(path), relativePath));
    } catch {
      // A containment/tamper fixture remains snapshot-able without trusting it.
    }
  }
  return events.sort((left, right) => compare(left.id, right.id));
}

function canonicalDigest(root: string): Revision {
  return treeDigest(root, (path) => {
    if (path === ".git" || path.startsWith(".git/")) return false;
    if (path === ".mex/local" || path.startsWith(".mex/local/")) return false;
    if (/^\.mex\/(?:wiki|graph)\.db(?:-|$)/u.test(path)) return false;
    if (path === ".contract-dirty") return false;
    return true;
  });
}

function wikiFilesDigest(root: string): Revision {
  return treeDigest(root, (path) => (
    path === ".mex"
    || path === ".mex/context"
    || path.startsWith(".mex/context/")
    || path === ".mex/specs"
    || path.startsWith(".mex/specs/")
    || path === ".mex/topics"
    || path.startsWith(".mex/topics/")
    || path === ".mex/events"
    || path === ".mex/events/operations.jsonl"
  ));
}

function databaseDigest(path: string, absentIsNull = false): Revision | null {
  if (!existsSync(path) || !lstatSync(path).isFile()) return absentIsNull ? null : hash("");
  const digest = createHash("sha256");
  for (const candidate of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) {
    if (!existsSync(candidate) || !lstatSync(candidate).isFile()) continue;
    digest.update(basename(candidate));
    digest.update(readFileSync(candidate));
  }
  return digest.digest("hex");
}

function treeDigest(
  root: string,
  include: (path: string) => boolean = () => true,
): Revision {
  const digest = createHash("sha256");
  if (!existsSync(root)) return digest.digest("hex");
  const visit = (absolute: string, relativePath: string): void => {
    const stat = lstatSync(absolute);
    if (relativePath !== "" && !include(relativePath)) return;
    if (stat.isSymbolicLink()) {
      digest.update(`L\0${relativePath}\0${readlinkSync(absolute)}\0`);
      return;
    }
    if (stat.isDirectory()) {
      digest.update(`D\0${relativePath}\0`);
      for (const name of readdirSync(absolute).sort(compare)) {
        visit(join(absolute, name), relativePath === "" ? name : `${relativePath}/${name}`);
      }
      return;
    }
    if (stat.isFile()) {
      digest.update(`F\0${relativePath}\0${stat.size}\0`);
      digest.update(readFileSync(absolute));
    }
  };
  visit(root, "");
  return digest.digest("hex");
}

function regularFiles(root: string): readonly string[] {
  const files: string[] = [];
  const visit = (path: string): void => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return;
    if (stat.isFile()) {
      files.push(path);
      return;
    }
    if (!stat.isDirectory()) return;
    for (const name of readdirSync(path).sort(compare)) visit(join(path, name));
  };
  visit(root);
  return files;
}

function copyPortableCanonical(source: string, target: string): void {
  for (const relativeRoot of [
    ".mex/team",
    ".mex/workstreams",
    ".mex/inbox",
    ".mex/relays",
    ".mex/playbooks",
    ".mex/events/activity",
  ]) {
    const sourceRoot = join(source, ...relativeRoot.split("/"));
    if (!isRealDirectory(sourceRoot)) continue;
    for (const path of regularFiles(sourceRoot)) {
      const relative = path.slice(source.length + 1);
      const destination = join(target, relative);
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(path, destination);
    }
  }
}

function installSourceBound(root: string): void {
  const directory = join(root, ".mex/workstreams");
  mkdirSync(directory, { recursive: true });
  let entries = readdirSync(directory).length;
  while (entries <= WORKFLOW_REPOSITORY_LIMITS.maxDirectoryEntries) {
    writeFileSync(join(directory, `bound-${String(entries).padStart(4, "0")}`), "", "utf8");
    entries += 1;
  }
}

function realWikiDocument(): string {
  return `<!-- mex:entity
id: ${REAL_WIKI_ENTITY}
type: architecture
status: promoted
revision: 1
sources:
  - type: manual
    note: Consumer contract fixture
-->
## Durable queue architecture

One service owns the durable queue.
`;
}

function initGit(root: string): void {
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.name", "Ada Lovelace"]);
  git(root, ["config", "user.email", "ada@example.test"]);
}

function git(cwd: string, args: readonly string[]): string {
  return gitText(cwd, args);
}

function gitText(cwd: string, args: readonly string[]): string {
  return gitBytes(cwd, args).toString("utf8");
}

function gitBytes(cwd: string, args: readonly string[]): Buffer {
  return execFileSync("git", [...args], {
    cwd,
    encoding: "buffer",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function splitNul(bytes: Buffer): readonly string[] {
  return bytes.toString("utf8").split("\0").filter(Boolean).sort(compare);
}

function write(root: string, relativePath: string, body: string): void {
  const path = join(root, ...relativePath.split("/"));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, "utf8");
}

function isRealDirectory(path: string): boolean {
  return existsSync(path) && lstatSync(path).isDirectory() && !lstatSync(path).isSymbolicLink();
}

function hash(value: string | Buffer): Revision {
  return createHash("sha256").update(value).digest("hex");
}

function artifactId(
  prefix: "member" | "ws" | "proposal" | "relay" | "playbook" | "run",
  entropy: number,
): string {
  return generateArtifactId(prefix, {
    now: Date.parse(NOW) + entropy,
    random: new Uint8Array(10).fill(entropy),
  });
}

async function requiredArtifact<T>(promise: Promise<T | null>): Promise<T> {
  const artifact = await promise;
  if (artifact === null) throw new Error("required fixture artifact is missing");
  return artifact;
}

function requiredPeerRoot(value: string | null): string {
  if (value === null) throw new Error("peer clone is not initialized");
  return value;
}

function requiredPeerWiki(value: MockWikiPort | null): MockWikiPort {
  if (value === null) throw new Error("peer Wiki is not initialized");
  return value;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
