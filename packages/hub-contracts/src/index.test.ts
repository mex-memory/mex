import { describe, expect, it } from "vitest";
import * as IdRuntime from "./ids.js";
import { OverviewActivityPanelSchema } from "./overview.js";
import * as RelayRuntime from "./relay.js";
import {
  ActivityRequestSchema,
  ActivityResponseSchema,
  BootstrapRequestSchema,
  CodeWorkspaceRequestSchema,
  CodeWorkspaceResponseSchema,
  CodeKnowledgeResponseSchema,
  HealthResponseSchema,
  GraphSymbolIdSchema,
  HUB_LIMITS,
  HomeResponseSchema,
  HubCapabilitiesSchema,
  HubJobIdSchema,
  InboxDraftListResponseSchema,
  InboxEvidenceRefSchema,
  InboxOperationPreviewRequestSchema,
  InboxOperationPreviewResponseSchema,
  InboxProposalIdSchema,
  InboxProposalDetailSchema,
  RelayDetailSchema,
  RelayDraftDetailSchema,
  RelayDraftIdSchema,
  RelayDraftInputSchema,
  RelayDraftListResponseSchema,
  RelayDraftSummarySchema,
  RelayIdSchema,
  RelayListResponseSchema,
  RelayOperationApplyRequestSchema,
  RelayOperationApplyResponseSchema,
  RelayOperationPreviewRequestSchema,
  RelayOperationPreviewResponseSchema,
  RelaySummarySchema,
  SearchRequestSchema,
  SearchResponseSchema,
  SpecDetailResponseSchema,
  SpecListRequestSchema,
  SpecListResponseSchema,
  TeamCurrentActorResponseSchema,
  TeamActivityEventSchema,
  TeamMemberIdSchema,
  TeamMemberListRequestSchema,
  TeamMemberListResponseSchema,
  TeamMemberSchema,
  TeamOperationApplyResponseSchema,
  TeamOperationPreviewRequestSchema,
  TeamOperationPreviewResponseSchema,
  TeamWorkstreamListRequestSchema,
  TeamWorkstreamListResponseSchema,
  TeamWorkstreamSchema,
  WikiEntityDetailResponseSchema,
  WikiEntityIdSchema,
  WikiEntityListRequestSchema,
  WikiEntityListResponseSchema,
  WikiGraphResponseSchema,
  WikiGroundedCodeResponseSchema,
  WikiRelationsRequestSchema,
} from "./index.js";

describe("Hub API contracts", () => {
  it("keeps the private ID and Relay runtime entries on the canonical schema instances", () => {
    expect(IdRuntime.TeamMemberIdSchema).toBe(TeamMemberIdSchema);
    expect(IdRuntime.RelayIdSchema).toBe(RelayIdSchema);
    expect(IdRuntime.InboxProposalIdSchema).toBe(InboxProposalIdSchema);
    expect(IdRuntime.GraphSymbolIdSchema).toBe(GraphSymbolIdSchema);
    expect(IdRuntime.WikiEntityIdSchema).toBe(WikiEntityIdSchema);
    expect(RelayRuntime.RelayDetailSchema).toBe(RelayDetailSchema);
    expect(RelayRuntime.RelayDraftDetailSchema).toBe(RelayDraftDetailSchema);
    expect(RelayRuntime.RelayDraftIdSchema).toBe(RelayDraftIdSchema);
    expect(RelayRuntime.RelayDraftListResponseSchema).toBe(RelayDraftListResponseSchema);
    expect(RelayRuntime.RelayIdSchema).toBe(RelayIdSchema);
    expect(RelayRuntime.RelayListResponseSchema).toBe(RelayListResponseSchema);
    expect(RelayRuntime.RelayOperationApplyResponseSchema).toBe(RelayOperationApplyResponseSchema);
    expect(RelayRuntime.RelayOperationPreviewResponseSchema).toBe(RelayOperationPreviewResponseSchema);
    expect(RelayRuntime.RelayIdSchema).toBe(IdRuntime.RelayIdSchema);
    expect(IdRuntime.RelayIdSchema.parse("relay_01000000000000000000000001"))
      .toBe("relay_01000000000000000000000001");
    expect(IdRuntime.RelayIdSchema.safeParse("relay-not-portable").success).toBe(false);
    expect(IdRuntime.TeamMemberIdSchema.parse("member_01ARZ3NDEKTSV4RRFFQ69G5FAV"))
      .toBe("member_01ARZ3NDEKTSV4RRFFQ69G5FAV");
    expect(IdRuntime.TeamMemberIdSchema.safeParse("member-not-portable").success).toBe(false);
    expect(IdRuntime.InboxProposalIdSchema.parse("proposal_01000000000000000000000001"))
      .toBe("proposal_01000000000000000000000001");
    expect(IdRuntime.GraphSymbolIdSchema.parse("symbol:router.handle"))
      .toBe("symbol:router.handle");
    expect(IdRuntime.WikiEntityIdSchema.parse("mx_01000000000000000000000001"))
      .toBe("mx_01000000000000000000000001");
  });

  it("rejects unknown request fields and oversized queries", () => {
    expect(BootstrapRequestSchema.safeParse({
      token: Buffer.alloc(32).toString("base64url"),
      unexpected: true,
    }).success).toBe(false);
    expect(SearchRequestSchema.safeParse({
      q: "x".repeat(HUB_LIMITS.maxQueryCharacters + 1),
    }).success).toBe(false);
  });

  it("applies bounded page defaults", () => {
    expect(SearchRequestSchema.parse({ q: "memory" })).toEqual({
      q: "memory",
      limit: HUB_LIMITS.defaultPageSize,
    });
  });

  it("locks Relay draft IDs to the 128-byte ASCII product grammar", () => {
    const maximumDraftId = "d".repeat(128);
    const oversizedDraftId = "d".repeat(129);
    const revision = "a".repeat(64);
    const request = (draftId: string) => ({
      operationId: "relay_contract_draft_id_boundary",
      action: { kind: "relay.draft.delete" as const, draftId },
      expectedRevisions: [{
        target: { kind: "local" as const, namespace: "relay-draft" as const, id: draftId },
        revision,
      }],
    });

    expect(RelayDraftIdSchema.parse(maximumDraftId)).toBe(maximumDraftId);
    expect(RelayOperationPreviewRequestSchema.parse(request(maximumDraftId)))
      .toEqual(request(maximumDraftId));
    expect(RelayDraftIdSchema.safeParse(oversizedDraftId).success).toBe(false);
    expect(RelayOperationPreviewRequestSchema.safeParse(request(oversizedDraftId)).success)
      .toBe(false);
  });

  it("locks sparse standalone Relay drafts, all evidence variants, and v1/v2/v3 lifecycle projections", () => {
    const revision = "a".repeat(64);
    const member = { kind: "member" as const, memberId: "member_01ARZ3NDEKTSV4RRFFQ69G5FAV", displayName: "Ada" };
    const workstream = { kind: "workstream" as const, id: "ws_01ARZ3NDEKTSV4RRFFQ69G5FAV", title: "Relay" };
    const draft = {
      recipients: [member],
      summary: "A complete Relay handoff.",
      completed: ["Captured the characterization."],
      inProgress: ["Reviewing the final gate."],
      decisions: [{ id: "decision-1", kind: "decision", title: "Keep the gate pinned" }],
      blockers: ["Windows validation remains."],
      unresolvedQuestions: ["Does the packed install preserve the digest?"],
      changedFiles: ["src/relay.ts"],
      code: [{ kind: "symbol" as const, symbolId: "relay.apply", fingerprint: "symbol-fingerprint" }],
      evidence: [
        { kind: "entity" as const, entity: { id: "decision-1", kind: "decision", title: "Pinned gate" } },
        { kind: "code" as const, code: { kind: "file" as const, path: "src/relay.ts", fingerprint: "file-fingerprint" } },
        { kind: "file" as const, path: "src/relay.ts" },
        { kind: "commit" as const, hash: "b".repeat(40) },
        { kind: "external" as const, uri: "https://example.test/evidence", label: "Run" },
        { kind: "manual" as const, note: "Observed locally." },
      ],
      nextActions: ["Run the final gate."],
    };
    expect(RelayDraftInputSchema.parse(draft)).toEqual(draft);
    expect(RelayDraftInputSchema.parse({
      recipients: [member],
      summary: "A sparse standalone handoff.",
    })).toEqual({
      recipients: [member],
      summary: "A sparse standalone handoff.",
      completed: [],
      inProgress: [],
      decisions: [],
      blockers: [],
      unresolvedQuestions: [],
      changedFiles: [],
      code: [],
      evidence: [],
      nextActions: [],
    });
    expect(RelayDraftInputSchema.safeParse({ ...draft, workstream }).success).toBe(false);
    expect(RelayDraftInputSchema.safeParse({
      ...draft,
      recipients: [{ ...member, displayName: "M".repeat(512) }],
    }).success).toBe(true);
    expect(RelayDraftInputSchema.safeParse({
      ...draft,
      recipients: [{ ...member, displayName: "M".repeat(513) }],
    }).success).toBe(false);
    for (const displayName of ["Relay\u0085Member", "Relay\u2028Member", "Relay\u2029Member"]) {
      expect(RelayDraftInputSchema.safeParse({
        ...draft,
        recipients: [{ ...member, displayName }],
      }).success, JSON.stringify(displayName)).toBe(false);
    }
    for (const malformed of [
      { ...draft, completed: [draft.completed[0], draft.completed[0]] },
      { ...draft, inProgress: [draft.inProgress[0], draft.inProgress[0]] },
      { ...draft, blockers: [draft.blockers[0], draft.blockers[0]] },
      { ...draft, unresolvedQuestions: [draft.unresolvedQuestions[0], draft.unresolvedQuestions[0]] },
      { ...draft, nextActions: [draft.nextActions[0], draft.nextActions[0]] },
      { ...draft, decisions: [draft.decisions[0], { ...draft.decisions[0], title: "Renamed duplicate" }] },
      { ...draft, changedFiles: [draft.changedFiles[0], draft.changedFiles[0]] },
      { ...draft, code: [draft.code[0], { ...draft.code[0] }] },
    ]) {
      expect(RelayDraftInputSchema.safeParse(malformed).success).toBe(false);
    }
    expect(RelayDraftInputSchema.safeParse({
      ...draft,
      evidence: [draft.evidence[0], draft.evidence[0]],
    }).success).toBe(true);
    expect(RelayDraftInputSchema.safeParse({ ...draft, recipients: [member, member] }).success).toBe(false);
    const translatedEvidence = [
      { kind: "entity" as const, entity: workstream },
      ...Array.from({ length: 64 }, (_, index) => ({
        kind: "manual" as const,
        note: `Legacy evidence ${index}`,
      })),
    ];
    expect(RelayDraftInputSchema.safeParse({
      ...draft,
      evidence: translatedEvidence,
    }).success).toBe(false);
    expect(RelayDraftInputSchema.safeParse({
      ...draft,
      evidence: translatedEvidence.map((item, index) => index === 0
        ? { kind: "manual" as const, note: "Not a translated Workstream" }
        : item),
    }).success).toBe(false);
    expect(RelayDraftSummarySchema.safeParse({
      id: "relay-draft-summary",
      revision,
      updatedAt: "2026-08-29T01:00:00.000Z",
      summary: draft.summary,
      recipients: [member, member],
    }).success).toBe(false);
    expect(RelayDraftInputSchema.safeParse({ ...draft, summary: "not\nsingle line" }).success).toBe(false);

    const save = {
      operationId: "relay_contract_save",
      action: { kind: "relay.draft.save" as const, draft },
      expectedRevisions: [],
    };
    expect(RelayOperationPreviewRequestSchema.parse(save)).toEqual(save);
    expect(RelayOperationPreviewRequestSchema.safeParse({
      ...save,
      action: { ...save.action, draft: { ...draft, evidence: translatedEvidence } },
    }).success).toBe(false);
    const migratedSave = {
      ...save,
      action: {
        ...save.action,
        draftId: "relay-migrated-draft",
        draft: { ...draft, evidence: translatedEvidence },
      },
      expectedRevisions: [{
        target: {
          kind: "local" as const,
          namespace: "relay-draft" as const,
          id: "relay-migrated-draft",
        },
        revision,
      }],
    };
    expect(RelayOperationPreviewRequestSchema.safeParse(migratedSave).success).toBe(true);
    expect(RelayOperationPreviewRequestSchema.safeParse({
      ...save,
      expectedRevisions: [{
        target: { kind: "artifact", path: ".mex/workstreams/ws_01ARZ3NDEKTSV4RRFFQ69G5FAV.md" },
        revision,
      }],
    }).success).toBe(false);

    const manualEvidence = Array.from({ length: 64 }, (_, index) => ({
      kind: "manual" as const,
      note: `Legacy ${index}:`,
    }));
    const rawNearLimit = {
      ...draft,
      workstream,
      evidence: manualEvidence,
    };
    const size = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
    let remaining = HUB_LIMITS.maxMutationBodyBytes - 8 - size(rawNearLimit);
    for (let index = 0; index < manualEvidence.length && remaining > 0; index += 1) {
      const addition = Math.min(remaining, 4_000 - manualEvidence[index]!.note.length);
      manualEvidence[index]!.note += "x".repeat(addition);
      remaining -= addition;
    }
    const translatedNearLimit = {
      ...draft,
      evidence: [{ kind: "entity" as const, entity: workstream }, ...manualEvidence],
    };
    expect(size(rawNearLimit)).toBeLessThanOrEqual(HUB_LIMITS.maxMutationBodyBytes);
    expect(size(translatedNearLimit)).toBeGreaterThan(HUB_LIMITS.maxMutationBodyBytes);
    expect(RelayDraftInputSchema.safeParse(translatedNearLimit).success).toBe(false);
    expect(RelayDraftDetailSchema.safeParse({
      id: "relay-near-limit-legacy",
      revision,
      updatedAt: "2026-08-29T01:00:00.000Z",
      summary: translatedNearLimit.summary,
      recipients: translatedNearLimit.recipients,
      input: translatedNearLimit,
    }).success).toBe(true);

    const relay = {
      schemaVersion: 2 as const,
      ref: { id: "relay_01000000000000000000000001", kind: "relay" as const, title: draft.summary },
      sourcePath: ".mex/relays/relay_01000000000000000000000001.md",
      revision,
      state: "closed" as const,
      sender: member,
      recipients: [member],
      workstream,
      summary: draft.summary,
      completed: draft.completed,
      inProgress: draft.inProgress,
      decisions: draft.decisions,
      blockers: draft.blockers,
      unresolvedQuestions: draft.unresolvedQuestions,
      changedFiles: draft.changedFiles,
      code: draft.code,
      evidence: draft.evidence,
      nextActions: draft.nextActions,
      diagnostics: [],
      diagnosticsTruncated: false,
      publishedAt: "2026-08-29T01:00:00.000Z",
      publishedRepoState: null,
      acknowledgedBy: member,
      acknowledgedAt: "2026-08-29T02:00:00.000Z",
      closedBy: member,
      closedAt: "2026-08-29T03:00:00.000Z",
    };
    expect(RelayDetailSchema.parse(relay)).toEqual(relay);
    expect(RelayDetailSchema.safeParse({ ...relay, acknowledgedAt: "2026-08-29T00:00:00.000Z" }).success).toBe(false);
    expect(RelayDetailSchema.safeParse({ ...relay, schemaVersion: 1 }).success).toBe(false);
    expect(RelayDetailSchema.safeParse({
      ...relay,
      schemaVersion: 1,
      publishedAt: null,
      publishedRepoState: null,
      diagnostics: [{
        code: "RELAY_LEGACY_PUBLICATION_TIME",
        severity: "warning",
        message: "One or more legacy schema-v1 Relays have no canonical publication timestamp.",
      }],
    }).success).toBe(true);

    const standaloneRelay = {
      ...relay,
      schemaVersion: 3 as const,
      workstream: null,
      publishedRepoState: {
        branch: "feature/relay-v3",
        head: "f".repeat(40),
        dirty: true,
        observedAt: "2026-08-29T01:00:00.000Z",
      },
    };
    expect(RelayDetailSchema.parse(standaloneRelay)).toEqual(standaloneRelay);
    expect(RelayDetailSchema.safeParse({
      ...standaloneRelay,
      workstream,
    }).success).toBe(false);
    expect(RelayDetailSchema.safeParse({
      ...standaloneRelay,
      publishedRepoState: null,
    }).success).toBe(false);
    expect(RelayDetailSchema.safeParse({
      ...standaloneRelay,
      evidence: translatedEvidence,
    }).success).toBe(true);
    expect(RelayDetailSchema.safeParse({
      ...relay,
      evidence: translatedEvidence,
    }).success).toBe(false);

    const legacyMember = { ...member, displayName: "M".repeat(201) };
    const legacyGit = {
      kind: "git" as const,
      name: "G".repeat(321),
      email: `${"e".repeat(310)}@example.test`,
    };
    const legacyRecipients = [
      legacyGit,
      ...Array.from({ length: 63 }, (_, index) => ({
        kind: "git" as const,
        name: `Legacy recipient ${index + 1}`,
        email: `legacy-${index + 1}@example.test`,
      })),
    ];
    const legacyPath = "src/legacy\u0085relay\u2028snapshot.ts";
    const legacyRelay = {
      ...relay,
      schemaVersion: 1 as const,
      state: "published" as const,
      sender: legacyMember,
      recipients: legacyRecipients,
      workstream: { kind: "workstream" as const, id: "historical-workstream", title: "Historical Relay" },
      changedFiles: [legacyPath],
      code: [{ kind: "file" as const, path: legacyPath }],
      evidence: [
        { kind: "file" as const, path: legacyPath },
        { kind: "code" as const, code: { kind: "file" as const, path: legacyPath } },
      ],
      diagnostics: [{
        code: "RELAY_LEGACY_PUBLICATION_TIME",
        severity: "warning" as const,
        message: "One or more legacy schema-v1 Relays have no canonical publication timestamp.",
      }],
      publishedAt: null,
      acknowledgedBy: null,
      acknowledgedAt: null,
      closedBy: null,
      closedAt: null,
    };
    const legacySummary = {
      schemaVersion: legacyRelay.schemaVersion,
      ref: legacyRelay.ref,
      sourcePath: legacyRelay.sourcePath,
      revision: legacyRelay.revision,
      state: legacyRelay.state,
      sender: legacyRelay.sender,
      recipients: legacyRelay.recipients,
      workstream: legacyRelay.workstream,
      summary: legacyRelay.summary,
      publishedAt: legacyRelay.publishedAt,
      publishedRepoState: legacyRelay.publishedRepoState,
      acknowledgedBy: legacyRelay.acknowledgedBy,
      acknowledgedAt: legacyRelay.acknowledgedAt,
      closedBy: legacyRelay.closedBy,
      closedAt: legacyRelay.closedAt,
    };
    expect(RelayDetailSchema.parse(legacyRelay)).toEqual(legacyRelay);
    expect(RelaySummarySchema.parse(legacySummary)).toEqual(legacySummary);
    expect(RelayDetailSchema.safeParse({ ...legacyRelay, sender: legacyGit }).success).toBe(true);
    expect(RelaySummarySchema.safeParse({ ...legacySummary, sender: legacyGit }).success).toBe(true);
    expect(RelayDetailSchema.safeParse({
      ...legacyRelay,
      recipients: [legacyGit, legacyGit],
    }).success).toBe(false);
    expect(RelaySummarySchema.safeParse({
      ...legacySummary,
      recipients: [legacyGit, legacyGit],
    }).success).toBe(false);
    expect(legacyRelay.recipients).toHaveLength(64);
    expect(legacyRelay.workstream.id).toBe("historical-workstream");
    expect(legacyRelay.changedFiles).toEqual([legacyPath]);
    for (const sender of [
      { ...legacyMember, displayName: "Legacy\u0085Member" },
      { ...legacyGit, name: "Legacy\u2028Git" },
      { ...legacyGit, email: "legacy\u2029@example.test" },
    ]) {
      expect(RelayDetailSchema.safeParse({ ...legacyRelay, sender }).success).toBe(false);
      expect(RelaySummarySchema.safeParse({ ...legacySummary, sender }).success).toBe(false);
    }
    for (const changedFiles of [["src/control\u001f.ts"], ["src/delete\u007f.ts"]]) {
      expect(RelayDetailSchema.safeParse({ ...legacyRelay, changedFiles }).success).toBe(false);
    }
    expect(RelayDetailSchema.safeParse({
      ...legacyRelay,
      schemaVersion: 2,
      publishedAt: "2026-08-29T01:00:00.000Z",
      diagnostics: [],
    }).success).toBe(false);
    expect(RelaySummarySchema.safeParse({
      ...legacySummary,
      schemaVersion: 2,
      publishedAt: "2026-08-29T01:00:00.000Z",
    }).success).toBe(false);
    const relaySummary = {
      schemaVersion: relay.schemaVersion,
      ref: relay.ref,
      sourcePath: relay.sourcePath,
      revision: relay.revision,
      state: relay.state,
      sender: relay.sender,
      recipients: relay.recipients,
      workstream: relay.workstream,
      summary: relay.summary,
      publishedAt: relay.publishedAt,
      publishedRepoState: relay.publishedRepoState,
      acknowledgedBy: relay.acknowledgedBy,
      acknowledgedAt: relay.acknowledgedAt,
      closedBy: relay.closedBy,
      closedAt: relay.closedAt,
    };
    for (const field of ["sender", "acknowledgedBy", "closedBy"] as const) {
      expect(RelayDetailSchema.safeParse({ ...relay, [field]: legacyGit }).success).toBe(false);
      expect(RelaySummarySchema.safeParse({ ...relaySummary, [field]: legacyGit }).success).toBe(false);
    }
    const duplicateV2Recipients = [member, { ...member, displayName: "Renamed duplicate" }];
    expect(RelayDetailSchema.safeParse({ ...relay, recipients: duplicateV2Recipients }).success).toBe(false);
    expect(RelaySummarySchema.safeParse({ ...relaySummary, recipients: duplicateV2Recipients }).success).toBe(false);
    const offsetOrderedRelay = {
      ...relay,
      publishedAt: "2026-08-29T10:00:00.000+05:00",
      acknowledgedAt: "2026-08-29T06:00:00.000Z",
      closedAt: "2026-08-29T02:00:00.000-05:00",
    };
    expect(RelayDetailSchema.safeParse(offsetOrderedRelay).success).toBe(true);
    expect(RelaySummarySchema.safeParse({
      ...relaySummary,
      publishedAt: offsetOrderedRelay.publishedAt,
      acknowledgedAt: offsetOrderedRelay.acknowledgedAt,
      closedAt: offsetOrderedRelay.closedAt,
    }).success).toBe(true);

    const acknowledgementBeforePublication = {
      ...relay,
      publishedAt: "2026-08-29T02:00:00.000-05:00",
      acknowledgedAt: "2026-08-29T06:30:00.000Z",
      closedAt: "2026-08-29T08:00:00.000Z",
    };
    expect(RelayDetailSchema.safeParse(acknowledgementBeforePublication).success).toBe(false);
    expect(RelaySummarySchema.safeParse({
      ...relaySummary,
      publishedAt: acknowledgementBeforePublication.publishedAt,
      acknowledgedAt: acknowledgementBeforePublication.acknowledgedAt,
      closedAt: acknowledgementBeforePublication.closedAt,
    }).success).toBe(false);

    const closureBeforeAcknowledgement = {
      ...relay,
      publishedAt: "2026-08-29T05:00:00.000Z",
      acknowledgedAt: "2026-08-29T02:00:00.000-05:00",
      closedAt: "2026-08-29T06:30:00.000Z",
    };
    expect(RelayDetailSchema.safeParse(closureBeforeAcknowledgement).success).toBe(false);
    expect(RelaySummarySchema.safeParse({
      ...relaySummary,
      publishedAt: closureBeforeAcknowledgement.publishedAt,
      acknowledgedAt: closureBeforeAcknowledgement.acknowledgedAt,
      closedAt: closureBeforeAcknowledgement.closedAt,
    }).success).toBe(false);

    const draftTarget = {
      target: { kind: "local" as const, namespace: "relay-draft" as const, id: "draft-publish" },
      revision,
    };
    const memberTarget = {
      target: { kind: "artifact" as const, path: `.mex/team/members/${member.memberId}.md` },
      revision,
    };
    const publish = {
      operationId: "relay_contract_publish",
      action: { kind: "relay.publish" as const, draftId: "draft-publish" },
      expectedRevisions: [memberTarget, draftTarget],
    };
    expect(RelayOperationPreviewRequestSchema.parse(publish)).toEqual(publish);
    expect(RelayOperationPreviewRequestSchema.safeParse({ ...publish, expectedRevisions: [draftTarget] }).success).toBe(true);
    for (const expectedRevisions of [
      [memberTarget],
      [draftTarget, memberTarget, {
        target: { kind: "artifact" as const, path: "README.md" },
        revision,
      }],
      [draftTarget, memberTarget, {
        target: { kind: "artifact" as const, path: `.mex/workstreams/${workstream.id}.md` },
        revision,
      }],
    ]) {
      expect(RelayOperationPreviewRequestSchema.safeParse({ ...publish, expectedRevisions }).success).toBe(false);
    }

    const legacyPublish = {
      ...publish,
      expectedRevisions: [
        draftTarget,
        memberTarget,
        {
          target: { kind: "artifact" as const, path: `.mex/workstreams/${workstream.id}.md` },
          revision,
        },
      ],
    };
    expect(RelayOperationPreviewRequestSchema.safeParse(legacyPublish).success).toBe(false);

    const previewEnvelope = {
      schemaVersion: 1 as const,
      request: save,
      preview: {
        valid: true,
        scope: "local" as const,
        changes: [],
        localChanges: [],
        diagnostics: [],
      },
      receipt: {
        schemaVersion: 1 as const,
        authority: {
          actor: { kind: "git" as const, name: "Relay agent", email: "not-an-email" },
          occurredAt: "2026-08-29T01:00:00.000Z",
          repoState: {
            branch: "feature/relay",
            head: "b".repeat(40),
            dirty: false,
            observedAt: "2026-08-29T01:00:00.000Z",
          },
        },
        purposeIds: [{ purpose: "relay-draft" as const, id: "draft-created" }],
        requestRevision: "c".repeat(64),
        presentationRevision: "d".repeat(64),
        previewRevision: "e".repeat(64),
      },
    };
    expect(RelayOperationPreviewResponseSchema.parse(previewEnvelope)).toEqual(previewEnvelope);
    const legacyPublishEnvelope = {
      ...previewEnvelope,
      request: legacyPublish,
      preview: { ...previewEnvelope.preview, scope: "mixed" as const },
      receipt: {
        ...previewEnvelope.receipt,
        purposeIds: [
          { purpose: "activity" as const, id: "event_01ARZ3NDEKTSV4RRFFQ69G5FAV" },
          { purpose: "relay" as const, id: "relay_01000000000000000000000001" },
        ],
      },
    };
    expect(RelayOperationPreviewResponseSchema.safeParse(legacyPublishEnvelope).success)
      .toBe(false);
    expect(RelayOperationApplyRequestSchema.safeParse(legacyPublishEnvelope).success)
      .toBe(true);
    const maximumServiceMember = { ...member, displayName: "S".repeat(512) };
    const maximumAuthorityEnvelope = {
      ...previewEnvelope,
      receipt: {
        ...previewEnvelope.receipt,
        authority: { ...previewEnvelope.receipt.authority, actor: maximumServiceMember },
      },
    };
    expect(RelayOperationPreviewResponseSchema.parse(maximumAuthorityEnvelope))
      .toEqual(maximumAuthorityEnvelope);
    expect(RelayOperationPreviewResponseSchema.safeParse({
      ...maximumAuthorityEnvelope,
      receipt: {
        ...maximumAuthorityEnvelope.receipt,
        authority: {
          ...maximumAuthorityEnvelope.receipt.authority,
          actor: { ...maximumServiceMember, displayName: "S".repeat(513) },
        },
      },
    }).success).toBe(false);
    expect(RelayOperationPreviewResponseSchema.safeParse({
      ...maximumAuthorityEnvelope,
      receipt: {
        ...maximumAuthorityEnvelope.receipt,
        authority: {
          ...maximumAuthorityEnvelope.receipt.authority,
          actor: { kind: "git", name: "Relay\u0085Agent\u2028Line", email: "not-an-email" },
        },
      },
    }).success).toBe(true);
    const relayApply = {
      operationId: save.operationId,
      previewRevision: previewEnvelope.receipt.previewRevision,
      applied: true as const,
      idempotentReplay: false,
      changes: [],
      localChanges: [],
      relays: [],
      events: [{
        schemaVersion: 1 as const,
        id: "event_01000000000000000000000001",
        timestamp: previewEnvelope.receipt.authority.occurredAt,
        actor: maximumServiceMember,
        action: "relay.published",
        subjects: [{ kind: "entity" as const, entity: { id: relay.ref.id, kind: "relay" } }],
        workstream,
        repoState: previewEnvelope.receipt.authority.repoState,
      }],
    };
    expect(RelayOperationApplyResponseSchema.parse(relayApply)).toEqual(relayApply);
    expect(RelayOperationApplyResponseSchema.safeParse({
      ...relayApply,
      events: [{
        ...relayApply.events[0],
        schemaVersion: 2,
        origin: { kind: "workflow", operation: "relay.publish" },
        label: "Authentication handoff",
      }],
    }).success).toBe(true);
    expect(RelayOperationApplyResponseSchema.safeParse({
      ...relayApply,
      events: [{
        ...relayApply.events[0],
        actor: { ...maximumServiceMember, displayName: "S".repeat(513) },
      }],
    }).success).toBe(false);
    expect(RelayOperationPreviewResponseSchema.safeParse({
      ...previewEnvelope,
      receipt: { ...previewEnvelope.receipt, purposeIds: [] },
    }).success).toBe(false);
    expect(RelayOperationPreviewResponseSchema.safeParse({
      ...previewEnvelope,
      request: publish,
      receipt: {
        ...previewEnvelope.receipt,
        purposeIds: [
          { purpose: "activity" as const, id: "event_01000000000000000000000001" },
          { purpose: "relay" as const, id: relay.ref.id },
        ],
      },
    }).success).toBe(true);
    expect(RelayOperationPreviewResponseSchema.safeParse({
      ...previewEnvelope,
      request: publish,
      receipt: {
        ...previewEnvelope.receipt,
        purposeIds: [{ purpose: "activity" as const, id: "event_01000000000000000000000001" }],
      },
    }).success).toBe(false);

    const existingDraftExpectation = {
      target: { kind: "local" as const, namespace: "relay-draft" as const, id: "draft-created" },
      revision,
    };
    const relayExpectation = {
      target: { kind: "artifact" as const, path: relay.sourcePath },
      revision,
    };
    for (const [request, purposeIds] of [
      [{
        operationId: "relay_contract_update",
        action: { kind: "relay.draft.save" as const, draftId: "draft-created", draft },
        expectedRevisions: [existingDraftExpectation],
      }, []],
      [{
        operationId: "relay_contract_delete",
        action: { kind: "relay.draft.delete" as const, draftId: "draft-created" },
        expectedRevisions: [existingDraftExpectation],
      }, []],
      [{
        operationId: "relay_contract_acknowledge",
        action: { kind: "relay.acknowledge" as const, relayId: relay.ref.id },
        expectedRevisions: [relayExpectation],
      }, [{ purpose: "activity" as const, id: "event_01000000000000000000000001" }]],
      [{
        operationId: "relay_contract_close",
        action: { kind: "relay.close" as const, relayId: relay.ref.id },
        expectedRevisions: [relayExpectation],
      }, [{ purpose: "activity" as const, id: "event_01000000000000000000000001" }]],
    ] as const) {
      expect(RelayOperationPreviewResponseSchema.safeParse({
        ...previewEnvelope,
        request,
        receipt: { ...previewEnvelope.receipt, purposeIds },
      }).success).toBe(true);
    }
  });

  it("locks the bounded body-free Inbox list and one-change mutation contract", () => {
    const revision = "a".repeat(64);
    const draftSummary = {
      id: "inbox_00000000000000000000000000000001",
      revision,
      updatedAt: "2026-08-23T00:00:00.000Z",
      changeKind: "spec.create",
      entityKind: "requirement",
      title: "Release benchmark local draft Requirement",
      rationaleExcerpt: "Review this typed requirement.",
    } as const;
    const page = {
      items: [draftSummary],
      nextCursor: null,
      truncated: false,
      sourceTruncated: false,
      deterministicRevision: revision,
      diagnostics: [],
      diagnosticsTruncated: false,
    };
    expect(InboxDraftListResponseSchema.parse(page)).toEqual(page);
    expect(InboxDraftListResponseSchema.safeParse({
      ...page,
      items: [{ ...draftSummary, input: { body: "must not leak" } }],
    }).success).toBe(false);

    const create = {
      operationId: "hub_inbox_create_1",
      action: {
        kind: "inbox.draft.save",
        draft: {
          change: {
            kind: "spec.create",
            entityKind: "requirement",
            title: "Typed requirement",
            body: "The reviewed behavior is explicit.\n\n- It permits a typed body.\n\t- Tabs remain canonical.",
            status: "in_flight",
          },
          rationale: "Make the requirement reviewable before publication.\nKeep the review context intact.",
          evidence: [{
            kind: "manual",
            note: "A manual observation can keep its line breaks.\n\tIndented evidence remains canonical.",
          }],
          targetRevisions: [],
        },
      },
      expectedRevisions: [],
    } as const;
    expect(InboxOperationPreviewRequestSchema.parse(create)).toEqual(create);
    expect(InboxOperationPreviewRequestSchema.safeParse({
      ...create,
      action: {
        ...create.action,
        draft: {
          ...create.action.draft,
          change: { ...create.action.draft.change, operations: [] },
        },
      },
    }).success).toBe(false);
    expect(InboxOperationPreviewRequestSchema.safeParse({
      ...create,
      action: {
        ...create.action,
        draft: {
          ...create.action.draft,
          evidence: [{
            kind: "external",
            uri: "https://example.test/evidence",
            label: "External labels\nmust remain single-line",
          }],
        },
      },
    }).success).toBe(false);
    expect(InboxOperationPreviewRequestSchema.safeParse({
      ...create,
      action: {
        ...create.action,
        draft: {
          ...create.action.draft,
          evidence: [{
            kind: "external",
            uri: " https://example.test/evidence ",
          }],
        },
      },
    }).success).toBe(false);

    const proposal = {
      schemaVersion: 1,
      ref: { id: "proposal_01000000000000000000001720", kind: "proposal" },
      sourcePath: ".mex/inbox/proposal_01000000000000000000001720.md",
      revision,
      state: "pending",
      author: { kind: "unknown" },
      changeKind: "spec.update",
      entityKind: "spec",
      title: "Release benchmark pending Spec update",
      rationaleExcerpt: "Review this exact update.",
      change: {
        kind: "spec.update",
        target: { id: "mx_01000000000000000000000001", kind: "spec" },
        patch: { summary: "A bounded reviewed update." },
      },
      rationale: "Review this exact update.",
      evidence: [],
      targetRevisions: [{
        target: { kind: "entity", id: "mx_01000000000000000000000001" },
        revision,
        semanticRevision: 1,
      }],
    } as const;
    expect(InboxProposalDetailSchema.parse(proposal)).toEqual(proposal);
    expect(InboxProposalDetailSchema.safeParse({
      ...proposal,
      targetRevisions: [],
    }).success).toBe(false);
    expect(InboxProposalDetailSchema.safeParse({
      ...proposal,
      targetRevisions: [proposal.targetRevisions[0], proposal.targetRevisions[0]],
    }).success).toBe(false);
    expect(InboxProposalDetailSchema.safeParse({
      ...proposal,
      reviewer: { kind: "unknown" },
      reviewedAt: "2026-08-23T00:00:00.000Z",
    }).success).toBe(false);
    expect(InboxProposalDetailSchema.safeParse({
      ...proposal,
      state: "rejected",
      reviewer: { kind: "unknown" },
      reviewedAt: "2026-08-23T00:00:00.000Z",
    }).success).toBe(false);

    const approval = {
      schemaVersion: 1,
      request: {
        operationId: "hub_inbox_approve_1",
        action: { kind: "inbox.approve", proposalId: proposal.ref.id },
        expectedRevisions: [{
          target: { kind: "artifact", path: proposal.sourcePath },
          revision,
        }],
      },
      preview: {
        valid: true,
        scope: "canonical",
        changes: [],
        localChanges: [],
        diagnostics: [],
      },
      receipt: {
        schemaVersion: 1,
        authority: {
          actor: { kind: "unknown" },
          occurredAt: "2026-08-23T00:00:00.000Z",
          repoState: {
            branch: "feature/inbox",
            head: "b".repeat(40),
            dirty: false,
            observedAt: "2026-08-23T00:00:00.000Z",
          },
        },
        purposeIds: [{
          purpose: "activity",
          id: "event_01000000000000000000001720",
        }, {
          purpose: "spec-entity",
          id: "mx_02000000000000000000000001",
        }],
        requestRevision: "c".repeat(64),
        presentationRevision: "d".repeat(64),
        previewRevision: "e".repeat(64),
      },
    } as const;
    expect(InboxOperationPreviewResponseSchema.parse(approval)).toEqual(approval);
    expect(InboxOperationPreviewResponseSchema.safeParse({
      ...approval,
      receipt: {
        ...approval.receipt,
        purposeIds: [...approval.receipt.purposeIds].reverse(),
      },
    }).success).toBe(false);
  });

  it("keeps Inbox structural evidence single-line while governed prose remains multiline", () => {
    const hostile = [
      { kind: "entity", entity: { id: "mx_reference", kind: "spec", title: "C1\u0085title" } },
      { kind: "code", code: { kind: "symbol", symbolId: "symbol\u2028boundary" } },
      { kind: "code", code: { kind: "symbol", symbolId: "symbol.valid", fingerprint: "bad\u2029fingerprint" } },
      { kind: "external", uri: "https://example.test/evidence", label: "Broken \ud800 label" },
      { kind: "external", uri: "https://example.test/Cafe\u0301" },
      { kind: "external", uri: "https://example.test/evidence", label: " padded label " },
      { kind: "external", uri: "HTTPS://example.test/evidence" },
      { kind: "external", uri: "http:example.test/evidence" },
      { kind: "external", uri: "https://example.test/evidence note" },
    ];
    for (const evidence of hostile) {
      expect(InboxEvidenceRefSchema.safeParse(evidence).success).toBe(false);
    }
    expect(InboxEvidenceRefSchema.parse({
      kind: "manual",
      note: "First governed observation.\n\tIndented second observation.",
    })).toEqual({
      kind: "manual",
      note: "First governed observation.\n\tIndented second observation.",
    });
  });

  it("locks the team member and capability contract golden", () => {
    const available = { availability: "available" } as const;
    const unavailable = {
      availability: "unavailable",
      reason: "The adapter is not connected.",
    } as const;
    const capabilities = {
      apiVersion: "v1",
      git: available,
      activity: available,
      activityRecord: available,
      members: {
        read: available,
        canonicalMutation: available,
        localSelection: available,
      },
      workstreams: { read: available, canonicalMutation: available },
      specs: { read: unavailable },
      inbox: {
        read: unavailable,
        draftMutation: unavailable,
        proposalMutation: unavailable,
        specApproval: unavailable,
      },
      relays: {
        read: unavailable,
        draftMutation: unavailable,
        publish: unavailable,
        lifecycleMutation: unavailable,
      },
      jobs: available,
      graph: { read: unavailable, refresh: unavailable, rebuild: unavailable },
      wiki: { read: unavailable, refresh: unavailable, rebuild: unavailable },
    } as const;
    expect(HubCapabilitiesSchema.parse(capabilities)).toEqual(capabilities);
    expect(HubCapabilitiesSchema.safeParse({
      ...capabilities,
      playbooks: { read: available },
    }).success).toBe(false);

    const member = teamMemberGolden();
    expect(TeamMemberSchema.parse(member)).toEqual(member);
    expect(TeamMemberListRequestSchema.parse({ active: "false" })).toEqual({
      active: false,
      limit: HUB_LIMITS.defaultPageSize,
    });
    expect(TeamMemberListResponseSchema.parse({
      items: [member],
      nextCursor: null,
      truncated: false,
      sourceTruncated: false,
      deterministicRevision: "b".repeat(64),
      diagnostics: [],
      diagnosticsTruncated: false,
    })).toEqual({
      items: [member],
      nextCursor: null,
      truncated: false,
      sourceTruncated: false,
      deterministicRevision: "b".repeat(64),
      diagnostics: [],
      diagnosticsTruncated: false,
    });
    expect(TeamCurrentActorResponseSchema.safeParse({
      actor: { kind: "member", memberId: member.id, displayName: member.displayName },
      source: "configured-member",
      selection: {
        memberId: member.id,
        updatedAt: "2026-08-27T04:05:06.000Z",
        revision: "c".repeat(64),
      },
      diagnostics: [],
      diagnosticsTruncated: false,
    }).success).toBe(true);
  });

  it("accepts only C operations and never caller-owned authority or metadata", () => {
    const request = teamPreviewGolden().request;
    expect(TeamOperationPreviewRequestSchema.parse(request)).toEqual(request);
    for (const injected of [
      { ...request, actor: { kind: "unknown" } },
      { ...request, occurredAt: "2026-08-27T04:05:06.000Z" },
      { ...request, repoState: { branch: null, head: null, dirty: false } },
      { ...request, unexpected: true },
    ]) {
      expect(TeamOperationPreviewRequestSchema.safeParse(injected).success).toBe(false);
    }
    expect(TeamOperationPreviewRequestSchema.safeParse({
      operationId: "contract_activity_metadata",
      action: {
        kind: "activity.record",
        activity: {
          action: "review.completed",
          subjects: [],
          metadata: { prompt: "must not cross" },
        },
      },
      expectedRevisions: [],
    }).success).toBe(false);
    expect(TeamOperationPreviewRequestSchema.safeParse({
      operationId: "contract_member_active_patch",
      action: {
        kind: "member.update",
        memberId: teamMemberGolden().id,
        patch: { active: false },
      },
      expectedRevisions: [{
        target: { kind: "artifact", path: teamMemberGolden().sourcePath },
        revision: teamMemberGolden().revision,
      }],
    }).success).toBe(false);
    expect(TeamOperationPreviewRequestSchema.safeParse({
      operationId: "contract_member_inactive_create",
      action: {
        kind: "member.add",
        member: { displayName: "Ada", gitAliases: [], active: false },
      },
      expectedRevisions: [],
    }).success).toBe(false);
    expect(TeamOperationPreviewRequestSchema.safeParse({
      operationId: "contract_future_action",
      action: { kind: "workstream.create", workstream: {} },
      expectedRevisions: [],
    }).success).toBe(false);
  });

  it("accepts strict schema-v1 and provenance-aware schema-v2 Activity events", () => {
    const base = {
      id: "event_01ARZ3NDEKTSV4RRFFQ69G5FAB",
      timestamp: "2026-08-27T04:05:06.000Z",
      actor: { kind: "unknown" as const },
      action: "relay.closed",
      subjects: [],
      workstream: null,
      repoState: {
        branch: "main",
        head: "b".repeat(40),
        dirty: false,
        observedAt: "2026-08-27T04:05:06.000Z",
      },
    };
    const v1 = { schemaVersion: 1 as const, ...base };
    const workflow = {
      schemaVersion: 2 as const,
      ...base,
      origin: { kind: "workflow" as const, operation: "relay.close" },
      label: "Authentication handoff",
    };
    const custom = {
      schemaVersion: 2 as const,
      ...base,
      origin: { kind: "custom" as const },
    };

    expect(TeamActivityEventSchema.parse(v1)).toEqual(v1);
    expect(TeamActivityEventSchema.parse(workflow)).toEqual(workflow);
    expect(TeamActivityEventSchema.parse(custom)).toEqual(custom);
    expect(TeamActivityEventSchema.safeParse({
      ...v1,
      origin: { kind: "custom" },
    }).success).toBe(false);
    expect(TeamActivityEventSchema.safeParse({
      ...workflow,
      origin: { kind: "custom", operation: "relay.close" },
    }).success).toBe(false);
    expect(TeamActivityEventSchema.safeParse({
      ...workflow,
      label: "é".repeat(257),
    }).success).toBe(false);
  });

  it("locks the portable preview/apply golden and its byte bounds", () => {
    const envelope = teamPreviewGolden();
    expect(TeamOperationPreviewResponseSchema.parse(envelope)).toEqual(envelope);
    expect(TeamOperationPreviewResponseSchema.safeParse({
      ...envelope,
      receipt: { ...envelope.receipt, extra: true },
    }).success).toBe(false);
    expect(TeamOperationPreviewResponseSchema.safeParse({
      ...envelope,
      receipt: {
        ...envelope.receipt,
        purposeIds: [...envelope.receipt.purposeIds].reverse(),
      },
    }).success).toBe(false);
    expect(TeamOperationPreviewResponseSchema.safeParse({
      ...envelope,
      preview: {
        ...envelope.preview,
        changes: [{ ...envelope.preview.changes[0], diff: "x".repeat(64 * 1024) }],
      },
    }).success).toBe(false);

    const apply = {
      operationId: envelope.request.operationId,
      previewRevision: envelope.receipt.previewRevision,
      applied: true,
      idempotentReplay: false,
      changes: envelope.preview.changes,
      localChanges: [],
      members: [teamMemberGolden()],
      workstreams: [],
      events: [{
        schemaVersion: 1,
        id: envelope.receipt.purposeIds[0]!.id,
        timestamp: envelope.receipt.authority.occurredAt,
        actor: envelope.receipt.authority.actor,
        action: "member.added",
        subjects: [{ kind: "entity", entity: { id: teamMemberGolden().id, kind: "member" } }],
        workstream: null,
        repoState: envelope.receipt.authority.repoState,
      }],
    } as const;
    expect(TeamOperationApplyResponseSchema.parse(apply)).toEqual(apply);
    expect(TeamOperationApplyResponseSchema.safeParse({
      ...apply,
      events: [{ ...apply.events[0], metadata: { secret: "must not cross" } }],
    }).success).toBe(false);
  });

  it("locks bounded Workstream reads and exact revision-bound mutations", () => {
    const workstream = teamWorkstreamGolden();
    expect(TeamWorkstreamSchema.parse(workstream)).toEqual(workstream);
    expect(TeamWorkstreamListRequestSchema.parse({
      state: "blocked",
      includeArchived: "false",
    })).toEqual({ state: "blocked", includeArchived: false, limit: 25 });
    expect(TeamWorkstreamListResponseSchema.safeParse({
      items: [workstream],
      nextCursor: null,
      truncated: false,
      sourceTruncated: false,
      deterministicRevision: "9".repeat(64),
      diagnostics: [],
      diagnosticsTruncated: false,
    }).success).toBe(true);
    expect(TeamWorkstreamSchema.safeParse({
      ...workstream,
      state: "blocked",
      blockers: [],
    }).success).toBe(false);
    expect(TeamWorkstreamSchema.safeParse({
      ...workstream,
      sourcePath: ".mex/workstreams/ws_other.md",
    }).success).toBe(false);

    const create = {
      operationId: "contract_workstream_create",
      action: {
        kind: "workstream.create",
        workstream: {
          title: "Project Hub",
          goal: "Make repository memory usable by a team.",
          summary: "Connect canonical team workflows.",
          owners: [{ kind: "member", memberId: teamMemberGolden().id }],
          nextMilestone: "Ship the Workstream workbench.",
        },
      },
      expectedRevisions: [],
    } as const;
    expect(TeamOperationPreviewRequestSchema.parse(create)).toEqual(create);
    expect(TeamOperationPreviewRequestSchema.safeParse({
      operationId: "contract_workstream_update_without_revision",
      action: {
        kind: "workstream.update",
        workstreamId: workstream.id,
        patch: { state: "active" },
      },
      expectedRevisions: [],
    }).success).toBe(false);
    expect(TeamOperationPreviewRequestSchema.safeParse({
      ...create,
      actor: { kind: "unknown" },
    }).success).toBe(false);
  });

  it("keeps Wiki filters singular, strict, and capped at 50", () => {
    const entity = "mx_01K4FAM7W8N9R3T5Y6Q2ZBCHJD";
    expect(WikiEntityListRequestSchema.parse({ topic: entity })).toEqual({
      topic: entity,
      limit: 25,
    });
    expect(WikiEntityListRequestSchema.safeParse({ kind: ["architecture"] }).success).toBe(false);
    expect(WikiEntityListRequestSchema.safeParse({ limit: 51 }).success).toBe(false);
    expect(WikiEntityListRequestSchema.safeParse({ unknown: true }).success).toBe(false);
    expect(WikiRelationsRequestSchema.safeParse({ direction: "both", depth: 2 }).success).toBe(false);
  });

  it("bounds Wiki summaries, body bytes, and Code links without extension fields", () => {
    const id = "mx_01K4FAM7W8N9R3T5Y6Q2ZBCHJD";
    const summary = {
      id,
      kind: "architecture",
      title: "Durable queue",
      summary: null,
      lifecycleState: "promoted",
      groundingHealth: "unverified",
      topics: [],
      topicsTruncated: false,
      sourceTypes: ["manual"],
      sourceTypesTruncated: false,
      location: { path: ".mex/context/queue.md", startLine: 1, endLine: 12 },
      version: { semanticRevision: 1, contentHash: "a".repeat(64) },
      diagnostics: [],
      diagnosticsTruncated: false,
      route: `/knowledge/${id}`,
    } as const;
    const page = {
      indexedRevision: "b".repeat(64),
      observedAt: "2026-08-26T00:00:00.000Z",
      items: [summary],
      nextCursor: null,
      truncated: false,
    };
    expect(WikiEntityListResponseSchema.safeParse(page).success).toBe(true);
    const graph = {
      indexedRevision: page.indexedRevision, observedAt: page.observedAt,
      nodes: [summary], relations: [],
      coverage: { nodeLimit: 100, relationLimit: 500, nodesTruncated: false, relationsTruncated: false },
    };
    expect(WikiGraphResponseSchema.safeParse(graph).success).toBe(true);
    expect(WikiGraphResponseSchema.safeParse({ ...graph, nodes: [summary, summary] }).success).toBe(false);
    expect(WikiGraphResponseSchema.safeParse({ ...graph, nodes: Array.from({ length: 101 }, (_, index) => ({ ...summary, id: `mx_${String(index).padStart(26, "0")}` })) }).success).toBe(false);
    const relation = { type: "related_to", source: { id, kind: "architecture", title: null }, target: { id, kind: "architecture", title: null }, note: null };
    expect(WikiGraphResponseSchema.safeParse({ ...graph, relations: Array(501).fill(relation) }).success).toBe(false);
    expect(WikiGraphResponseSchema.safeParse({ ...graph, relations: [{ ...relation, target: { ...relation.target, id: "mx_01K4FAM7W8N9R3T5Y6Q2ZBCHJE" } }] }).success).toBe(false);
    const code = {
      indexedRevision: page.indexedRevision, observedAt: page.observedAt, entityId: id,
      graphRevision: null, groundings: [{ requestedNode: "function:queue", resolvedNode: null, health: "unverified", symbol: null }], truncated: false,
    };
    expect(WikiGroundedCodeResponseSchema.safeParse(code).success).toBe(true);
    expect(WikiGroundedCodeResponseSchema.safeParse({ ...code, groundings: Array(51).fill(code.groundings[0]) }).success).toBe(false);
    const symbol = { id: "function:queue", symbolKind: "function", name: "queue", qualifiedName: "queue", language: "typescript", path: "src/queue.ts", startLine: 1, endLine: 4, route: "/code/symbols/function%3Aqueue" };
    const resolvedCode = { ...code, graphRevision: "c".repeat(64), groundings: [{ requestedNode: "function:queue", resolvedNode: "function:queue", health: "fresh", symbol }] };
    expect(WikiGroundedCodeResponseSchema.safeParse(resolvedCode).success).toBe(true);
    expect(WikiGroundedCodeResponseSchema.safeParse({ ...resolvedCode, graphRevision: null }).success).toBe(false);
    expect(WikiGroundedCodeResponseSchema.safeParse({ ...resolvedCode, groundings: [{ ...resolvedCode.groundings[0], resolvedNode: "function:other" }] }).success).toBe(false);
    expect(CodeKnowledgeResponseSchema.safeParse({
      ...page,
      items: [{ entity: summary, matchedNodes: ["function:queue"] }],
    }).success).toBe(true);
    const detail = {
      indexedRevision: page.indexedRevision,
      observedAt: page.observedAt,
      entity: summary,
      body: { content: "Queue body\n", totalBytes: 11, truncated: false },
      provenance: null,
      sources: { items: [], total: 0, truncated: false },
      groundings: { items: [], total: 0, truncated: false },
      relationCount: 0,
      backlinkCount: 0,
    };
    expect(WikiEntityDetailResponseSchema.safeParse(detail).success).toBe(true);
    expect(WikiEntityDetailResponseSchema.safeParse({
      ...detail,
      body: { content: "x".repeat(128 * 1_024 + 1), totalBytes: 128 * 1_024 + 1, truncated: false },
    }).success).toBe(false);
    expect(WikiEntityDetailResponseSchema.safeParse({
      ...detail,
      extension: { sessionId: "secret" },
    }).success).toBe(false);
    expect(SearchResponseSchema.safeParse({
      query: "queue",
      observedAt: page.observedAt,
      groups: {
        wiki: {
          status: "available",
          items: [{
            id,
            kind: "wiki",
            entityKind: "architecture",
            title: "Durable queue",
            summary: null,
            lifecycleState: "promoted",
            groundingHealth: "unverified",
            topics: [],
            // Deliberately omit topicsTruncated/sourceTypesTruncated.
            sourceTypes: [],
            path: ".mex/context/queue.md",
            matchedFields: ["title"],
            route: `/knowledge/${id}`,
          }],
          nextCursor: null,
          truncated: false,
          revision: page.indexedRevision,
        },
        symbols: {
          status: "unavailable", items: [], nextCursor: null, truncated: false,
          revision: null, code: "CAPABILITY_UNAVAILABLE", detail: "Unavailable.",
        },
        sources: {
          status: "unavailable", items: [], nextCursor: null, truncated: false,
          revision: null, code: "CAPABILITY_UNAVAILABLE", detail: "Unavailable.",
        },
      },
    }).success).toBe(false);
  });

  it("keeps dedicated Spec reads fresh, explicit, and independently bounded", () => {
    const spec = specSummaryGolden();
    const freshIndex = {
      state: "fresh" as const,
      observedAt: "2026-08-28T00:00:00.000Z",
      indexedRevision: "1".repeat(64),
      indexedAt: "2026-08-27T23:59:00.000Z",
      diagnostics: [],
      diagnosticsTruncated: false,
    };
    expect(SpecListRequestSchema.parse({
      includeArchived: "false",
      lifecycleStates: ["in_flight", "promoted"],
    })).toEqual({
      includeArchived: false,
      lifecycleStates: ["in_flight", "promoted"],
      limit: 25,
    });
    expect(SpecListRequestSchema.safeParse({
      lifecycleStates: ["promoted", "promoted"],
    }).success).toBe(false);

    const list = {
      availability: "ready" as const,
      index: freshIndex,
      page: {
        schemaVersion: 1 as const,
        items: [spec],
        nextCursor: null,
        truncated: true,
        estimatedTokens: 180,
        deterministicRevision: "2".repeat(64),
      },
    };
    expect(SpecListResponseSchema.safeParse(list).success).toBe(true);
    expect(SpecListResponseSchema.safeParse({
      ...list,
      page: { ...list.page, items: [{ ...spec, kind: "requirement" }] },
    }).success).toBe(false);
    expect(SpecListResponseSchema.safeParse({
      ...list,
      availability: "stale",
      page: null,
    }).success).toBe(false);

    const requirement = { ...spec, id: "mx_01K4R3X4A5BC6DE7FGHJKMNPQR", kind: "requirement" as const };
    const detail = {
      availability: "ready" as const,
      index: freshIndex,
      detail: {
        schemaVersion: 1 as const,
        spec,
        body: "# Human-team memory\n\nExplicit evidence only.\n",
        bodyTruncated: false,
        provenance: null,
        sources: [],
        sourcesTruncated: false,
        groundings: [],
        groundingsTruncated: false,
        hierarchy: {
          requirements: [requirement],
          acceptanceCriteria: [],
          constraints: [],
          relations: [{
            type: "derived_from" as const,
            source: { id: requirement.id, kind: requirement.kind },
            target: { id: spec.id, kind: spec.kind },
            note: null,
          }],
          estimatedTokens: 240,
        },
        deterministicRevision: "3".repeat(64),
      },
    };
    expect(SpecDetailResponseSchema.safeParse(detail).success).toBe(true);
    expect(SpecDetailResponseSchema.safeParse({
      ...detail,
      detail: {
        ...detail.detail,
        hierarchy: { ...detail.detail.hierarchy, constraints: [requirement] },
      },
    }).success).toBe(false);
  });

  it("bounds strict activity filters and cursors", () => {
    expect(ActivityRequestSchema.parse({ source: "legacy" })).toEqual({
      source: "legacy",
      limit: HUB_LIMITS.defaultPageSize,
    });
    expect(ActivityRequestSchema.safeParse({ since: "2026-08-23" }).success).toBe(false);
    expect(ActivityRequestSchema.safeParse({ source: "wiki" }).success).toBe(false);
    expect(ActivityRequestSchema.safeParse({ limit: HUB_LIMITS.maxPageSize + 1 }).success).toBe(false);
    expect(ActivityRequestSchema.safeParse({ cursor: "x".repeat(HUB_LIMITS.maxCursorBytes + 1) }).success).toBe(false);
    expect(ActivityRequestSchema.safeParse({ extra: true }).success).toBe(false);
  });

  it("keeps activity rows discriminated, privacy-safe, and internally consistent", () => {
    const canonical = {
      source: "activity",
      id: "event_01ARZ3NDEKTSV4RRFFQ69G5FAB",
      timestamp: "2026-08-23T00:00:00.000Z",
      action: "member.updated",
      subjects: [{ kind: "file", path: "src/index.ts" }],
      subjectCount: 1,
      subjectsTruncated: false,
      sourcePath: ".mex/events/activity/2026-08/event_01ARZ3NDEKTSV4RRFFQ69G5FAB.md",
      recordedActor: { kind: "git", name: "Daksh", email: "daksh@example.test" },
      effectiveActor: {
        kind: "member",
        memberId: "member_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        displayName: "Daksh",
      },
      actorDiagnostics: [],
      recordOrigin: { kind: "unknown" },
      label: null,
      workstream: null,
      repository: {
        branch: "feat/activity",
        head: "a".repeat(40),
        dirty: false,
        observedAt: "2026-08-23T00:00:00.000Z",
      },
      revision: "b".repeat(64),
    } as const;
    const legacy = {
      source: "legacy",
      id: `legacy_${"c".repeat(64)}`,
      timestamp: "2026-08-22T00:00:00.000Z",
      action: "note",
      subjects: [],
      subjectCount: 0,
      subjectsTruncated: false,
      sourcePath: ".mex/events/decisions.jsonl",
      recordedActor: null,
      effectiveActor: null,
      actorDiagnostics: [],
      workstream: null,
      repository: null,
      revision: null,
      sourceLine: 1,
      message: "Legacy note",
      messageTruncated: false,
    } as const;
    const response = {
      items: [canonical, legacy],
      nextCursor: null,
      hasMore: false,
      sourceTruncated: false,
      deterministicRevision: "d".repeat(64),
      diagnostics: [],
      diagnosticsTruncated: false,
    };
    expect(ActivityResponseSchema.safeParse(response).success).toBe(true);
    expect(ActivityResponseSchema.safeParse({
      ...response,
      items: [{
        ...canonical,
        recordOrigin: { kind: "workflow", operation: "member.update" },
        label: "Daksh",
      }, legacy],
    }).success).toBe(true);
    expect(ActivityResponseSchema.safeParse({
      ...response,
      items: [{
        ...canonical,
        recordOrigin: { kind: "custom", operation: "member.update" },
      }, legacy],
    }).success).toBe(false);
    expect(ActivityResponseSchema.safeParse({
      ...response,
      items: [{ ...canonical, metadata: { secret: "must-not-cross" } }],
    }).success).toBe(false);
    expect(ActivityResponseSchema.safeParse({
      ...response,
      items: [{ ...legacy, cwd: "/Users/alice/private" }],
    }).success).toBe(false);
    expect(ActivityResponseSchema.safeParse({ ...response, hasMore: true }).success).toBe(false);
    const actorDiagnostic = {
      code: "ACTOR_WARNING",
      severity: "warning" as const,
      message: "Warning",
    };
    expect(ActivityResponseSchema.safeParse({
      ...response,
      items: [{ ...canonical, actorDiagnostics: [actorDiagnostic, actorDiagnostic] }],
    }).success).toBe(true);
    expect(ActivityResponseSchema.safeParse({
      ...response,
      items: [{
        ...canonical,
        actorDiagnostics: Array.from({ length: 3 }, () => actorDiagnostic),
      }],
    }).success).toBe(false);
  });

  it("rejects non-canonical and byte-oversized activity display paths", () => {
    const base = {
      source: "legacy",
      id: `legacy_${"c".repeat(64)}`,
      timestamp: "2026-08-22T00:00:00.000Z",
      action: "note",
      subjects: [] as unknown[],
      subjectCount: 1,
      subjectsTruncated: true,
      sourcePath: ".mex/events/decisions.jsonl",
      recordedActor: null,
      effectiveActor: null,
      actorDiagnostics: [],
      workstream: null,
      repository: null,
      revision: null,
      sourceLine: 1,
      message: "Legacy note",
      messageTruncated: false,
    };
    const response = (path: string) => ({
      items: [{ ...base, subjects: [{ kind: "file", path }] }],
      nextCursor: null,
      hasMore: false,
      sourceTruncated: false,
      deterministicRevision: "d".repeat(64),
      diagnostics: [],
      diagnosticsTruncated: false,
    });
    expect(ActivityResponseSchema.safeParse(response("src/e\u0301.ts")).success).toBe(false);
    expect(ActivityResponseSchema.safeParse(response("src/\u0080.ts")).success).toBe(false);
    expect(ActivityResponseSchema.safeParse(response(`src/${"é".repeat(192)}x`)).success).toBe(false);
    expect(OverviewActivityPanelSchema.safeParse({
      availability: "available",
      observedAt: "2026-08-23T00:00:00.000Z",
      ...response("src/ok.ts"),
      items: Array.from({ length: 6 }, (_, index) => ({
        ...base,
        id: `legacy_${String(index).repeat(64)}`,
      })),
    }).success).toBe(false);
  });

  it("accepts only standard prefixed ULIDs for Hub jobs", () => {
    expect(HubJobIdSchema.safeParse("job_01ARZ3NDEKTSV4RRFFQ69G5FAV").success).toBe(true);
    expect(HubJobIdSchema.safeParse(`job_8${"0".repeat(25)}`).success).toBe(false);
    expect(HubJobIdSchema.safeParse(`job_Z${"0".repeat(25)}`).success).toBe(false);
  });

  it("requires unavailable production summaries to be honest", () => {
    const response = {
      observedAt: "2026-08-23T00:00:00.000Z",
      repository: {
        scaffoldId: "mex",
        name: "mex",
        branch: "feat/hub",
        head: "a".repeat(40),
        dirty: false,
      },
      actor: { kind: "unknown" },
      attention: {
        relays: { availability: "unavailable", reason: "Relays are not connected." },
        inbox: { availability: "unavailable", reason: "Inbox is not connected." },
      },
      jobs: { availability: "available", activeCount: 0 },
    };
    expect(HomeResponseSchema.safeParse(response).success).toBe(true);
    expect(HomeResponseSchema.safeParse({
      ...response,
      attention: {
        ...response.attention,
        inbox: { availability: "unavailable", teamReviewCount: 12 },
      },
    }).success).toBe(false);
  });

  it("keeps grouped search failures independent and result-free", () => {
    const unavailable = {
      status: "unavailable",
      items: [],
      nextCursor: null,
      truncated: false,
      revision: null,
      code: "CAPABILITY_UNAVAILABLE",
      detail: "The adapter is not installed.",
    } as const;
    const response = {
      query: "router",
      observedAt: "2026-08-23T00:00:00.000Z",
      groups: {
        wiki: unavailable,
        symbols: {
          status: "available",
          items: [{
            id: "symbol:router",
            kind: "code_symbol",
            symbolKind: "function",
            name: "Router",
            qualifiedName: "Router",
            language: "typescript",
            path: "src/router.ts",
            startLine: 1,
            endLine: 4,
            route: "/code/symbols/symbol%3Arouter",
          }],
          nextCursor: null,
          truncated: false,
          revision: "b".repeat(64),
        },
        sources: unavailable,
      },
    };
    expect(SearchResponseSchema.safeParse(response).success).toBe(true);
    expect(SearchResponseSchema.safeParse({
      ...response,
      groups: {
        ...response.groups,
        wiki: { ...unavailable, items: [{ id: "fake", kind: "wiki", title: "Fake" }] },
      },
    }).success).toBe(false);
  });

  it("binds Code workspace queries to one strict traversal shape", () => {
    expect(CodeWorkspaceRequestSchema.parse({})).toEqual({ view: "overview" });
    expect(CodeWorkspaceRequestSchema.safeParse({ view: "overview", cursor: "x" }).success).toBe(false);
    expect(CodeWorkspaceRequestSchema.safeParse({ view: "callers", depth: 2 }).success).toBe(false);
    expect(CodeWorkspaceRequestSchema.safeParse({ view: "impact", depth: 5 }).success).toBe(false);

    const symbol = {
      id: "function:router",
      symbolKind: "function",
      name: "router",
      qualifiedName: "router",
      language: "typescript",
      path: "src/router.ts",
      startLine: 1,
      endLine: 3,
      route: "/code/symbols/function%3Arouter",
    };
    const response = {
      revision: "a".repeat(64),
      symbol,
      source: { items: [], nextCursor: null, truncated: false },
      view: "callers",
      traversal: { view: "callers", items: [], nextCursor: null, truncated: false },
    };
    expect(CodeWorkspaceResponseSchema.safeParse(response).success).toBe(true);
    expect(CodeWorkspaceResponseSchema.safeParse({
      ...response,
      traversal: { view: "overview" },
    }).success).toBe(false);
  });

  it("keeps structured graph health operations internally consistent", () => {
    const graph = {
      indexStatus: "stale",
      observedAt: "2026-08-23T00:00:00.000Z",
      lastSuccessfulIndexAt: null,
      indexedAt: null,
      indexedBranch: null,
      indexedHead: null,
      currentBranch: "main",
      currentHead: "a".repeat(40),
      schemaVersion: 2,
      extractorVersion: "extractor-1",
      grammarVersion: "grammar-1",
      parseHealth: {
        total: 1,
        ok: 1,
        partial: 0,
        failed: 0,
        failedPaths: [],
        failedPathsTruncated: false,
      },
      changes: {
        total: 1,
        added: ["src/new.ts"],
        modified: [],
        deleted: [],
        truncated: false,
        branchChanged: false,
        manifestChanged: false,
        configChanged: false,
        grammarChanged: false,
      },
      allowedJobKinds: ["graph_refresh"],
      recommendedJobKind: "graph_refresh",
      activeJobId: null,
    } as const;
    const response = {
      status: "degraded",
      observedAt: "2026-08-23T00:00:00.000Z",
      components: [{
        id: "graph",
        label: "Code graph",
        status: "degraded",
        summary: "Refresh required.",
        diagnostics: [],
        repairJobKind: "graph_refresh",
        graph,
      }],
    };
    expect(HealthResponseSchema.safeParse(response).success).toBe(true);
    expect(HealthResponseSchema.safeParse({
      ...response,
      components: [{ ...response.components[0], repairJobKind: "graph_rebuild" }],
    }).success).toBe(false);
    expect(HealthResponseSchema.safeParse({
      ...response,
      components: [{ ...response.components[0], graph: { ...graph, parseHealth: { ...graph.parseHealth, failed: 1 } } }],
    }).success).toBe(false);
  });

  it("keeps the Wiki recovery command optional, nullable, and bounded", () => {
    const details = {
      indexStatus: "migration_required",
      observedAt: "2026-08-23T00:00:00.000Z",
      indexedAt: null,
      schemaVersion: null,
      indexedRevision: null,
      allowedJobKinds: [],
      recommendedJobKind: null,
      activeJobId: null,
    } as const;
    const response = (recoveryCommand: unknown) => ({
      status: "degraded",
      observedAt: "2026-08-23T00:00:00.000Z",
      components: [{
        id: "wiki",
        label: "Wiki index",
        status: "degraded",
        summary: "Migration required.",
        diagnostics: [],
        wiki: { ...details, recoveryCommand },
      }],
    });
    const recovery = { label: "Preview the required Wiki migration", command: "mex wiki migrate --dry-run" };

    expect(HealthResponseSchema.safeParse(response(undefined)).success).toBe(true);
    expect(HealthResponseSchema.safeParse(response(null)).success).toBe(true);
    expect(HealthResponseSchema.safeParse(response(recovery)).success).toBe(true);
    expect(HealthResponseSchema.safeParse(response({
      ...recovery,
      command: "m".repeat(201),
    })).success).toBe(false);
    expect(HealthResponseSchema.safeParse(response({
      ...recovery,
      label: "",
    })).success).toBe(false);
    expect(HealthResponseSchema.safeParse(response({
      ...recovery,
      reason: "Hub runs it for you",
    })).success).toBe(false);
  });
});

function teamMemberGolden() {
  const id = "member_01ARZ3NDEKTSV4RRFFQ69G5FAV";
  return {
    schemaVersion: 1 as const,
    id,
    displayName: "Ada Lovelace",
    gitAliases: [{ name: "Ada", email: "ada@example.test" }],
    active: true,
    sourcePath: `.mex/team/members/${id}.md`,
    revision: "a".repeat(64),
  };
}

function teamWorkstreamGolden() {
  const id = "ws_01ARZ3NDEKTSV4RRFFQ69G5FAV";
  const actor = {
    kind: "member" as const,
    memberId: teamMemberGolden().id,
    displayName: "Ada Lovelace",
  };
  return {
    schemaVersion: 1 as const,
    id,
    entityRevision: 2,
    title: "Project Hub",
    goal: "Make repository memory usable by a team.",
    summary: "Connect canonical team workflows.",
    state: "active" as const,
    owners: [actor],
    contributors: [],
    paths: ["packages/hub-web"],
    code: [],
    topics: [],
    components: [],
    related: [],
    blockers: [],
    currentState: "Identity is connected.",
    nextMilestone: "Ship the Workstream workbench.",
    createdBy: actor,
    createdAt: "2026-08-27T04:05:06.000Z",
    updatedBy: actor,
    updatedAt: "2026-08-28T04:05:06.000Z",
    sourcePath: `.mex/workstreams/${id}.md`,
    revision: "8".repeat(64),
  };
}

function specSummaryGolden() {
  return {
    schemaVersion: 1 as const,
    id: "mx_01K4FAM7W8N9R3T5Y6Q2ZBCHJD",
    kind: "spec" as const,
    title: "Human-team memory",
    summary: "Explicit, repository-owned collaboration memory.",
    lifecycleState: "in_flight" as const,
    groundingHealth: "fresh" as const,
    sourcePath: ".mex/wiki/specs/human-team-memory.md",
    version: { semanticRevision: 4, contentHash: "4".repeat(64) },
    topics: [],
    sourceTypes: ["manual"],
    diagnostics: [],
    diagnosticsTruncated: false,
  };
}

function teamPreviewGolden() {
  const member = teamMemberGolden();
  const activityId = "event_01ARZ3NDEKTSV4RRFFQ69G5FAB";
  const occurredAt = "2026-08-27T04:05:06.000Z";
  return {
    schemaVersion: 1 as const,
    request: {
      operationId: "contract_member_add",
      action: {
        kind: "member.add" as const,
        member: {
          displayName: member.displayName,
          gitAliases: member.gitAliases,
        },
      },
      expectedRevisions: [],
    },
    preview: {
      valid: true,
      scope: "canonical" as const,
      changes: [{
        kind: "create" as const,
        path: member.sourcePath,
        diff: "--- /dev/null\n+++ member\n",
        beforeRevision: null,
        afterRevision: member.revision,
      }],
      localChanges: [],
      diagnostics: [],
    },
    receipt: {
      schemaVersion: 1 as const,
      authority: {
        actor: { kind: "unknown" as const },
        occurredAt,
        repoState: {
          branch: "feature/team-identity",
          head: "b".repeat(40),
          dirty: false,
          observedAt: occurredAt,
        },
      },
      purposeIds: [
        { purpose: "activity" as const, id: activityId },
        { purpose: "member" as const, id: member.id },
      ],
      requestRevision: "c".repeat(64),
      presentationRevision: "d".repeat(64),
      previewRevision: "e".repeat(64),
    },
  };
}
