import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import {
  TEAM_INBOX_KNOWLEDGE_KINDS,
  type TeamInboxSpecAuthoringPort as KnowledgeInboxPort,
  type TeamInboxSpecDraftInput as KnowledgeDraftInput,
  type TeamInboxSpecProposalDetail as KnowledgeProposal,
  type TeamInboxSpecPreviewEnvelope as KnowledgeEnvelope,
} from "../src/team/contracts/workflow.js";
import {
  defineTeamInboxDirectWikiSpecBypassContract,
  defineTeamInboxSpecAuthoringContract,
  TEAM_INBOX_SPEC_KINDS,
  type TeamInboxSpecAuthoringContractPort,
  type TeamInboxSpecChange,
  type TeamInboxSpecCommand,
  type TeamInboxSpecContainmentTarget,
  type TeamInboxSpecContractFactory,
  type TeamInboxSpecContractHarness,
  type TeamInboxSpecDraftDetail,
  type TeamInboxSpecDraftInput,
  type TeamInboxSpecDriftCase,
  type TeamInboxSpecInvalidCase,
  type TeamInboxSpecKind,
  type TeamInboxSpecPreviewEnvelope,
  type TeamInboxSpecProjection,
  type TeamInboxSpecProposalDetail,
  type TeamInboxSpecRecoveryPhase,
  type TeamInboxSpecScenario,
  type TeamInboxSpecSnapshot,
  type TeamInboxSpecTwoCloneHarness,
  type TeamInboxValidCreateCase,
  type TeamInboxDirectBypassCase,
  type TeamInboxDirectBypassSurface,
  type TeamInboxDirectWikiSpecContractFactory,
} from "./contracts/team-inbox-spec-authoring.contract.js";
import { parseActivityArtifact } from "../src/team/artifacts/codecs.js";
import { generateArtifactId } from "../src/team/artifacts/ulid.js";
import { WORKFLOW_REPOSITORY_LIMITS } from "../src/team/artifacts/workflow-repositories.js";
import type {
  ActorRef,
  EntityRef,
  JsonValue,
  RepoRelativePath,
  Revision,
  RevisionExpectation,
} from "../src/team/contracts/shared.js";
import type { WikiEntity } from "../src/team/contracts/wiki.js";
import { createRepositoryGitPort } from "../src/team/git/git-port.js";
import { MemberRepository } from "../src/team/identity/member-repository.js";
import { TeamLocalState } from "../src/team/local-state/index.js";
import { TEAM_RECEIPT_SIGNER_RELATIVE_PATH } from "../src/team/local-state/receipt-signer.js";
import {
  createRepositoryTeamWorkflowPortWithDependencies,
  type RepositoryTeamWorkflowPort,
  type TeamWorkflowPhaseBoundary,
  WorkflowPhaseInterruption,
} from "../src/team/workflow/repository-team-workflow-port.js";
import {
  createRepositoryWikiPort,
  type RepositoryWikiPort,
} from "../src/wiki/application-adapter.js";
import { assertNoDirectWikiSpecMutation } from "../src/wiki/cli/spec-authoring-boundary.js";

// Real Git/Wiki workflows showed intermittent Windows runner stalls in different
// cases. This file-only hang guard leaves the shared contract and other test
// files unchanged; timing budgets belong to the pinned release benchmark.
if (process.platform === "win32") vi.setConfig({ testTimeout: 30_000 });

const NOW = "2026-08-28T04:05:06.000Z";
const SCAFFOLD_ID = "team_inbox_spec_authoring_v1";
const MEMBER_ID = artifactId("member", 1);
const SPEC_ID = "mx_01J00000000000000000000011";
const REQUIREMENT_ID = "mx_01J00000000000000000000012";
const CONSTRAINT_ID = "mx_01J00000000000000000000013";
const ACCEPTANCE_ID = "mx_01J00000000000000000000014";
const TOPIC_ID = "mx_01J00000000000000000000015";
const NON_SPEC_ID = "mx_01J00000000000000000000016";
const ACTOR: ActorRef = {
  kind: "member",
  memberId: MEMBER_ID,
  displayName: "Ada Lovelace",
};
const PRIVACY_SENTINELS = [
  "contract-private-spec-source-body",
  "contract-private-inbox-prompt-transcript",
] as const;
const SPEC_IDS: Readonly<Record<TeamInboxSpecKind, string>> = {
  spec: SPEC_ID,
  requirement: REQUIREMENT_ID,
  constraint: CONSTRAINT_ID,
  acceptance_criterion: ACCEPTANCE_ID,
};

type WorkflowPort = RepositoryTeamWorkflowPort<JsonValue, unknown>;

interface HarnessOptions {
  container?: string;
  root?: string;
  outsideRoot?: string;
  ownsContainer?: boolean;
  seedOffset?: number;
}

const factory: TeamInboxSpecContractFactory = {
  open: (scenario) => RepositoryInboxSpecHarness.open(scenario),
  openTwoClone: () => RepositoryInboxSpecTwoCloneHarness.open(),
};

defineTeamInboxSpecAuthoringContract("repository adapter", factory);

const directWikiFactory: TeamInboxDirectWikiSpecContractFactory = {
  open: (scenario) => RepositoryInboxSpecHarness.open(scenario),
};

defineTeamInboxDirectWikiSpecBypassContract("repository CLI boundary", directWikiFactory);

class RepositoryInboxSpecHarness implements TeamInboxSpecContractHarness {
  readonly fixture = {
    filesystem: "real",
    localState: "real",
    git: "real",
    wiki: "real-adapter",
  } as const;
  readonly container: string;
  readonly root: string;
  readonly outsideRoot: string;
  readonly scenario: TeamInboxSpecScenario;
  readonly #ownsContainer: boolean;
  readonly #seedOffset: number;
  readonly #pids = new Set<number>();
  readonly #deadPids = new Set<number>();
  readonly #idCounters = new Map<string, number>();
  #clock = NOW;
  #nextPid = 50_000;
  #closed = false;
  #boundRoot: string;
  #gitRoot: string;
  #crashPhase: TeamInboxSpecRecoveryPhase | null = null;
  #dependencyDriftPath: string | null = null;
  #dependencyRestore: {
    path: string;
    relativePath: RepoRelativePath;
    body: Buffer;
  } | null = null;
  #proposalDriftPath: string | null = null;
  #workflow!: WorkflowPort;
  #wiki!: RepositoryWikiPort;
  port!: TeamInboxSpecAuthoringContractPort;
  oracle!: TeamInboxSpecContractHarness["oracle"];

  private constructor(
    scenario: TeamInboxSpecScenario,
    options: HarnessOptions = {},
  ) {
    this.scenario = scenario;
    this.container = options.container
      ?? mkdtempSync(join(tmpdir(), "mex-team-inbox-spec-contract-"));
    this.root = options.root ?? join(this.container, "repository");
    this.outsideRoot = options.outsideRoot ?? join(this.container, "outside");
    this.#ownsContainer = options.ownsContainer ?? true;
    this.#seedOffset = options.seedOffset ?? 0;
    this.#boundRoot = this.root;
    this.#gitRoot = this.root;
  }

  static async open(
    scenario: TeamInboxSpecScenario,
    options: HarnessOptions = {},
  ): Promise<RepositoryInboxSpecHarness> {
    const harness = new RepositoryInboxSpecHarness(scenario, options);
    try {
      await harness.#initialize();
      return bindHarness(harness);
    } catch (error) {
      await harness.close();
      throw error;
    }
  }

  async #initialize(): Promise<void> {
    const cloned = existsSync(join(this.root, ".git"));
    mkdirSync(this.root, { recursive: true });
    mkdirSync(this.outsideRoot, { recursive: true });
    if (!cloned) {
      initGit(this.root);
      write(this.root, ".gitignore", ".mex/local/\n.mex/wiki.db*\n.mex/graph.db*\n");
      write(
        this.root,
        ".mex/config.json",
        `${JSON.stringify({ scaffold_id: SCAFFOLD_ID }, null, 2)}\n`,
      );
      await new MemberRepository(this.root).create({
        id: MEMBER_ID,
        displayName: "Ada Lovelace",
        gitAliases: [{ name: "Ada Lovelace", email: "ada@example.test" }],
        active: true,
      });
      seedWikiCorpus(this.root);
      git(this.root, ["add", "--", "."]);
      git(this.root, ["commit", "-q", "-m", "Inbox Spec contract baseline"]);
    }

    this.#openAdapters();
    await this.#wiki.rebuildIndex();
    this.#openWorkflow("primary");

    let populatedDraft: TeamInboxSpecDraftDetail | null = null;
    let populatedProposal: TeamInboxSpecProposalDetail | null = null;
    if (["populated", "wiki-missing", "wiki-stale"].includes(this.scenario)) {
      ({ populatedDraft, populatedProposal } = await this.#seedPopulatedInbox());
      git(this.root, ["add", "--", ".mex/inbox", ".mex/events/activity"]);
      git(this.root, ["commit", "-q", "-m", "Populated Inbox contract fixture"]);
      this.#openAdapters();
      this.#openWorkflow("primary");
    }

    if (this.scenario === "source-bound") installProposalSourceBound(this.root);
    if (this.scenario === "wiki-missing") {
      removeWikiDatabase(this.root);
      this.#openAdapters();
      this.#openWorkflow("primary");
    } else if (this.scenario === "wiki-stale") {
      const target = join(this.root, ".mex/specs", `${SPEC_ID}.md`);
      writeFileSync(
        target,
        `${readFileSync(target, "utf8")}\nThe canonical source changed without an index refresh.\n`,
        "utf8",
      );
    }

    const repoState = await createRepositoryGitPort(this.#gitRoot, {
      now: () => new Date(this.#clock),
    }).getRepoState();
    this.oracle = {
      now: NOW,
      actor: ACTOR,
      repoState,
      populatedDraft,
      populatedProposal,
      privacySentinels: PRIVACY_SENTINELS,
    };
  }

  async attemptDirectWikiSpecMutation(
    surface: TeamInboxDirectBypassSurface,
    kind: TeamInboxDirectBypassCase,
  ): Promise<void> {
    const base = {
      opId: `direct_${surface}_${kind}`,
      actor: { kind: "human", id: "member_direct_guard" },
      timestamp: NOW,
    };
    const operation = directWikiBypassOperation(base, kind);
    assertNoDirectWikiSpecMutation(operation, {
      scaffoldRoot: join(this.#boundRoot, ".mex"),
    });
  }

  #openAdapters(): void {
    this.#wiki = createRepositoryWikiPort(this.#boundRoot, {
      now: () => this.#clock,
      __internal: {
        onOperationCompleted: () => {
          if (this.#crashPhase !== "approve.after-wiki") return;
          this.#crashPhase = null;
          throw new Error(PRIVACY_SENTINELS.join(" "));
        },
      },
    });
  }

  #openWorkflow(driver: "primary" | "restart"): TeamInboxSpecAuthoringContractPort {
    const pid = this.#nextPid++;
    this.#pids.add(pid);
    this.#workflow = createRepositoryTeamWorkflowPortWithDependencies<JsonValue, unknown>(
      this.#boundRoot,
      {
        scaffoldId: SCAFFOLD_ID,
        wiki: this.#wiki,
        git: createRepositoryGitPort(this.#gitRoot, {
          now: () => new Date(this.#clock),
        }),
        now: () => new Date(this.#clock),
        pid,
        processStatus: (observedPid) => (
          this.#deadPids.has(observedPid) ? "dead" : "alive"
        ),
        phaseHook: (boundary) => this.#onWorkflowPhase(boundary),
        afterPrimaryApply: () => this.#afterPrimaryApply(),
        idFactories: {
          member: () => this.#nextArtifactId("member", driver),
          workstream: () => this.#nextArtifactId("ws", driver),
          proposal: () => this.#nextArtifactId("proposal", driver),
          relay: () => this.#nextArtifactId("relay", driver),
          playbook: () => this.#nextArtifactId("playbook", driver),
          playbookRun: () => this.#nextArtifactId("run", driver),
          activity: () => this.#nextArtifactId("event", driver),
          spec: () => this.#nextSpecId(driver),
          localDraft: () => `inbox_contract_${driver}_${this.#nextCounter(`draft:${driver}`)}`,
          leaseToken: () => hash(`lease:${this.#seedOffset}:${driver}:${pid}`),
        },
      },
    );
    this.port = this.#workflow as unknown as TeamInboxSpecAuthoringContractPort;
    return this.port;
  }

  async #onWorkflowPhase(boundary: TeamWorkflowPhaseBoundary): Promise<void> {
    if (boundary === "before-canonical-publication" && this.#dependencyDriftPath !== null) {
      const path = this.#dependencyDriftPath;
      this.#dependencyDriftPath = null;
      const text = readFileSync(path, "utf8");
      const changed = text.replace(
        /(^|\n)revision:\s*(\d+)(?=\n)/u,
        (_match, prefix: string, revision: string) => (
          `${prefix}revision: ${Number(revision) + 1}`
        ),
      );
      writeFileSync(path, `${changed}\nDependency drift in the final publication window.\n`, "utf8");
    }
    if (boundary === "before-canonical-publication" && this.#dependencyRestore !== null) {
      const restore = this.#dependencyRestore;
      this.#dependencyRestore = null;
      writeFileSync(restore.path, restore.body);
      await this.#wiki.refreshFiles([restore.relativePath]);
    }
    if (boundary === "before-canonical-publication" && this.#proposalDriftPath !== null) {
      const path = this.#proposalDriftPath;
      this.#proposalDriftPath = null;
      writeFileSync(
        path,
        `${readFileSync(path, "utf8")}\nProposal drift in the final publication window.\n`,
        "utf8",
      );
    }
    const phase = this.#crashPhase;
    const matched = (
      (phase === "publish.after-proposal" && boundary === "after-canonical-publication")
      || (phase === "publish.after-activity" && boundary === "after-activity-publication")
      || (phase === "publish.after-cleanup" && boundary === "after-local-cleanup")
      || (phase === "approve.after-activity" && boundary === "after-activity-publication")
    );
    if (!matched || phase === null) return;
    this.#crashPhase = null;
    throw new WorkflowPhaseInterruption(boundary, {
      cause: new Error(PRIVACY_SENTINELS.join(" ")),
    });
  }

  async #afterPrimaryApply(): Promise<void> {
    if (this.#crashPhase !== "approve.after-proposal") return;
    this.#crashPhase = null;
    throw new WorkflowPhaseInterruption("after-canonical-publication", {
      cause: new Error(PRIVACY_SENTINELS.join(" ")),
    });
  }

  #nextCounter(key: string): number {
    const value = (this.#idCounters.get(key) ?? 0) + 1;
    this.#idCounters.set(key, value);
    return value;
  }

  #nextArtifactId(
    prefix: "member" | "ws" | "proposal" | "relay" | "playbook" | "run" | "event",
    driver: string,
  ): string {
    const counter = this.#nextCounter(`${driver}:${prefix}`);
    const offset = this.#seedOffset + (driver === "restart" ? 100 : 10) + counter;
    return generateArtifactId(prefix, {
      now: Date.parse(NOW) + offset,
      random: new Uint8Array(10).fill(offset % 255),
    });
  }

  #nextSpecId(driver: string): string {
    const eventId = this.#nextArtifactId("event", `${driver}:spec`);
    return `mx_${eventId.slice("event_".length)}`;
  }

  async #seedPopulatedInbox(): Promise<{
    populatedDraft: TeamInboxSpecDraftDetail;
    populatedProposal: TeamInboxSpecProposalDetail;
  }> {
    await this.#saveDraft(
      await this.makeDraftInput("spec.create", "requirement"),
      "fixture_draft_one",
    );
    const proposalDraft = await this.#saveDraft(
      await this.makeDraftInput("spec.update", "spec"),
      "fixture_proposal_draft",
    );
    const publish = await this.port.previewInbox(command(
      "fixture_proposal_publish",
      { kind: "inbox.publish", draftId: proposalDraft.id },
      [draftExpectation(proposalDraft)],
    ));
    const proposalId = purposeId(publish, "proposal");
    await this.port.applyInbox(roundTrip(publish));
    await this.#saveDraft(
      await this.makeDraftInput("spec.create", "constraint"),
      "fixture_draft_two",
    );
    const drafts = await this.port.listInboxDrafts({ limit: 100 });
    const first = drafts.items[0];
    if (first === undefined) throw new Error("Populated draft fixture is missing.");
    const populatedDraft = await this.port.getInboxDraft(first.id);
    const populatedProposal = await this.port.getInboxProposal(proposalId);
    if (populatedDraft === null || populatedProposal === null) {
      throw new Error("Populated Inbox fixture could not be projected.");
    }
    return { populatedDraft, populatedProposal };
  }

  async #saveDraft(
    input: TeamInboxSpecDraftInput,
    operationId: string,
  ): Promise<TeamInboxSpecDraftDetail> {
    const envelope = await this.port.previewInbox(command(
      operationId,
      { kind: "inbox.draft.save", draft: input },
    ));
    const id = purposeId(envelope, "inbox-draft");
    await this.port.applyInbox(roundTrip(envelope));
    const draft = await this.port.getInboxDraft(id);
    if (draft === null) throw new Error("Saved Inbox draft is missing.");
    return draft;
  }

  async makeDraftInput(
    changeKind: TeamInboxSpecChange["kind"],
    entityKind: TeamInboxSpecKind = "spec",
  ): Promise<TeamInboxSpecDraftInput> {
    if (changeKind === "spec.create") {
      return {
        change: {
          kind: "spec.create",
          entityKind,
          title: `Contract ${humanKind(entityKind)}`,
          summary: `A reviewed ${humanKind(entityKind)} created through Inbox.`,
          body: `The ${humanKind(entityKind)} is governed by one portable proposal.`,
          status: "in_flight",
        },
        rationale: "Publish one bounded declarative Spec change for human review.",
        evidence: [{ kind: "manual", note: "Repository consumer contract fixture" }],
        targetRevisions: [],
      };
    }
    const target = await this.#requiredEntity(SPEC_IDS[entityKind]);
    return {
      change: {
        kind: "spec.update",
        target: {
          id: target.ref.id,
          kind: entityKind,
          title: target.title,
        },
        patch: {
          title: `${target.title} reviewed`,
          summary: `Updated ${humanKind(entityKind)} summary from Inbox review.`,
          body: `${target.body.trim()}\n\nThis exact update was approved through Inbox.`,
        },
      },
      rationale: `Keep the existing ${humanKind(entityKind)} aligned with reviewed intent.`,
      evidence: [{ kind: "manual", note: "Repository consumer contract fixture" }],
      targetRevisions: [entityExpectation(target)],
    };
  }

  async makeValidCreateInput(
    kind: TeamInboxValidCreateCase,
  ): Promise<TeamInboxSpecDraftInput> {
    if (kind === "in-flight") return this.makeDraftInput("spec.create", "spec");
    if (kind === "promoted-with-topics") {
      const input = await this.makeDraftInput("spec.create", "spec");
      const topic = await this.#requiredEntity(TOPIC_ID);
      return {
        ...input,
        change: {
          ...input.change,
          status: "promoted",
          topics: [TOPIC_ID],
        },
        targetRevisions: [entityExpectation(topic)],
      } as TeamInboxSpecDraftInput;
    }
    const relationFixture: Readonly<Record<Exclude<
      TeamInboxValidCreateCase,
      "in-flight" | "promoted-with-topics"
    >, {
      source: TeamInboxSpecKind;
      type: "derived_from" | "verified_by" | "constrained_by" | "refines";
      target: TeamInboxSpecKind;
    }>> = {
      "spec-constrained-by": {
        source: "spec",
        type: "constrained_by",
        target: "constraint",
      },
      "requirement-derived-from": {
        source: "requirement",
        type: "derived_from",
        target: "spec",
      },
      "requirement-refines": {
        source: "requirement",
        type: "refines",
        target: "requirement",
      },
      "requirement-constrained-by": {
        source: "requirement",
        type: "constrained_by",
        target: "constraint",
      },
      "constraint-constrained-by": {
        source: "constraint",
        type: "constrained_by",
        target: "constraint",
      },
      "acceptance-verified-by-requirement": {
        source: "acceptance_criterion",
        type: "verified_by",
        target: "requirement",
      },
      "acceptance-verified-by-spec": {
        source: "acceptance_criterion",
        type: "verified_by",
        target: "spec",
      },
      "acceptance-constrained-by": {
        source: "acceptance_criterion",
        type: "constrained_by",
        target: "constraint",
      },
    };
    const fixture = relationFixture[kind];
    const input = await this.makeDraftInput("spec.create", fixture.source);
    const endpoint = await this.#requiredEntity(SPEC_IDS[fixture.target]);
    return {
      ...input,
      change: {
        ...input.change,
        relation: {
          type: fixture.type,
          target: {
            id: endpoint.ref.id,
            kind: fixture.target,
            title: endpoint.title,
          },
        },
      },
      targetRevisions: [entityExpectation(endpoint)],
    } as TeamInboxSpecDraftInput;
  }

  async makeDriftInput(kind: TeamInboxSpecDriftCase): Promise<TeamInboxSpecDraftInput> {
    if (kind === "update-target") return this.makeDraftInput("spec.update", "spec");
    if (kind === "topic-endpoint") return this.makeValidCreateInput("promoted-with-topics");
    return this.makeValidCreateInput("requirement-derived-from");
  }

  async makeInvalidCommand(kind: TeamInboxSpecInvalidCase): Promise<unknown> {
    const create = await this.makeDraftInput("spec.create", "spec");
    const update = await this.makeDraftInput("spec.update", "spec");
    const base = (draft: unknown): Record<string, unknown> => ({
      operationId: `inbox_contract_invalid_${kind}`,
      action: { kind: "inbox.draft.save", draft },
      expectedRevisions: [],
    });
    switch (kind) {
      case "raw-wiki-request":
        return base({
          request: { operation: { type: "create-entry" }, expectedRevisions: [] },
          rationale: create.rationale,
          evidence: create.evidence,
          targetRevisions: [],
        });
      case "hidden-operations-batch":
        return base({
          ...create,
          change: { ...create.change, payload: { operations: [{ type: "create-entry" }] } },
        });
      case "caller-create-id":
        return base({ ...create, change: { ...create.change, id: this.#nextSpecId("invalid") } });
      case "caller-create-path":
        return base({ ...create, change: { ...create.change, path: ".mex/specs/caller.md" } });
      case "create-adopt":
        return base({ ...create, change: { ...create.change, adopt: true } });
      case "create-source":
        return base({ ...create, change: { ...create.change, sources: [{ type: "manual" }] } });
      case "create-grounding":
        return base({ ...create, change: { ...create.change, groundings: [] } });
      case "create-metadata":
        return base({ ...create, change: { ...create.change, metadata: { private: true } } });
      case "unsupported-operation":
        return base({ ...create, change: { kind: "spec.archive", target: { id: SPEC_ID } } });
      case "non-spec-kind":
        return base({ ...create, change: { ...create.change, entityKind: "decision" } });
      case "wrong-relation-direction": {
        const endpoint = await this.#requiredEntity(SPEC_ID);
        return base({
          ...create,
          change: {
            ...create.change,
            relation: { type: "derived_from", target: { id: endpoint.ref.id, kind: "spec" } },
          },
          targetRevisions: [entityExpectation(endpoint)],
        });
      }
      case "multiple-create-relations": {
        const endpoint = await this.#requiredEntity(CONSTRAINT_ID);
        return base({
          ...create,
          change: {
            ...create.change,
            relations: [
              { type: "constrained_by", target: { id: CONSTRAINT_ID, kind: "constraint" } },
              { type: "constrained_by", target: { id: CONSTRAINT_ID, kind: "constraint" } },
            ],
          },
          targetRevisions: [entityExpectation(endpoint)],
        });
      }
      case "invalid-create-status":
        return base({ ...create, change: { ...create.change, status: "deprecated" } });
      case "too-many-topics": {
        const topic = await this.#requiredEntity(TOPIC_ID);
        return base({
          ...create,
          change: { ...create.change, topics: Array.from({ length: 65 }, () => TOPIC_ID) },
          targetRevisions: [entityExpectation(topic)],
        });
      }
      case "missing-topic-expectation":
        return base({ ...create, change: { ...create.change, topics: [TOPIC_ID] } });
      case "missing-relation-expectation":
        return base({
          ...create,
          change: {
            ...create.change,
            entityKind: "requirement",
            relation: { type: "derived_from", target: { id: SPEC_ID, kind: "spec" } },
          },
        });
      case "empty-update":
        return base({ ...update, change: { ...update.change, patch: {} } });
      case "update-extra-field":
        return base({ ...update, change: { ...update.change, patch: { status: "promoted" } } });
      case "update-non-spec-target": {
        const target = await this.#requiredEntity(NON_SPEC_ID);
        return base({
          ...update,
          change: {
            ...update.change,
            target: { id: target.ref.id, kind: "decision", title: target.title },
          },
          targetRevisions: [entityExpectation(target)],
        });
      }
      case "caller-authority":
        return { ...base(create), actor: ACTOR };
      case "missing-expectation":
        return base({ ...update, targetRevisions: [] });
    }
  }

  async prepareEnvelopeExpansionDraft(): Promise<{
    draft: TeamInboxSpecDraftDetail;
    storedArtifactBytes: number;
  }> {
    const input = await this.makeDraftInput("spec.create", "spec");
    if (input.change.kind !== "spec.create") throw new Error("Expected create fixture.");
    const expanded: TeamInboxSpecDraftInput = {
      ...input,
      change: {
        ...input.change,
        body: "B".repeat(15_500),
      },
      rationale: "R".repeat(7_800),
      evidence: Array.from({ length: 10 }, (_, index) => ({
        kind: "manual" as const,
        note: `${index}:${"E".repeat(3_950)}`,
      })),
    };
    const draft = await this.#saveDraft(expanded, "fixture_envelope_expansion_save");
    return {
      draft,
      storedArtifactBytes: Buffer.byteLength(JSON.stringify(draft), "utf8"),
    };
  }

  async mutateReadCorpus(): Promise<void> {
    await this.#saveDraft(
      await this.makeDraftInput("spec.create", "spec"),
      `inbox_cursor_mutation_${this.#nextCounter("cursor")}`,
    );
  }

  async mutatePublishedDependency(
    proposal: TeamInboxSpecProposalDetail,
    kind: TeamInboxSpecDriftCase,
  ): Promise<void> {
    const targetId = kind === "update-target"
      ? proposal.change.kind === "spec.update"
        ? proposal.change.target.id
        : fail("Expected an update proposal.")
      : kind === "topic-endpoint"
        ? proposal.change.kind === "spec.create"
          ? proposal.change.topics?.[0] ?? fail("Expected a topic endpoint.")
          : fail("Expected a create proposal.")
        : proposal.change.kind === "spec.create"
          ? proposal.change.relation?.target.id ?? fail("Expected a relation endpoint.")
          : fail("Expected a create proposal.");
    const target = await this.#requiredEntity(targetId);
    const path = join(this.#boundRoot, ...target.location.path.split("/"));
    const text = readFileSync(path, "utf8");
    const changed = text.replace(
      /(^|\n)revision:\s*(\d+)(?=\n)/u,
      (_match, prefix: string, revision: string) => (
        `${prefix}revision: ${Number(revision) + 1}`
      ),
    );
    writeFileSync(path, `${changed}\nDependency drift ${kind}.\n`, "utf8");
    await this.#wiki.refreshFiles([target.location.path]);
  }

  async installTeamOwnedDuplicateClaimant(entityId: string): Promise<void> {
    const target = await this.#requiredEntity(entityId);
    const source = join(this.#boundRoot, ...target.location.path.split("/"));
    write(
      this.#boundRoot,
      `.mex/workstreams/inbox-spec-claimant-${this.#nextCounter("claimant")}.md`,
      readFileSync(source, "utf8"),
    );
  }

  async armDependencyDriftBeforePublication(entityId: string): Promise<void> {
    const target = await this.#requiredEntity(entityId);
    this.#dependencyDriftPath = join(
      this.#boundRoot,
      ...target.location.path.split("/"),
    );
  }

  async armDependencyRestoreBeforePublication(entityId: string): Promise<void> {
    const target = await this.#requiredEntity(entityId);
    this.#dependencyRestore = {
      path: join(this.#boundRoot, ...target.location.path.split("/")),
      relativePath: target.location.path,
      body: gitBytes(this.#gitRoot, ["show", `HEAD:${target.location.path}`]),
    };
  }

  async armProposalDriftBeforePublication(
    proposal: TeamInboxSpecProposalDetail,
  ): Promise<void> {
    this.#proposalDriftPath = join(
      this.#boundRoot,
      ...proposal.sourcePath.split("/"),
    );
  }

  async mutateRepositoryAuthority(): Promise<void> {
    git(this.#gitRoot, [
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      `Inbox contract authority drift ${this.#nextCounter("authority")}`,
    ]);
  }

  async refreshDraftInput(
    input: TeamInboxSpecDraftInput,
  ): Promise<TeamInboxSpecDraftInput> {
    const ids = input.change.kind === "spec.update"
      ? [input.change.target.id]
      : [
          ...(input.change.topics ?? []),
          ...(input.change.relation === undefined ? [] : [input.change.relation.target.id]),
        ];
    const targetRevisions = await Promise.all(ids.map(async (id) => (
      entityExpectation(await this.#requiredEntity(id))
    )));
    return { ...roundTrip(input), targetRevisions };
  }

  async readSpec(id: string): Promise<TeamInboxSpecProjection | null> {
    const entity = await this.#wiki.getEntity(id);
    if (entity === null || !TEAM_INBOX_SPEC_KINDS.includes(entity.ref.kind as TeamInboxSpecKind)) {
      return null;
    }
    const topics = await Promise.all(entity.topics.map(async (topicId): Promise<EntityRef> => {
      const topic = await this.#wiki.getEntity(topicId);
      return topic?.ref ?? { id: topicId, kind: "topic" };
    }));
    const relations = await Promise.all(entity.relations.map(async (relation) => {
      const target = await this.#wiki.getEntity(relation.target);
      return {
        type: relation.type as TeamInboxSpecProjection["relations"][number]["type"],
        target: {
          id: relation.target,
          kind: (target?.ref.kind ?? "spec") as TeamInboxSpecKind,
          ...(target === null ? {} : { title: target.title }),
        },
      };
    }));
    return {
      ref: {
        id: entity.ref.id,
        kind: entity.ref.kind as TeamInboxSpecKind,
        title: entity.title,
      },
      sourcePath: entity.location.path,
      title: entity.title,
      summary: entity.summary ?? null,
      body: entity.body.trim(),
      topics,
      relations,
      revision: entity.version.contentHash,
      semanticRevision: entity.version.semanticRevision,
    };
  }

  async #requiredEntity(id: string): Promise<WikiEntity<never>> {
    const entity = await this.#wiki.getEntity(id);
    if (entity === null) throw new Error(`Required Wiki fixture ${id} is missing.`);
    return entity;
  }

  async restart(): Promise<TeamInboxSpecAuthoringContractPort> {
    for (const pid of this.#pids) this.#deadPids.add(pid);
    this.#openAdapters();
    return this.#openWorkflow("restart");
  }

  setNow(timestamp: string): void {
    this.#clock = timestamp;
  }

  async removeSigner(): Promise<void> {
    const path = join(
      this.#boundRoot,
      ...TEAM_RECEIPT_SIGNER_RELATIVE_PATH.split("/"),
    );
    rmSync(path, { force: true });
  }

  async armCrash(phase: TeamInboxSpecRecoveryPhase): Promise<void> {
    if (this.#crashPhase !== null) throw new Error("An Inbox crash is already armed.");
    this.#crashPhase = phase;
  }

  async prepareRecoveryEnvelope(
    phase: TeamInboxSpecRecoveryPhase,
  ): Promise<TeamInboxSpecPreviewEnvelope> {
    const label = phase.replaceAll(".", "_").replaceAll("-", "_");
    if (phase.startsWith("publish.")) {
      const draft = await this.#saveDraft(
        await this.makeDraftInput("spec.create", "spec"),
        `recovery_${label}_save`,
      );
      return this.port.previewInbox(command(
        `recovery_${label}_apply`,
        { kind: "inbox.publish", draftId: draft.id },
        [draftExpectation(draft)],
      ));
    }
    const proposal = await this.#createPendingProposal(
      await this.makeDraftInput("spec.create", "spec"),
      `recovery_${label}`,
    );
    return this.port.previewInbox(command(
      `recovery_${label}_approve`,
      { kind: "inbox.approve", proposalId: proposal.ref.id },
      [proposalExpectation(proposal)],
    ));
  }

  async #createPendingProposal(
    input: TeamInboxSpecDraftInput,
    operationPrefix: string,
  ): Promise<TeamInboxSpecProposalDetail> {
    const draft = await this.#saveDraft(input, `${operationPrefix}_save`);
    const publish = await this.port.previewInbox(command(
      `${operationPrefix}_publish`,
      { kind: "inbox.publish", draftId: draft.id },
      [draftExpectation(draft)],
    ));
    const proposalId = purposeId(publish, "proposal");
    await this.port.applyInbox(roundTrip(publish));
    const proposal = await this.port.getInboxProposal(proposalId);
    if (proposal === null) throw new Error("Published proposal is missing.");
    return proposal;
  }

  async installEscapingAncestor(
    target: TeamInboxSpecContainmentTarget,
  ): Promise<void> {
    const relativeTarget = target === "local"
      ? ".mex/local"
      : target === "proposal"
        ? ".mex/inbox"
        : target === "activity"
          ? ".mex/events/activity"
          : ".mex/specs";
    const path = join(this.#boundRoot, ...relativeTarget.split("/"));
    const preserved = join(this.container, `preserved-${target}-${this.#seedOffset}`);
    if (existsSync(path)) renameSync(path, preserved);
    mkdirSync(dirname(path), { recursive: true });
    const outside = join(this.outsideRoot, target);
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, path);
  }

  async prepareContainmentEnvelope(
    target: TeamInboxSpecContainmentTarget,
  ): Promise<TeamInboxSpecPreviewEnvelope> {
    if (target === "local") {
      return this.port.previewInbox(command(
        "containment_local",
        {
          kind: "inbox.draft.save",
          draft: await this.makeDraftInput("spec.create", "spec"),
        },
      ));
    }
    if (target === "proposal" || target === "activity") {
      const draft = await this.#saveDraft(
        await this.makeDraftInput("spec.create", "spec"),
        `containment_${target}_save`,
      );
      return this.port.previewInbox(command(
        `containment_${target}_publish`,
        { kind: "inbox.publish", draftId: draft.id },
        [draftExpectation(draft)],
      ));
    }
    const proposal = await this.#createPendingProposal(
      await this.makeDraftInput("spec.create", "spec"),
      "containment_spec",
    );
    return this.port.previewInbox(command(
      "containment_spec_approve",
      { kind: "inbox.approve", proposalId: proposal.ref.id },
      [proposalExpectation(proposal)],
    ));
  }

  async swapProjectRoot(): Promise<void> {
    const moved = join(this.container, `bound-after-swap-${this.#seedOffset}`);
    renameSync(this.root, moved);
    mkdirSync(this.root);
    write(this.root, "replacement.txt", "replacement checkout\n");
    this.#boundRoot = moved;
    this.#gitRoot = moved;
  }

  async snapshot(): Promise<TeamInboxSpecSnapshot> {
    return snapshotAt(
      this.#boundRoot,
      this.#gitRoot,
      this.outsideRoot,
      this.#clock,
    );
  }

  async inspectJournal(): Promise<ReturnType<typeof inspectJournalAt>> {
    return inspectJournalAt(this.#boundRoot);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#ownsContainer) {
      rmSync(this.container, { recursive: true, force: true });
    } else {
      rmSync(this.root, { recursive: true, force: true });
      rmSync(this.outsideRoot, { recursive: true, force: true });
    }
  }

  async refreshWikiIndex(): Promise<void> {
    this.#openAdapters();
    await this.#wiki.rebuildIndex();
    this.#openWorkflow("primary");
  }
}

class RepositoryInboxSpecTwoCloneHarness implements TeamInboxSpecTwoCloneHarness {
  readonly left: RepositoryInboxSpecHarness;
  readonly right: RepositoryInboxSpecHarness;
  #synchronizations = 0;
  #closed = false;

  private constructor(
    left: RepositoryInboxSpecHarness,
    right: RepositoryInboxSpecHarness,
  ) {
    this.left = left;
    this.right = right;
  }

  static async open(): Promise<RepositoryInboxSpecTwoCloneHarness> {
    const left = await RepositoryInboxSpecHarness.open("empty", { seedOffset: 1_000 });
    const rightRoot = join(left.container, "peer");
    const rightOutside = join(left.container, "outside-peer");
    try {
      git(left.container, ["clone", "-q", "--no-hardlinks", left.root, rightRoot]);
      git(rightRoot, ["config", "user.name", "Ada Lovelace"]);
      git(rightRoot, ["config", "user.email", "ada@example.test"]);
      const right = await RepositoryInboxSpecHarness.open("empty", {
        container: left.container,
        root: rightRoot,
        outsideRoot: rightOutside,
        ownsContainer: false,
        seedOffset: 2_000,
      });
      return new RepositoryInboxSpecTwoCloneHarness(left, right);
    } catch (error) {
      await left.close();
      throw error;
    }
  }

  async synchronizeCanonical(): Promise<void> {
    this.#synchronizations += 1;
    const source = this.#synchronizations === 1 ? this.left.root : this.right.root;
    const target = this.#synchronizations === 1 ? this.right.root : this.left.root;
    copyPortableCanonical(source, target);
    const receiver = this.#synchronizations === 1 ? this.right : this.left;
    await receiver.refreshWikiIndex();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.right.close();
    await this.left.close();
  }
}

function bindHarness(harness: RepositoryInboxSpecHarness): RepositoryInboxSpecHarness {
  return new Proxy(harness, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function command(
  operationId: string,
  action: TeamInboxSpecCommand["action"],
  expectedRevisions: readonly RevisionExpectation[] = [],
): TeamInboxSpecCommand {
  return { operationId, action, expectedRevisions };
}

function draftExpectation(draft: TeamInboxSpecDraftDetail): RevisionExpectation {
  return {
    target: { kind: "local", namespace: "inbox-draft", id: draft.id },
    revision: draft.revision,
  };
}

function proposalExpectation(
  proposal: TeamInboxSpecProposalDetail,
): RevisionExpectation {
  return {
    target: { kind: "artifact", path: proposal.sourcePath },
    revision: proposal.revision,
  };
}

function entityExpectation(entity: WikiEntity<never>): RevisionExpectation {
  return {
    target: { kind: "entity", id: entity.ref.id },
    revision: entity.version.contentHash,
    semanticRevision: entity.version.semanticRevision,
  };
}

function purposeId(
  envelope: TeamInboxSpecPreviewEnvelope,
  purpose: "inbox-draft" | "proposal" | "activity" | "spec-entity",
): string {
  const matched = envelope.receipt.purposeIds.find((entry) => entry.purpose === purpose);
  if (matched === undefined) throw new Error(`Missing ${purpose} purpose ID.`);
  return matched.id;
}

function roundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function seedWikiCorpus(root: string): void {
  write(root, `.mex/specs/${SPEC_ID}.md`, wikiEntityDocument({
    id: SPEC_ID,
    kind: "spec",
    title: "Recoverable checkout",
    summary: "Checkout state is recoverable after a process interruption.",
    body: "Every accepted checkout transition has one durable recovery path.",
    status: "promoted",
    topics: [TOPIC_ID],
  }));
  write(root, `.mex/specs/${REQUIREMENT_ID}.md`, wikiEntityDocument({
    id: REQUIREMENT_ID,
    kind: "requirement",
    title: "Persist before publication",
    summary: "Persist intent before publishing canonical bytes.",
    body: "The workflow records bounded intent before the first canonical write.",
    status: "promoted",
    relations: [{ type: "derived_from", target: SPEC_ID }],
  }));
  write(root, `.mex/specs/${CONSTRAINT_ID}.md`, wikiEntityDocument({
    id: CONSTRAINT_ID,
    kind: "constraint",
    title: "No prose in recovery rows",
    summary: "Recovery metadata remains body-free and bounded.",
    body: "Journal effects contain identifiers and revisions, never proposal prose.",
    status: "promoted",
  }));
  write(root, `.mex/specs/${ACCEPTANCE_ID}.md`, wikiEntityDocument({
    id: ACCEPTANCE_ID,
    kind: "acceptance_criterion",
    title: "One effect after replay",
    summary: "A restarted approval converges without duplicate effects.",
    body: "Exact replay produces one Spec transition and one Activity record.",
    status: "promoted",
    relations: [{ type: "verified_by", target: REQUIREMENT_ID }],
  }));
  write(root, `.mex/topics/${TOPIC_ID}.md`, wikiEntityDocument({
    id: TOPIC_ID,
    kind: "topic",
    title: "Workflow recovery",
    summary: "Repository-local workflow recovery behavior.",
    body: "Recovery remains deterministic across process and clone boundaries.",
    status: "promoted",
  }));
  write(root, `.mex/context/${NON_SPEC_ID}.md`, wikiEntityDocument({
    id: NON_SPEC_ID,
    kind: "decision",
    title: "Keep canonical state in Git",
    summary: "Canonical team memory remains portable through Git.",
    body: "No central service owns the repository's canonical team memory.",
    status: "promoted",
  }));
  write(root, ".mex/events/operations.jsonl", "");
}

function wikiEntityDocument(input: {
  id: string;
  kind: string;
  title: string;
  summary: string;
  body: string;
  status: "in_flight" | "promoted";
  topics?: readonly string[];
  relations?: readonly { type: string; target: string }[];
}): string {
  const topics = input.topics === undefined || input.topics.length === 0
    ? []
    : ["topics:", ...input.topics.map((topic) => `  - ${topic}`)];
  const relations = input.relations === undefined || input.relations.length === 0
    ? []
    : [
        "relations:",
        ...input.relations.flatMap((relation) => [
          `  - type: ${relation.type}`,
          `    target: ${relation.target}`,
        ]),
      ];
  return [
    "<!-- mex:entity",
    `id: ${input.id}`,
    `type: ${input.kind}`,
    `status: ${input.status}`,
    "revision: 1",
    `title: ${input.title}`,
    `summary: ${input.summary}`,
    ...topics,
    ...relations,
    "sources:",
    "  - type: manual",
    "    note: Repository consumer contract fixture",
    "-->",
    `# ${input.title}`,
    "",
    input.body,
    "",
  ].join("\n");
}

async function snapshotAt(
  root: string,
  gitRoot: string,
  outsideRoot: string,
  now: string,
): Promise<TeamInboxSpecSnapshot> {
  const localDatabase = join(root, ".mex/local/team.db");
  const signer = join(root, ...TEAM_RECEIPT_SIGNER_RELATIVE_PATH.split("/"));
  return {
    canonicalDigest: canonicalDigest(root),
    wikiDigest: wikiDigest(root),
    localStateDigest: databaseDigest(localDatabase, true),
    signerDigest: regularFileDigest(signer),
    outsideDigest: treeDigest(outsideRoot),
    gitHead: gitText(gitRoot, ["rev-parse", "HEAD"]).trim() || null,
    gitIndexDigest: hash(gitBytes(gitRoot, ["ls-files", "--stage", "-z"])),
    draftIds: localDraftIds(root, now),
    proposalIds: markdownIds(join(root, ".mex/inbox"), /^proposal_[0-9A-HJKMNP-TV-Z]{26}$/u),
    specIds: specEntityIds(root),
    activityIds: activityIds(root),
    wikiAuditOperationIds: wikiAuditOperationIds(root),
    modelInvocations: 0,
    outboundRequests: 0,
  };
}

function inspectJournalAt(root: string) {
  const database = join(root, ".mex/local/team.db");
  const durablePaths = [database, `${database}-wal`, `${database}-shm`, `${database}-journal`]
    .filter((path) => existsSync(path) && lstatSync(path).isFile());
  const forbidden = new Set<string>();
  for (const path of durablePaths) {
    const bytes = readFileSync(path);
    for (const sentinel of PRIVACY_SENTINELS) {
      if (bytes.includes(Buffer.from(sentinel, "utf8"))) forbidden.add(sentinel);
    }
  }
  if (!existsSync(database) || !lstatSync(database).isFile()) {
    return {
      rowCount: 0,
      incompleteCount: 0,
      rows: [],
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
      rows,
      durableStorageForbiddenMatches: [...forbidden].sort(compare),
    };
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

function localDraftIds(root: string, now: string): readonly string[] {
  try {
    return new TeamLocalState(localStateOptions(root, now))
      .listLocalDrafts({ kind: "inbox", limit: 100 })
      .items.map((draft) => draft.id)
      .sort(compare);
  } catch {
    return [];
  }
}

function markdownIds(directory: string, pattern: RegExp): readonly string[] {
  if (!isRealDirectory(directory)) return [];
  return regularFiles(directory)
    .filter((path) => path.endsWith(".md"))
    .map((path) => basename(path, ".md"))
    .filter((id) => pattern.test(id))
    .sort(compare);
}

function specEntityIds(root: string): readonly string[] {
  const directory = join(root, ".mex/specs");
  if (!isRealDirectory(directory)) return [];
  return regularFiles(directory)
    .filter((path) => path.endsWith(".md"))
    .map((path) => basename(path, ".md"))
    .filter((id) => /^mx_[0-9A-HJKMNP-TV-Z]{26}$/u.test(id))
    .sort(compare);
}

function activityIds(root: string): readonly string[] {
  const directory = join(root, ".mex/events/activity");
  if (!isRealDirectory(directory)) return [];
  const ids: string[] = [];
  for (const path of regularFiles(directory)) {
    if (!path.endsWith(".md")) continue;
    const relativePath = path.slice(root.length + 1).replaceAll("\\", "/") as RepoRelativePath;
    try {
      ids.push(parseActivityArtifact(readFileSync(path), relativePath).id);
    } catch {
      // Containment and interrupted-write fixtures remain snapshot-able.
    }
  }
  return ids.sort(compare);
}

function wikiAuditOperationIds(root: string): readonly string[] {
  const path = join(root, ".mex/events/operations.jsonl");
  if (!existsSync(path) || !lstatSync(path).isFile()) return [];
  const ids: string[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      const entry = JSON.parse(line) as { phase?: unknown; opId?: unknown };
      if (entry.phase === "complete" && typeof entry.opId === "string") ids.push(entry.opId);
    } catch {
      // A corrupt ledger is represented by its digest; do not trust its IDs.
    }
  }
  return ids.sort(compare);
}

function canonicalDigest(root: string): Revision {
  return treeDigest(root, (path) => {
    if (path === ".git" || path.startsWith(".git/")) return false;
    if (path === ".mex/local" || path.startsWith(".mex/local/")) return false;
    if (/^\.mex\/(?:wiki|graph)\.db(?:-|$)/u.test(path)) return false;
    return true;
  });
}

function wikiDigest(root: string): Revision {
  return treeDigest(root, (path) => (
    path === ".mex"
    || path === ".mex/specs"
    || path.startsWith(".mex/specs/")
    || path === ".mex/topics"
    || path.startsWith(".mex/topics/")
    || path === ".mex/events"
    || path === ".mex/events/operations.jsonl"
  ));
}

function databaseDigest(path: string, absentIsNull = false): Revision | null {
  if (!existsSync(path) || !lstatSync(path).isFile()) {
    return absentIsNull ? null : hash("");
  }
  const digest = createHash("sha256");
  for (const candidate of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) {
    if (!existsSync(candidate) || !lstatSync(candidate).isFile()) continue;
    digest.update(basename(candidate));
    digest.update(readFileSync(candidate));
  }
  return digest.digest("hex");
}

function regularFileDigest(path: string): Revision | null {
  if (!existsSync(path) || !lstatSync(path).isFile()) return null;
  return hash(readFileSync(path));
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
    ".mex/inbox",
    ".mex/specs",
    ".mex/topics",
    ".mex/events/activity",
  ]) {
    const sourceRoot = join(source, ...relativeRoot.split("/"));
    if (!isRealDirectory(sourceRoot)) continue;
    for (const path of regularFiles(sourceRoot)) {
      const relativePath = path.slice(source.length + 1);
      const destination = join(target, relativePath);
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(path, destination);
    }
  }
  const operationLog = join(source, ".mex/events/operations.jsonl");
  if (existsSync(operationLog) && lstatSync(operationLog).isFile()) {
    const destination = join(target, ".mex/events/operations.jsonl");
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(operationLog, destination);
  }
}

function installProposalSourceBound(root: string): void {
  const directory = join(root, ".mex/inbox");
  mkdirSync(directory, { recursive: true });
  let entries = readdirSync(directory).length;
  while (entries <= WORKFLOW_REPOSITORY_LIMITS.maxDirectoryEntries) {
    writeFileSync(join(directory, `bound-${String(entries).padStart(4, "0")}`), "", "utf8");
    entries += 1;
  }
}

function removeWikiDatabase(root: string): void {
  const mex = join(root, ".mex");
  if (!isRealDirectory(mex)) return;
  for (const name of readdirSync(mex)) {
    if (name === "wiki.db" || name.startsWith("wiki.db-")) {
      rmSync(join(mex, name), { force: true });
    }
  }
}

function localStateOptions(root: string, now: string) {
  return {
    projectRoot: root,
    scaffoldId: SCAFFOLD_ID,
    now: () => now,
    processStatus: () => "alive" as const,
  };
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

function write(root: string, relativePath: string, body: string): void {
  const path = join(root, ...relativePath.split("/"));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, "utf8");
}

function isRealDirectory(path: string): boolean {
  return existsSync(path)
    && lstatSync(path).isDirectory()
    && !lstatSync(path).isSymbolicLink();
}

function humanKind(kind: TeamInboxSpecKind): string {
  return kind.replaceAll("_", " ");
}

function directWikiBypassOperation(
  base: Readonly<Record<string, unknown>>,
  kind: TeamInboxDirectBypassCase,
): unknown {
  const nonSpecUpdate = {
    ...base,
    type: "update-entry",
    entityId: NON_SPEC_ID,
    payload: { summary: "Direct non-Spec administration." },
  };
  switch (kind) {
    case "create":
      return {
        ...base,
        type: "create-entry",
        payload: {
          file: "context/direct-spec.md",
          insertAt: { at: "end-of-file" },
          type: "spec",
          title: "Direct Spec",
          body: "This must be Inbox governed.",
        },
      };
    case "existing-target":
      return { ...nonSpecUpdate, entityId: SPEC_ID };
    case "relation-endpoint":
      return {
        ...base,
        type: "add-relation",
        entityId: NON_SPEC_ID,
        payload: { relation: { type: "related_to", target: SPEC_ID } },
      };
    case "type-conversion-into":
      return {
        ...base,
        type: "set-property",
        entityId: NON_SPEC_ID,
        payload: { property: "type", value: "requirement" },
      };
    case "type-conversion-out-of":
      return {
        ...base,
        type: "set-property",
        entityId: SPEC_ID,
        payload: { property: "type", value: "decision" },
      };
    case "supersede-existing-replacement":
      return {
        ...base,
        type: "supersede-entry",
        entityId: NON_SPEC_ID,
        payload: { replacementId: REQUIREMENT_ID },
      };
    case "supersede-inline-replacement":
      return {
        ...base,
        type: "supersede-entry",
        entityId: NON_SPEC_ID,
        payload: {
          replacement: {
            file: "context/direct-replacement.md",
            insertAt: { at: "end-of-file" },
            type: "constraint",
            title: "Direct replacement",
            body: "This must be Inbox governed.",
          },
        },
      };
    case "supersede-inline-relation-endpoint":
      return {
        ...base,
        type: "supersede-entry",
        entityId: NON_SPEC_ID,
        payload: {
          replacement: {
            file: "context/direct-replacement.md",
            insertAt: { at: "end-of-file" },
            type: "decision",
            title: "Direct non-Spec replacement",
            body: "The replacement itself is non-Spec, but its relation endpoint is governed.",
            relations: [{ type: "related_to", target: SPEC_ID }],
          },
        },
      };
    case "spec-path":
      return {
        ...base,
        type: "create-entry",
        payload: {
          file: "specs/direct-decision.md",
          insertAt: { at: "end-of-file" },
          type: "decision",
          title: "Wrong path",
          body: "A non-Spec type still cannot claim the Spec root.",
        },
      };
    case "hidden-batch":
      return {
        ...nonSpecUpdate,
        payload: {
          operations: [{
            type: "create-entry",
            payload: {
              file: "context/hidden-spec.md",
              insertAt: { at: "end-of-file" },
              type: "acceptance_criterion",
              title: "Hidden direct Spec",
              body: "Nested batch escape.",
            },
          }],
        },
      };
  }
}

function hash(value: string | Buffer): Revision {
  return createHash("sha256").update(value).digest("hex");
}

function artifactId(prefix: "member", entropy: number): string {
  return generateArtifactId(prefix, {
    now: Date.parse(NOW) + entropy,
    random: new Uint8Array(10).fill(entropy),
  });
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fail(message: string): never {
  throw new Error(message);
}

describe("Knowledge Inbox real approval pipeline", () => {
  it("approves and recovers exact CRLF Wiki bytes while keeping Team artifact revisions portable", async () => {
    const harness = await RepositoryInboxSpecHarness.open("empty");
    try {
      let port = harness.port as unknown as KnowledgeInboxPort;
      const path = join(harness.root, `.mex/context/${NON_SPEC_ID}.md`);
      const original = `${readFileSync(path, "utf8")}\nLiteral \\r stays literal.\n`.replaceAll("\n", "\r\n");
      writeFileSync(path, original);
      const auditPath = join(harness.root, ".mex/events/operations.jsonl");
      mkdirSync(dirname(auditPath), { recursive: true });
      // An empty historical CRLF line is valid ledger text and remains part of
      // the exact preview/recovery hash even though it has no operation record.
      writeFileSync(auditPath, "\r\n");
      await harness.refreshWikiIndex();
      const wiki = createRepositoryWikiPort(harness.root);
      const target = (await wiki.getEntity(NON_SPEC_ID))!;
      expect(target.version.contentHash).toBe(hash(original));
      const input: KnowledgeDraftInput = {
        ...knowledgeInput("decision"),
        evidence: [],
        change: {
          kind: "knowledge.update",
          target: { id: target.ref.id, kind: "decision", title: target.title },
          patch: { body: "Reviewed correction of CRLF context; literal \\r remains text." },
        },
        targetRevisions: [entityExpectation(target)],
      };
      const proposal = await publishKnowledge(port, input, "crlf_update");
      const proposalPath = join(harness.root, proposal.sourcePath);
      writeFileSync(proposalPath, readFileSync(proposalPath, "utf8").replaceAll("\n", "\r\n"));
      expect((await port.getInboxProposal(proposal.ref.id))?.revision).toBe(proposal.revision);
      const approval = await knowledgeApproval(port, proposal, "crlf_update_finish");
      expect(Buffer.byteLength(JSON.stringify(approval), "utf8")).toBeLessThanOrEqual(64 * 1024);
      const targetChange = approval.preview.changes.find((change) => change.path === target.location.path)!;
      expect(targetChange.diff).toContain("Carriage returns are displayed as \\r; literal backslashes as \\\\ below.");
      expect(targetChange.diff).toContain("Literal \\\\r stays literal.\\r");
      expect(targetChange.diff).toContain("literal \\\\r remains text.");
      expect(targetChange.diff).not.toContain("\r");
      expect(approval.preview.changes.find((change) => change.path === target.location.path)?.beforeRevision)
        .toBe(hash(original));
      expect(approval.preview.changes.find((change) => change.path === ".mex/events/operations.jsonl")?.beforeRevision)
        .toBe(hash("\r\n"));
      await harness.armCrash("approve.after-wiki");
      await expect(port.applyInbox(roundTrip(approval))).rejects.toBeDefined();
      const published = readFileSync(path);
      const publishedAudit = readFileSync(auditPath);
      expect(published.toString("utf8")).toContain("Reviewed correction of CRLF context; literal \\r remains text.");
      expect(approval.preview.changes.find((change) => change.path === target.location.path)?.afterRevision)
        .toBe(hash(published));
      expect(publishedAudit.subarray(0, 2).toString("utf8")).toBe("\r\n");
      port = await harness.restart() as unknown as KnowledgeInboxPort;
      expect((await port.applyInbox(roundTrip(approval))).applied).toBe(true);
      expect((await port.applyInbox(roundTrip(approval))).idempotentReplay).toBe(true);
      expect((await port.getInboxProposal(proposal.ref.id))?.state).toBe("approved");
      expect(readFileSync(path)).toEqual(published);
      expect(readFileSync(auditPath)).toEqual(publishedAudit);
    } finally { await harness.close(); }
  });

  it.each(TEAM_INBOX_KNOWLEDGE_KINDS)("creates a %s with proposal attribution and every evidence kind", async (entityKind) => {
    const harness = await RepositoryInboxSpecHarness.open("empty");
    try {
      const port = harness.port as unknown as KnowledgeInboxPort;
      const input = knowledgeInput(entityKind);
      const proposal = await publishKnowledge(port, input, `create_${entityKind}`);
      const approval = await knowledgeApproval(port, proposal, `approve_${entityKind}`);
      const id = knowledgePurpose(approval, "spec-entity");
      const relative = entityKind === "pattern" ? `.mex/patterns/${id}.md` : `.mex/context/${entityKind}-${id}.md`;
      expect(approval.preview.changes.some((change) => change.path === relative)).toBe(true);
      expect(existsSync(join(harness.root, relative))).toBe(false);
      const result = await port.applyInbox(roundTrip(approval));
      expect(result.events.map((event) => event.action)).toEqual(["inbox.approved"]);
      expect((await port.getInboxProposal(proposal.ref.id))?.state).toBe("approved");
      expect(await port.listInboxProposals({ entityKinds: [entityKind], changeKinds: ["knowledge.create"] })).toMatchObject({ items: [{ ref: { id: proposal.ref.id } }] });
      const wiki = createRepositoryWikiPort(harness.root);
      await wiki.rebuildIndex();
      const entity = await wiki.getEntity(id);
      expect(entity).toMatchObject({ ref: { kind: entityKind }, title: input.change.kind === "knowledge.create" ? input.change.title : "", provenance: { kind: "human", id: MEMBER_ID }, groundings: [{ state: "ungrounded", health: "unverified" }] });
      expect(entity?.sources).toHaveLength(input.evidence.length + 1);
      expect(entity?.sources[0]).toMatchObject({ type: "document", ref: proposal.sourcePath, note: input.rationale, metadata: { proposalId: proposal.ref.id, author: ACTOR, approvedBy: ACTOR } });
      expect(entity?.sources.slice(1).map((source) => source.metadata?.evidence)).toEqual(input.evidence);
      const canonical = readFileSync(join(harness.root, relative), "utf8");
      expect(canonical).not.toContain("grounds_to:");
      const restarted = await harness.restart() as unknown as KnowledgeInboxPort;
      expect((await restarted.applyInbox(roundTrip(approval))).idempotentReplay).toBe(true);
      expect(readFileSync(join(harness.root, relative), "utf8")).toBe(canonical);
    } finally { await harness.close(); }
  });

  it("corrects an existing section while preserving its neighbors, original sources, provenance, and grounding", async () => {
    const harness = await RepositoryInboxSpecHarness.open("empty");
    try {
      const path = join(harness.root, `.mex/context/${NON_SPEC_ID}.md`);
      const sectionId = "mx_01J00000000000000000000020";
      const neighbor = "<!-- mex:entity\nid: mx_01J00000000000000000000021\ntype: guide\nstatus: promoted\nrevision: 1\n-->\n## Neighbor\n\nKeep this exact neighboring body.\n";
      const section = `<!-- mex:entity\nid: ${sectionId}\ntype: convention\nstatus: promoted\nrevision: 1\nprovenance:\n  createdBy:\n    kind: human\n    id: original-author\n  createdAt: ${NOW}\nsources:\n  - type: manual\n    note: Original source\ngrounds_to:\n  - node: function:1234567890abcdef\n    fingerprint: mh:4:12345678\n    bodyHash: ${"a".repeat(64)}\n-->\n## Existing convention\n\nPrevious text.\n\n`;
      const original = readFileSync(path, "utf8");
      writeFileSync(path, `${original}\n${section}${neighbor}`);
      await harness.refreshWikiIndex();
      const wiki = createRepositoryWikiPort(harness.root);
      const before = (await wiki.getEntity(sectionId))!;
      const port = harness.port as unknown as KnowledgeInboxPort;
      const input: KnowledgeDraftInput = { ...knowledgeInput("convention"), change: { kind: "knowledge.update", target: { id: sectionId, kind: "convention", title: before.title }, patch: { body: "Corrected convention text." } }, targetRevisions: [entityExpectation(before)] };
      const proposal = await publishKnowledge(port, input, "correct_section");
      const approval = await knowledgeApproval(port, proposal, "approve_section");
      await port.applyInbox(roundTrip(approval));
      const afterBytes = readFileSync(path, "utf8");
      expect(afterBytes.startsWith(`${original}\n`)).toBe(true);
      expect(afterBytes.endsWith(neighbor)).toBe(true);
      await wiki.rebuildIndex();
      const after = (await wiki.getEntity(sectionId))!;
      expect(after.body).toContain("Corrected convention text.");
      expect(after.version.semanticRevision).toBe(before.version.semanticRevision + 1);
      expect(after.provenance).toEqual(before.provenance);
      expect(after.groundings.map((item) => item.grounding)).toEqual(before.groundings.map((item) => item.grounding));
      expect(after.sources[0]).toEqual(before.sources[0]);
      expect(after.sources.slice(1)).toHaveLength(input.evidence.length + 1);
      expect(afterBytes).toContain(`bodyHash: ${"a".repeat(64)}`);
    } finally { await harness.close(); }
  });

  it("rejects a changed approval target, then marks stale, repairs and approves its new exact revision", async () => {
    const harness = await RepositoryInboxSpecHarness.open("empty");
    try {
      const port = harness.port as unknown as KnowledgeInboxPort;
      const wiki = createRepositoryWikiPort(harness.root);
      const target = (await wiki.getEntity(NON_SPEC_ID))!;
      const input: KnowledgeDraftInput = { ...knowledgeInput("decision"), change: { kind: "knowledge.update", target: { id: target.ref.id, kind: "decision", title: target.title }, patch: { body: "Reviewed correction." } }, targetRevisions: [entityExpectation(target)] };
      const proposal = await publishKnowledge(port, input, "stale_target");
      const approval = await knowledgeApproval(port, proposal, "stale_approve");
      const path = join(harness.root, target.location.path);
      writeFileSync(path, readFileSync(path, "utf8").replace("revision: 1", "revision: 2") + "\nAnother author changed this first.\n");
      await wiki.rebuildIndex();
      await expect(port.applyInbox(roundTrip(approval))).rejects.toMatchObject({ problem: { code: "REVISION_CONFLICT" } });
      const stale = await port.previewInbox({ operationId: "mark_knowledge_stale", action: { kind: "inbox.mark-stale", proposalId: proposal.ref.id, rationale: "Target changed." }, expectedRevisions: [{ target: { kind: "artifact", path: proposal.sourcePath }, revision: proposal.revision }] });
      await port.applyInbox(roundTrip(stale));
      const staleProposal = (await port.getInboxProposal(proposal.ref.id))!;
      expect(staleProposal.state).toBe("stale");
      const current = (await wiki.getEntity(NON_SPEC_ID))!;
      const repair = await port.previewInbox({ operationId: "repair_knowledge", action: { kind: "inbox.repair", proposalId: proposal.ref.id, replacement: { ...input, targetRevisions: [entityExpectation(current)] } }, expectedRevisions: [{ target: { kind: "artifact", path: staleProposal.sourcePath }, revision: staleProposal.revision }] });
      await port.applyInbox(roundTrip(repair));
      const repaired = (await port.getInboxProposal(proposal.ref.id))!;
      expect(repaired.state).toBe("pending");
      await port.applyInbox(await knowledgeApproval(port, repaired, "approve_repaired"));
      expect(readFileSync(path, "utf8")).toContain("Reviewed correction.");
    } finally { await harness.close(); }
  });

  it("revalidates a new pattern destination after preview and refuses an escaping directory", async () => {
    const harness = await RepositoryInboxSpecHarness.open("empty");
    try {
      const port = harness.port as unknown as KnowledgeInboxPort;
      const proposal = await publishKnowledge(port, knowledgeInput("pattern"), "pattern_containment");
      const approval = await knowledgeApproval(port, proposal, "approve_pattern_containment");
      const directory = join(harness.root, ".mex/patterns");
      expect(existsSync(directory)).toBe(false);
      const outside = join(harness.outsideRoot, "pattern-destination");
      mkdirSync(outside);
      symlinkSync(outside, directory);
      await expect(port.applyInbox(roundTrip(approval))).rejects.toMatchObject({ problem: { code: expect.any(String) } });
      expect(readdirSync(outside)).toEqual([]);
      expect((await port.getInboxProposal(proposal.ref.id))?.state).toBe("pending");
    } finally { await harness.close(); }
  });

  it.each(["approve.after-wiki", "approve.after-proposal", "approve.after-activity"] as const)("recovers knowledge approval after %s without duplicate records or attribution", async (phase) => {
    const harness = await RepositoryInboxSpecHarness.open("empty");
    try {
      const port = harness.port as unknown as KnowledgeInboxPort;
      const proposal = await publishKnowledge(port, knowledgeInput("pattern"), `recover_${phase}`);
      const approval = await knowledgeApproval(port, proposal, `finish_${phase}`);
      await harness.armCrash(phase);
      await expect(port.applyInbox(roundTrip(approval))).rejects.toBeDefined();
      const restarted = await harness.restart() as unknown as KnowledgeInboxPort;
      const result = await restarted.applyInbox(roundTrip(approval));
      expect(result.applied).toBe(true);
      const path = join(harness.root, `.mex/patterns/${knowledgePurpose(approval, "spec-entity")}.md`);
      const canonical = readFileSync(path, "utf8");
      expect((canonical.match(/proposalId:/gu) ?? [])).toHaveLength(1);
      expect((await restarted.getInboxProposal(proposal.ref.id))?.state).toBe("approved");
      expect((await restarted.applyInbox(roundTrip(approval))).idempotentReplay).toBe(true);
      expect(readFileSync(path, "utf8")).toBe(canonical);
    } finally { await harness.close(); }
  });

  // Recovery plus two real Wiki corrections exceeds the ordinary 30s Windows guard.
  it.each(["approve.after-wiki", "approve.after-proposal"] as const)("recovers a knowledge correction after %s and retains each subsequent proposal source", { timeout: 120_000 }, async (phase) => {
    const harness = await RepositoryInboxSpecHarness.open("empty");
    try {
      let port = harness.port as unknown as KnowledgeInboxPort;
      const wiki = createRepositoryWikiPort(harness.root);
      const original = (await wiki.getEntity(NON_SPEC_ID))!;
      const input: KnowledgeDraftInput = { ...knowledgeInput("decision"), change: { kind: "knowledge.update", target: { id: original.ref.id, kind: "decision", title: original.title }, patch: { body: "First reviewed correction." } }, targetRevisions: [entityExpectation(original)] };
      const firstProposal = await publishKnowledge(port, input, `update_${phase}`);
      const approval = await knowledgeApproval(port, firstProposal, `update_finish_${phase}`);
      await harness.armCrash(phase);
      await expect(port.applyInbox(roundTrip(approval))).rejects.toBeDefined();
      port = await harness.restart() as unknown as KnowledgeInboxPort;
      expect((await port.applyInbox(roundTrip(approval))).applied).toBe(true);
      expect((await port.applyInbox(roundTrip(approval))).idempotentReplay).toBe(true);
      await wiki.rebuildIndex();
      const current = (await wiki.getEntity(NON_SPEC_ID))!;
      const secondInput: KnowledgeDraftInput = { ...input, change: { kind: "knowledge.update", target: { id: current.ref.id, kind: "decision", title: current.title }, patch: { body: "Second reviewed correction." } }, targetRevisions: [entityExpectation(current)] };
      const secondProposal = await publishKnowledge(port, secondInput, `second_${phase}`);
      await port.applyInbox(await knowledgeApproval(port, secondProposal, `second_finish_${phase}`));
      await wiki.rebuildIndex();
      const final = (await wiki.getEntity(NON_SPEC_ID))!;
      expect(final.body).toContain("Second reviewed correction.");
      expect(final.version.semanticRevision).toBe(original.version.semanticRevision + 2);
      expect(final.sources.filter((source) => source.metadata?.proposalId !== undefined).map((source) => source.ref)).toEqual([firstProposal.sourcePath, secondProposal.sourcePath]);
      expect(final.sources[0]).toEqual(original.sources[0]);
      expect(final.provenance).toEqual(original.provenance);
    } finally { await harness.close(); }
  });
});

function knowledgeInput(entityKind: (typeof TEAM_INBOX_KNOWLEDGE_KINDS)[number]): KnowledgeDraftInput {
  return { change: { kind: "knowledge.create", entityKind, title: `Reviewed ${entityKind}`, body: "Keep repository knowledge explicit.", status: "promoted" }, rationale: "Preserve the decision and evidence for future work.", evidence: [
    { kind: "entity", entity: { id: NON_SPEC_ID, kind: "decision", title: "Existing decision" } },
    { kind: "code", code: { kind: "symbol", symbolId: "function:1234567890abcdef", fingerprint: "mh:4:12345678" } },
    { kind: "commit", hash: "a".repeat(40) },
    { kind: "file", path: "src/index.ts" },
    { kind: "external", uri: "https://example.test/evidence", label: "Reference" },
    { kind: "manual", note: "A specific reported constraint." },
  ], targetRevisions: [] };
}

async function publishKnowledge(port: KnowledgeInboxPort, input: KnowledgeDraftInput, prefix: string): Promise<KnowledgeProposal> {
  const save = await port.previewInbox({ operationId: `${prefix}_save`, action: { kind: "inbox.draft.save", draft: input }, expectedRevisions: [] });
  await port.applyInbox(roundTrip(save));
  const draft = (await port.getInboxDraft(knowledgePurpose(save, "inbox-draft")))!;
  expect(draft.input).toEqual(input);
  const publish = await port.previewInbox({ operationId: `${prefix}_publish`, action: { kind: "inbox.publish", draftId: draft.id }, expectedRevisions: [{ target: { kind: "local", namespace: "inbox-draft", id: draft.id }, revision: draft.revision }] });
  await port.applyInbox(roundTrip(publish));
  expect(await port.getInboxDraft(draft.id)).toBeNull();
  return (await port.getInboxProposal(knowledgePurpose(publish, "proposal")))!;
}

function knowledgeApproval(port: KnowledgeInboxPort, proposal: KnowledgeProposal, operationId: string): Promise<KnowledgeEnvelope> {
  return port.previewInbox({ operationId, action: { kind: "inbox.approve", proposalId: proposal.ref.id }, expectedRevisions: [{ target: { kind: "artifact", path: proposal.sourcePath }, revision: proposal.revision }] });
}

function knowledgePurpose(envelope: KnowledgeEnvelope, purpose: string): string {
  const item = envelope.receipt.purposeIds.find((entry) => entry.purpose === purpose);
  if (item === undefined) throw new Error(`Missing ${purpose} receipt identity.`);
  return item.id;
}
