import { DiagramRepository } from "../../src/statechart/repository.js";
import { exampleArtifact } from "../../src/statechart/fixtures.js";
import { renameSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  activityArtifactPath,
  memberArtifactPath,
  serializeActivityArtifact,
  serializeMemberArtifact,
} from "../../src/team/artifacts/codecs.js";
import { atomicCreateArtifact } from "../../src/team/artifacts/filesystem.js";
import {
  InboxProposalRepository,
  RelayRepository,
} from "../../src/team/artifacts/workflow-repositories.js";
import {
  inboxDraftInputFromProduct,
  productDraftProjection,
  productProposalProjection,
} from "../../src/team/inbox/spec-authoring.js";
import { TeamLocalState } from "../../src/team/local-state/index.js";
import { normalizeRelayProductDraftInput } from "../../src/team/relay/handoff.js";
import type { JsonValue } from "../../src/team/contracts/shared.js";
import type {
  TeamInboxSpecDraftInput,
} from "../../src/team/contracts/workflow.js";

const FIXED_TIME = "2026-08-01T00:00:00.000Z";
const FIXTURE_ACTOR = Object.freeze({
  kind: "git" as const,
  name: "MEX Release Benchmark",
  email: "release-benchmark@example.invalid",
});

const RELAY_PUBLISHED_AT = "2026-08-01T00:00:00.000Z";
const RELAY_SUMMARY = "Release benchmark published Relay handoff";
const RELAY_DRAFT_SUMMARY = "Release benchmark local Relay draft";

const [
  mode,
  rootValue,
  scaffoldId,
  draftId,
  proposalId,
  specId,
  specPathValue,
  publisherMemberId,
  recipientMemberId,
  relayDraftId,
  relayId,
  relayEventId,
] = process.argv.slice(2);
if (
  (mode !== "canonical" && mode !== "local")
  || !rootValue
  || !scaffoldId
  || !draftId
  || !proposalId
  || !specId
  || !specPathValue
  || !publisherMemberId
  || !recipientMemberId
  || !relayDraftId
  || !relayId
  || !relayEventId
) {
  throw new Error("Usage: seed-inbox-fixture <canonical|local> <root> <scaffold-id> <draft-id> <proposal-id> <spec-id> <spec-path> <publisher-member-id> <recipient-member-id> <relay-draft-id> <relay-id> <relay-event-id>");
}

const root = resolve(rootValue);
if (specPathValue !== `.mex/specs/${specId}.md`) {
  throw new Error("The release Inbox fixture Spec path must match its fixed entity ID.");
}
const specPath = join(root, specPathValue);
const specRevision = createHash("sha256").update(readFileSync(specPath)).digest("hex");
const publisher = Object.freeze({
  kind: "member" as const,
  memberId: publisherMemberId,
  displayName: "Release Benchmark Publisher",
});
const recipient = Object.freeze({
  kind: "member" as const,
  memberId: recipientMemberId,
  displayName: "MEX Release Benchmark",
});
const proposalInput: TeamInboxSpecDraftInput = {
  change: {
    kind: "spec.update",
    target: {
      id: specId,
      kind: "spec",
    },
    patch: {
      title: "Release benchmark pending Spec update",
      summary: "A deterministic pending proposal exercised by the release gate.",
      body: "This exact pending change remains reviewable and is never applied by the benchmark.",
    },
  },
  rationale: "Review the deterministic release benchmark Spec update before publication.",
  evidence: [{ kind: "manual", note: "Pinned release benchmark fixture" }],
  targetRevisions: [{
    target: { kind: "entity", id: specId },
    revision: specRevision,
    semanticRevision: 1,
  }],
};

const localDraftInput: TeamInboxSpecDraftInput = {
  change: {
    kind: "spec.create",
    entityKind: "requirement",
    title: "Release benchmark local draft Requirement",
    summary: "One deterministic checkout-local Inbox draft.",
    body: "The draft stays local until an explicit publish action creates canonical proposal content.",
    status: "in_flight",
  },
  rationale: "Keep one bounded local draft available for the Inbox release workbench.",
  evidence: [{ kind: "manual", note: "Pinned release benchmark fixture" }],
  targetRevisions: [],
};

const relayDraftInput = normalizeRelayProductDraftInput({
  recipients: [recipient],
  summary: RELAY_DRAFT_SUMMARY,
});

if (mode === "canonical") {
  const diagrams = new DiagramRepository(root, () => new Date(FIXED_TIME));
  const diagramPreview = await diagrams.register(exampleArtifact("incomplete"));
  const diagramDetail = diagrams.get("preview", diagramPreview.id);
  const diagramSaved = await diagrams.applySave(diagrams.previewSave(diagramPreview.id, diagramDetail.revision).token);
  renameSync(join(root, ".mex/diagrams", diagramSaved.id), join(root, ".mex/diagrams", "d".repeat(32)));
  rmSync(join(root, ".mex/local/diagrams"), { recursive: true });
  for (const member of [
    {
      id: publisherMemberId,
      displayName: publisher.displayName,
      gitAliases: [{
        name: "Release Benchmark Publisher",
        email: "relay-publisher@example.invalid",
      }],
    },
    {
      id: recipientMemberId,
      displayName: recipient.displayName,
      gitAliases: [{
        name: FIXTURE_ACTOR.name,
        email: FIXTURE_ACTOR.email,
      }],
    },
  ]) {
    const path = memberArtifactPath(member.id);
    atomicCreateArtifact(root, path, serializeMemberArtifact({
      ...member,
      active: true,
    }));
  }

  const stored = inboxDraftInputFromProduct(
    proposalInput,
    "release_benchmark_pending_proposal",
  );
  const proposals = new InboxProposalRepository<JsonValue>(root, {
    idFactory: () => proposalId,
  });
  const preview = await proposals.previewCreate({
    id: proposalId,
    author: FIXTURE_ACTOR,
    rationale: stored.rationale,
    evidence: stored.evidence,
    request: stored.request,
    targetRevisions: stored.targetRevisions,
  });
  const applied = await proposals.apply(preview, preview.previewRevision);
  const projection = productProposalProjection(
    applied.artifact,
  );
  const page = await proposals.list({ limit: 100, states: ["pending"] });
  if (
    page.items.length !== 1
    || page.nextCursor !== null
    || page.truncated !== false
    || page.sourceTruncated !== false
    || page.items[0]?.ref.id !== proposalId
    || page.items[0]?.state !== "pending"
    || page.items[0]?.sourcePath !== `.mex/inbox/${proposalId}.md`
    || projection === null
    || projection === undefined
    || projection.ref.id !== proposalId
    || projection.state !== "pending"
    || projection.title !== "Release benchmark pending Spec update"
  ) {
    throw new Error("The release proposal fixture does not round-trip through the production projection.");
  }


  const relays = new RelayRepository(root, { idFactory: () => relayId });
  const publishedRepoState = {
    branch: "benchmark",
    head: null,
    dirty: false,
    observedAt: RELAY_PUBLISHED_AT,
  } as const;
  const relayPreview = await relays.previewCreate({
    schemaVersion: 3,
    sender: publisher,
    recipients: [recipient],
    summary: RELAY_SUMMARY,
    completed: ["Prepared the deterministic Relay fixture."],
    inProgress: ["Measure the real Relay workbench."],
    decisions: [],
    blockers: [],
    unresolvedQuestions: [],
    changedFiles: ["src/module-0000.ts"],
    code: [{ kind: "file", path: "src/module-0000.ts" }],
    evidence: [{ kind: "manual", note: "Pinned release benchmark fixture" }],
    nextActions: ["Take the handoff from the For you queue."],
    publishedAt: RELAY_PUBLISHED_AT,
    publishedRepoState,
  });
  const relay = (await relays.apply(relayPreview, relayPreview.previewRevision)).artifact;
  const relayPage = await relays.list({ limit: 100, states: ["published"] });
  if (
    relay.schemaVersion !== 3
    || relay.ref.id !== relayId
    || relay.summary !== RELAY_SUMMARY
    || relay.publishedAt !== RELAY_PUBLISHED_AT
    || relay.workstream !== undefined
    || JSON.stringify(relay.publishedRepoState) !== JSON.stringify(publishedRepoState)
    || relayPage.items.length !== 1
    || relayPage.items[0]?.ref.id !== relayId
  ) {
    throw new Error("The release Relay fixture does not round-trip through the production repository.");
  }
  const activity = {
    schemaVersion: 1 as const,
    id: relayEventId,
    timestamp: RELAY_PUBLISHED_AT,
    actor: publisher,
    action: "relay.published",
    subjects: [{ kind: "entity" as const, entity: relay.ref }],
    repoState: publishedRepoState,
  };
  atomicCreateArtifact(
    root,
    activityArtifactPath(activity),
    serializeActivityArtifact(activity),
  );
} else {
  const local = new TeamLocalState({
    projectRoot: root,
    scaffoldId,
    now: () => FIXED_TIME,
  });
  const stored = local.saveLocalDraft({
    id: draftId,
    kind: "inbox",
    payload: inboxDraftInputFromProduct(
      localDraftInput,
      "release_benchmark_local_draft",
    ),
    expectedRevision: null,
    updatedAt: FIXED_TIME,
  });
  const projection = productDraftProjection({
    id: stored.id,
    kind: "inbox",
    revision: stored.revision,
    updatedAt: stored.updatedAt,
    ...stored.payload,
  });
  const page = local.listLocalDrafts({ kind: "inbox", limit: 100 });
  if (
    page.items.length !== 1
    || page.nextCursor !== null
    || projection?.id !== draftId
    || projection.title !== "Release benchmark local draft Requirement"
  ) {
    throw new Error("The release draft fixture does not round-trip through the production projection.");
  }


  const storedRelay = local.saveLocalDraft({
    id: relayDraftId,
    kind: "relay",
    payload: relayDraftInput,
    expectedRevision: null,
    updatedAt: FIXED_TIME,
  });
  const relayPage = local.listLocalDrafts({ kind: "relay", limit: 100 });
  if (
    storedRelay.id !== relayDraftId
    || storedRelay.payload.summary !== RELAY_DRAFT_SUMMARY
    || relayPage.items.length !== 1
    || relayPage.items[0]?.id !== relayDraftId
  ) {
    throw new Error("The release Relay draft fixture does not round-trip through local state.");
  }
}
