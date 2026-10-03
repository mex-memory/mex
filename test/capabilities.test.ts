import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Command } from "commander";
import Ajv2020 from "ajv/dist/2020.js";
import {
  CAPABILITIES_MAX_BYTES,
  CAPABILITY_COMMAND_CATALOG,
  inboxContractCatalogData,
  inspectCapabilities,
  runCapabilities,
  type CapabilityInspectionDependencies,
} from "../src/capabilities.js";
import {
  isFirstRunNoticeExemptCommand,
  isTelemetryExemptCommand,
  program,
} from "../src/cli.js";
import { createGraphEngine } from "../src/graph/engine-impl.js";
import * as repositoryGit from "../src/team/git/git-port.js";
import { GRAPH_CORPUS_LIMITS } from "../src/graph/corpus-policy.js";
import { WIKI_CORPUS_LIMITS } from "../src/wiki/index/corpus-policy.js";
import { rebuildWikiIndex } from "../src/wiki/index/rebuild.js";
import {
  readTeamCommandFile,
  type TeamMutationCommandName,
} from "../src/team/cli/request-file.js";
import {
  readInboxCommandFile,
  readInboxPreviewFile,
} from "../src/team/inbox/cli/request-file.js";

const roots: string[] = [];

function expectParserAcceptance(
  path: string,
  command: Parameters<typeof readInboxPreviewFile>[1],
  expected: boolean,
  label: string,
): void {
  let accepted = true;
  try {
    readInboxPreviewFile(path, command);
  } catch {
    accepted = false;
  }
  expect(accepted, label).toBe(expected);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("mex capabilities manifest", () => {
  it("matches the deterministic uninitialized golden without running index inspectors", async () => {
    const root = temporaryRoot();
    const inspectTeam = vi.fn<CapabilityInspectionDependencies["inspectTeam"]>();
    const inspectGraphIndex = vi.fn<CapabilityInspectionDependencies["inspectGraphIndex"]>();
    const inspectWikiIndex = vi.fn<CapabilityInspectionDependencies["inspectWikiIndex"]>();

    const envelope = await inspectCapabilities(root, { inspectTeam, inspectGraphIndex, inspectWikiIndex });

    expect(JSON.stringify(envelope, null, 2) + "\n").toBe(golden("not-git.json"));
    expect(inspectTeam).not.toHaveBeenCalled();
    expect(inspectGraphIndex).not.toHaveBeenCalled();
    expect(inspectWikiIndex).not.toHaveBeenCalled();
  });

  it("matches the ready golden and honors bounded Wiki exclude configuration", async () => {
    const root = readyRoot();
    writeFileSync(join(root, ".mex", "config.json"), JSON.stringify({
      scaffold_id: "scaffold-capabilities-001",
      wiki: { exclude: ["private/**", "generated/**"] },
    }));
    execFileSync("git", ["add", ".mex/config.json"], { cwd: root });
    execFileSync("git", ["commit", "--quiet", "-m", "configure wiki"], { cwd: root });
    const inspectGraphIndex = vi.fn(async () => inspection("fresh"));
    const inspectWikiIndex = vi.fn(async () => inspection("fresh"));

    const first = await inspectCapabilities(root, { inspectGraphIndex, inspectWikiIndex });
    const second = await inspectCapabilities(root, { inspectGraphIndex, inspectWikiIndex });

    expect(JSON.stringify(first, null, 2) + "\n").toBe(golden("ready.json"));
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(inspectWikiIndex).toHaveBeenCalledWith(join(root, ".mex"), ["private/**", "generated/**"]);
    expect(Buffer.byteLength(JSON.stringify(first), "utf8")).toBeLessThanOrEqual(CAPABILITIES_MAX_BYTES);
  });

  it("keeps every repository lifecycle manifest bounded with the static resolver advertised", async () => {
    const envelopes: Array<{ label: string; value: Awaited<ReturnType<typeof inspectCapabilities>> }> = [];
    envelopes.push({ label: "uninitialized", value: await inspectCapabilities(temporaryRoot()) });
    for (const state of ["fresh", "stale", "missing", "corrupt", "migration_required"] as const) {
      const root = readyRoot();
      envelopes.push({
        label: state,
        value: await inspectCapabilities(root, {
          inspectTeam: async () => null,
          inspectGraphIndex: async () => inspection("fresh"),
          inspectWikiIndex: async () => inspection(state),
        }),
      });
    }
    const unavailable = readyRoot();
    writeFileSync(join(unavailable, ".mex", "config.json"), JSON.stringify({
      scaffold_id: "scaffold-capabilities-uncommitted",
    }));
    envelopes.push({
      label: "tracked-config-unavailable",
      value: await inspectCapabilities(unavailable, {
        inspectGraphIndex: async () => inspection("fresh"),
        inspectWikiIndex: async () => inspection("fresh"),
      }),
    });

    for (const { label, value } of envelopes) {
      expect(Buffer.byteLength(JSON.stringify(value), "utf8"), label)
        .toBeLessThanOrEqual(CAPABILITIES_MAX_BYTES);
      expect(value.data.commands.read.find((entry) => entry.id === "inbox.contract"), label)
        .toMatchObject({ usage: "mex inbox contract --json", contractResolver: "inbox.contract" });
      expect(value.data.commands.read.find((entry) => entry.id === "relay.contract"), label)
        .toMatchObject({ usage: "mex relay contract --json", contractResolver: "relay.contract" });
      for (const descriptor of Object.values(value.data.commands).flat()) {
        if (!descriptor.id.startsWith("inbox.")) continue;
        expect(descriptor.contractResolver, `${label}:${descriptor.id}`).toBe("inbox.contract");
      }
      expect(Object.values(value.data.commands).flat().filter((entry) => entry.id.startsWith("relay.")), label)
        .toEqual([expect.objectContaining({ id: "relay.contract" })]);
      const serialized = JSON.stringify(value);
      expect(serialized, label).not.toContain("team-relay-request-v1.json");
      expect(serialized, label).not.toContain("team-relay-preview-envelope-v1.json");
    }
  });

  it("publishes a complete machine-readable Team request and exit contract", async () => {
    const root = readyRoot();
    const envelope = await inspectCapabilities(root, {
      inspectGraphIndex: async () => inspection("fresh"),
      inspectWikiIndex: async () => inspection("fresh"),
    });
    const contract = envelope.data.teamCliContract;
    const ajv = new Ajv2020({ strict: true });
    ajv.addSchema(contract.requestFile.schema, contract.requestFile.contractId);
    const validate = ajv.getSchema(contract.requestFile.contractId)!;
    const legacyDefinitions = [
      "operationId", "revision", "memberId", "workstreamId", "canonicalText", "gitAlias",
      "memberArtifactExpectation", "workstreamArtifactExpectation", "entityExpectation",
      "artifactExpectation", "localExpectation", "expectation", "expectations",
      "nonEmptyExpectations", "entityRef", "codeRef", "actorRef", "canonicalRepoPath",
      "actorSet", "entitySet", "codeSet", "pathSet", "workstreamCreateInput",
      "workstreamUpdatePatch", "activitySubject", "memberAddAction", "memberUpdateAction",
      "memberDeactivateAction", "memberSelectAction", "memberClearAction",
      "activityRecordAction", "workstreamCreateAction", "workstreamUpdateAction",
      "workstreamArchiveAction", "memberAddRequest", "memberUpdateRequest",
      "memberDeactivateRequest", "memberSelectRequest", "memberSelectOnlyRequest",
      "memberClearRequest", "activityRecordRequest", "workstreamCreateRequest",
      "workstreamUpdateRequest", "workstreamArchiveRequest",
    ] as const;

    expect(contract.requestFile.schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    for (const name of legacyDefinitions) {
      expect((contract.requestFile.schema.$defs as Record<string, unknown>)[name], name).toBeDefined();
      expect(ajv.compile({
        $ref: `https://mex.dev/contracts/team-identity-activity-request-v1.json#/$defs/${name}`,
      }), name).toBeTypeOf("function");
    }

    expect(contract).toMatchObject({
      schemaVersion: 1,
      requestFile: {
        contractId: "team.identity_activity.request.v1",
        mediaType: "application/json",
        encoding: "utf-8",
        maxBytes: 65_536,
        maxDepth: 32,
        maxNodes: 4_096,
        textPolicy: {
          normalization: "NFC",
          leadingOrTrailingWhitespace: "forbidden",
          controlCharacters: "forbidden",
        },
        utf8ByteLimits: {
          operationId: 128,
          memberDisplayName: 200,
          gitAliasName: 200,
          gitAliasEmail: 320,
          entityId: 256,
          entityKind: 64,
          entityTitle: 512,
          activityAction: 128,
          workstreamTitle: 512,
          workstreamText: 8_192,
          codeIdentifierOrFingerprint: 1_024,
          repositoryPath: 4_096,
        },
      },
      applyFile: {
        contractId: "team.identity_activity.preview-envelope.v1",
        maxBytes: 65_536,
      },
    });
    expect(contract.exitCodes).toEqual([
      { code: 0, name: "ok", meaning: "Success, including exact idempotent replay." },
      {
        code: 1,
        name: "validation",
        meaning: "Validation, invalid-preview, job, or internal command failure; inspect problem.code and diagnostics.",
      },
      { code: 2, name: "usage", meaning: "Arguments, request JSON, or preview-envelope input are invalid." },
      { code: 3, name: "unavailable", meaning: "Repository state or the requested resource is unavailable." },
      { code: 4, name: "conflict", meaning: "A revision, operation, or recovery conflict prevented the action." },
      { code: 5, name: "refused", meaning: "A containment, authorization, or origin safety policy refused the action." },
    ]);

    const exampleRoot = temporaryRoot();
    for (const example of contract.requestFile.examples) {
      expect(validate(example.request), `${example.command}: ${JSON.stringify(validate.errors)}`).toBe(true);
      const validateCommand = ajv.getSchema(example.schemaRef);
      expect(validateCommand, example.schemaRef).toBeTypeOf("function");
      expect(validateCommand!(example.request), `${example.schemaRef}: ${JSON.stringify(validateCommand!.errors)}`).toBe(true);
      const requestPath = join(exampleRoot, `${example.command}.json`);
      writeFileSync(requestPath, JSON.stringify(example.request));
      const parserCommand: TeamMutationCommandName = example.command === "member.clear"
        ? "member.select"
        : example.command;
      expect(readTeamCommandFile(requestPath, parserCommand)).toEqual(example.request);
      expect(example.usage).toContain("request.json --json");
    }
    expect(contract.requestFile.examples.map((entry) => entry.command)).toEqual([
      "member.add",
      "member.update",
      "member.deactivate",
      "member.reactivate",
      "member.select",
      "member.clear",
      "activity.record",
      "workstream.create",
    ]);
    const createExample = structuredClone(
      contract.requestFile.examples.find((entry) => entry.command === "workstream.create")!.request,
    ) as any;
    createExample.action.workstream.owners = [{ kind: "git", name: null, email: null }];
    expect(validate(createExample)).toBe(false);
    const teamPreviewIds = [
      "member.add.preview",
      "member.update.preview",
      "member.deactivate.preview",
      "member.reactivate.preview",
      "member.select.preview",
      "activity.record.preview",
      "workstream.create.preview",
      "workstream.update.preview",
      "workstream.archive.preview",
    ];
    const teamApplyIds = teamPreviewIds.map((id) => id.replace(/\.preview$/u, ".apply"));
    for (const descriptor of envelope.data.commands.preview.filter((entry) => teamPreviewIds.includes(entry.id))) {
      expect(descriptor.inputContract).toMatch(/^team\.identity_activity\.request\.v1#\/\$defs\/[A-Za-z]+Request$/u);
    }
    for (const descriptor of envelope.data.commands.apply.filter((entry) => teamApplyIds.includes(entry.id))) {
      expect(descriptor.inputContract).toMatch(/^team\.identity_activity\.preview-envelope\.v1#[a-z.]+$/u);
    }
    expect(envelope.data.commands.preview.filter((entry) => teamPreviewIds.includes(entry.id))).toHaveLength(teamPreviewIds.length);
    expect(envelope.data.commands.apply.filter((entry) => teamApplyIds.includes(entry.id))).toHaveLength(teamApplyIds.length);
    expect(Buffer.byteLength(JSON.stringify(envelope), "utf8")).toBeLessThanOrEqual(CAPABILITIES_MAX_BYTES);
  });

  it("publishes strict governed Inbox request and complete-preview contracts", async () => {
    const root = readyRoot();
    const envelope = await inspectCapabilities(root, {
      inspectGraphIndex: async () => inspection("fresh"),
      inspectWikiIndex: async () => inspection("fresh"),
    });
    const contract = envelope.data.inboxCliContract;
    const resolved = inboxContractCatalogData();
    const ajv = new Ajv2020({ strict: true });
    expect(() => new Ajv2020({ strict: true }).compile(contract.requestFile.schema))
      .toThrow(/resolve reference/u);
    ajv.addSchema(resolved.catalog);
    const validateRequest = ajv.compile(contract.requestFile.schema);
    const validatePreview = ajv.compile(contract.applyFile.schema);

    expect(contract).toMatchObject({
      schemaVersion: 1,
      resolver: {
        descriptorId: "inbox.contract",
        command: "mex inbox contract --json",
        contractId: "team.inbox.contract-catalog.v1",
        maxBytes: 65_536,
      },
      requestFile: {
        contractId: "team.inbox.request.v1",
        mediaType: "application/json",
        encoding: "utf-8",
        maxBytes: 65_536,
        maxDepth: 32,
        maxNodes: 4_096,
        maxPortableSpecRequestBytes: 32_768,
      },
      applyFile: {
        contractId: "team.inbox.preview-envelope.v1",
        maxBytes: 65_536,
        maxAgeSeconds: 1_800,
      },
    });
    expect(contract.resolver.requirement).toContain("unusable until");
    expect(resolved.exitCodes).toEqual(envelope.data.teamCliContract.exitCodes);
    expect(resolved.applyFile.requirement).toContain("exact complete successful schemaVersion 1");
    expect(resolved.requestFile.schemaRef).toBe(contract.requestFile.schema.$ref);
    expect(resolved.applyFile.schemaRef).toBe(contract.applyFile.schema.$ref);

    const exampleRoot = temporaryRoot();
    expect(resolved.requestFile.examples.map((entry) => entry.command)).toEqual([
      "inbox.draft.save",
      "inbox.proposal.approve",
    ]);
    for (const example of resolved.requestFile.examples) {
      expect(validateRequest(example.request), JSON.stringify(validateRequest.errors)).toBe(true);
      const path = join(exampleRoot, `${example.command}.json`);
      writeFileSync(path, JSON.stringify(example.request));
      expect(readInboxCommandFile(path, example.command)).toEqual(example.request);
    }

    const draftSave = structuredClone(resolved.requestFile.examples[0]!.request) as any;
    draftSave.action.draft.change = {
      kind: "spec.create",
      entityKind: "requirement",
      title: "Requirement",
      body: "Bounded body.",
      status: "in_flight",
      relation: {
        type: "verified_by",
        target: { id: "mx_01ARZ3NDEKTSV4RRFFQ69G5FAV", kind: "spec" },
      },
    };
    expect(validateRequest(draftSave)).toBe(false);
    draftSave.action.draft.change.relation = {
      type: "derived_from",
      target: { id: "mx_01ARZ3NDEKTSV4RRFFQ69G5FAV", kind: "spec" },
    };
    draftSave.action.draft.targetRevisions = [{
      target: { kind: "entity", id: "mx_01ARZ3NDEKTSV4RRFFQ69G5FAV" },
      revision: "a".repeat(64),
      semanticRevision: 1,
    }];
    expect(validateRequest(draftSave)).toBe(true);
    draftSave.action.draftId = "draft-1";
    expect(validateRequest(draftSave)).toBe(false);
    draftSave.expectedRevisions = [{
      target: { kind: "local", namespace: "inbox-draft", id: "draft-1" },
      revision: "a".repeat(64),
    }];
    expect(validateRequest(draftSave)).toBe(true);

    const preview = {
      schemaVersion: 1,
      command: "inbox.draft.save",
      mode: "preview",
      ok: true,
      data: {
        schemaVersion: 1,
        request: resolved.requestFile.examples[0]!.request,
        preview: { valid: true, scope: "local", changes: [], localChanges: [], diagnostics: [] },
        receipt: {
          schemaVersion: 1,
          authority: {
            actor: { kind: "unknown" },
            occurredAt: "2026-08-28T00:00:00.000Z",
            repoState: { branch: "main", head: "a".repeat(40), dirty: false, observedAt: "2026-08-28T00:00:00.000Z" },
          },
          purposeIds: [{ purpose: "inbox-draft", id: "draft-1" }],
          requestRevision: "a".repeat(64),
          presentationRevision: "b".repeat(64),
          previewRevision: "c".repeat(64),
        },
      },
      diagnostics: [],
      problem: null,
    };
    expect(validatePreview(preview), JSON.stringify(validatePreview.errors)).toBe(true);
    expect(validatePreview({ ...preview, receipt: {} })).toBe(false);
    expect(validatePreview({ ...preview, extra: true })).toBe(false);

    expect(resolved.requestFile.schemaScope).toContain("action-specific cardinality");
    expect(resolved.requestFile.runtimeConstraints.map((entry) => entry.id)).toEqual([
      "dependency-expectation-target-equality",
      "action-expectation-target-equality",
      "external-evidence-url-validity",
    ]);
    expect(resolved.applyFile.runtimeConstraints.map((entry) => entry.id)).toEqual([
      "command-action-equality",
      "diagnostic-projection-equality",
      "signed-revision-equality",
    ]);

    const diagnosticPath = join(exampleRoot, "diagnostic-preview.json");
    const validDiagnostic = {
      code: "INBOX_TEST",
      severity: "warning",
      message: "Review the governed target.",
      path: "specs/release.md",
      location: { path: "specs/release.md", startLine: 1, endLine: 2, startOffset: 0, endOffset: 10, headingDepth: 2 },
      entity: { id: "mx_01ARZ3NDEKTSV4RRFFQ69G5FAV", kind: "spec", title: "Release" },
      remediation: [{ label: "Inspect", command: "mex inbox draft list --json", route: "/inbox" }],
      detail: { nested: [true, 1, null, { value: "safe" }] },
    };
    const diagnosticCases = [
      { name: "complete diagnostic", value: validDiagnostic, valid: true },
      { name: "numeric path", value: { ...validDiagnostic, path: 123 }, valid: false },
      { name: "string location", value: { ...validDiagnostic, location: "bad" }, valid: false },
      { name: "array entity", value: { ...validDiagnostic, entity: [] }, valid: false },
      { name: "string remediation", value: { ...validDiagnostic, remediation: "bad" }, valid: false },
      { name: "array detail", value: { ...validDiagnostic, detail: [] }, valid: false },
    ];
    for (const entry of diagnosticCases) {
      const candidate = structuredClone(preview) as any;
      candidate.diagnostics = [entry.value];
      candidate.data.preview.diagnostics = [entry.value];
      expect(validatePreview(candidate), `${entry.name}: ${JSON.stringify(validatePreview.errors)}`).toBe(entry.valid);
      writeFileSync(diagnosticPath, JSON.stringify(candidate));
      expectParserAcceptance(diagnosticPath, "inbox.draft.save", entry.valid, entry.name);
    }

    const arbitraryGitIdentity = structuredClone(preview) as any;
    arbitraryGitIdentity.data.receipt.authority.actor = { kind: "git", name: "Local Identity", email: "local-identity" };
    expect(validatePreview(arbitraryGitIdentity), JSON.stringify(validatePreview.errors)).toBe(true);
    writeFileSync(diagnosticPath, JSON.stringify(arbitraryGitIdentity));
    expectParserAcceptance(diagnosticPath, "inbox.draft.save", true, "arbitrary bounded Git email");

    const invalidTimestamp = structuredClone(preview) as any;
    invalidTimestamp.data.receipt.authority.occurredAt = "2026-99-99T00:00:00.000Z";
    expect(validatePreview(invalidTimestamp)).toBe(false);
    writeFileSync(diagnosticPath, JSON.stringify(invalidTimestamp));
    expectParserAcceptance(diagnosticPath, "inbox.draft.save", false, "invalid calendar timestamp");

    const commandMismatch = structuredClone(preview) as any;
    commandMismatch.command = "inbox.publish";
    expect(validatePreview(commandMismatch)).toBe(false);
    writeFileSync(diagnosticPath, JSON.stringify(commandMismatch));
    expectParserAcceptance(diagnosticPath, "inbox.publish", false, "wrapper/action mismatch");

    const previewSingleLineCases = [
      {
        name: "whitespace local summary",
        mutate(candidate: any) {
          candidate.data.preview.localChanges = [{
            namespace: "inbox-draft", id: "draft-1", beforeRevision: null,
            afterRevision: "d".repeat(64), summary: "   ",
          }];
        },
      },
      {
        name: "trim-invalid local summary",
        mutate(candidate: any) {
          candidate.data.preview.localChanges = [{
            namespace: "inbox-draft", id: "draft-1", beforeRevision: null,
            afterRevision: "d".repeat(64), summary: " padded ",
          }];
        },
      },
      ...[
        ["diagnostic code", { ...validDiagnostic, code: " CODE" }],
        ["diagnostic message", { ...validDiagnostic, message: " " }],
        ["remediation label", { ...validDiagnostic, remediation: [{ label: " " }] }],
        ["remediation command", { ...validDiagnostic, remediation: [{ label: "Inspect", command: " command " }] }],
        ["remediation route", { ...validDiagnostic, remediation: [{ label: "Inspect", route: " /inbox " }] }],
      ].map(([name, diagnostic]) => ({
        name: name as string,
        mutate(candidate: any) {
          candidate.diagnostics = [diagnostic];
          candidate.data.preview.diagnostics = [diagnostic];
        },
      })),
      {
        name: "member display name",
        mutate(candidate: any) {
          candidate.data.receipt.authority.actor = {
            kind: "member", memberId: "member_01ARZ3NDEKTSV4RRFFQ69G5FAV", displayName: " Member ",
          };
        },
      },
      {
        name: "Git name",
        mutate(candidate: any) { candidate.data.receipt.authority.actor = { kind: "git", name: " Git ", email: null }; },
      },
      {
        name: "Git email",
        mutate(candidate: any) { candidate.data.receipt.authority.actor = { kind: "git", name: null, email: " identity " }; },
      },
      {
        name: "repository branch",
        mutate(candidate: any) { candidate.data.receipt.authority.repoState.branch = " main "; },
      },
      {
        name: "unsafe location integer",
        mutate(candidate: any) {
          const diagnostic = { ...validDiagnostic, location: { path: "specs/release.md", startLine: 9_007_199_254_740_992 } };
          candidate.diagnostics = [diagnostic];
          candidate.data.preview.diagnostics = [diagnostic];
        },
      },
    ];
    for (const entry of previewSingleLineCases) {
      const candidate = structuredClone(preview) as any;
      entry.mutate(candidate);
      expect(validatePreview(candidate), `${entry.name}: ${JSON.stringify(validatePreview.errors)}`).toBe(false);
      writeFileSync(diagnosticPath, JSON.stringify(candidate));
      expectParserAcceptance(diagnosticPath, "inbox.draft.save", false, entry.name);
    }

    const publishPreview = structuredClone(preview) as any;
    publishPreview.command = "inbox.publish";
    publishPreview.data.request = {
      operationId: "publish-preview-parity",
      action: { kind: "inbox.publish", draftId: "draft-1" },
      expectedRevisions: [{
        target: { kind: "local", namespace: "inbox-draft", id: "draft-1" },
        revision: "a".repeat(64),
      }],
    };
    publishPreview.data.receipt.purposeIds = [
      { purpose: "activity", id: "event_01ARZ3NDEKTSV4RRFFQ69G5FAV" },
      { purpose: "proposal", id: "proposal_01ARZ3NDEKTSV4RRFFQ69G5FAV" },
    ];
    const purposeCases = [
      { name: "publish purposes", values: publishPreview.data.receipt.purposeIds, valid: true },
      { name: "missing publish purpose", values: publishPreview.data.receipt.purposeIds.slice(0, 1), valid: false },
      { name: "reversed publish purposes", values: [...publishPreview.data.receipt.purposeIds].reverse(), valid: false },
      { name: "duplicate purpose", values: [publishPreview.data.receipt.purposeIds[0], publishPreview.data.receipt.purposeIds[0]], valid: false },
      { name: "duplicate ID", values: [publishPreview.data.receipt.purposeIds[0], { purpose: "proposal", id: publishPreview.data.receipt.purposeIds[0].id }], valid: false },
      { name: "invalid activity ID", values: [{ purpose: "activity", id: "event_Z1ARZ3NDEKTSV4RRFFQ69G5FAV" }, publishPreview.data.receipt.purposeIds[1]], valid: false },
    ];
    for (const entry of purposeCases) {
      const candidate = structuredClone(publishPreview) as any;
      candidate.data.receipt.purposeIds = entry.values;
      expect(validatePreview(candidate), `${entry.name}: ${JSON.stringify(validatePreview.errors)}`).toBe(entry.valid);
      writeFileSync(diagnosticPath, JSON.stringify(candidate));
      expectParserAcceptance(diagnosticPath, "inbox.publish", entry.valid, entry.name);
    }

    const revision = "d".repeat(64);
    const fileChangeCases = [
      {
        name: "create",
        valid: true,
        change: { kind: "create", path: "specs/new.md", diff: "+new", beforeRevision: null, afterRevision: revision },
      },
      {
        name: "repository path with spaces",
        valid: true,
        change: { kind: "create", path: " specs/new file.md ", diff: "+new", beforeRevision: null, afterRevision: revision },
      },
      {
        name: "update",
        valid: true,
        change: { kind: "update", path: "specs/current.md", diff: "-old\n+new", beforeRevision: revision, afterRevision: revision },
      },
      {
        name: "delete",
        valid: true,
        change: { kind: "delete", path: "specs/old.md", diff: "-old", beforeRevision: revision, afterRevision: null },
      },
      {
        name: "move",
        valid: true,
        change: { kind: "move", path: "specs/new.md", previousPath: "specs/old.md", diff: "move", beforeRevision: revision, afterRevision: revision },
      },
      {
        name: "move without previousPath",
        valid: false,
        change: { kind: "move", path: "specs/new.md", diff: "move", beforeRevision: revision, afterRevision: revision },
      },
      {
        name: "update with previousPath",
        valid: false,
        change: { kind: "update", path: "specs/new.md", previousPath: "specs/old.md", diff: "update", beforeRevision: revision, afterRevision: revision },
      },
      {
        name: "create with existing revision",
        valid: false,
        change: { kind: "create", path: "specs/new.md", diff: "+new", beforeRevision: revision, afterRevision: revision },
      },
      {
        name: "delete with surviving revision",
        valid: false,
        change: { kind: "delete", path: "specs/old.md", diff: "-old", beforeRevision: revision, afterRevision: revision },
      },
    ];
    const previewPath = join(exampleRoot, "file-change-preview.json");
    for (const entry of fileChangeCases) {
      const candidate = structuredClone(preview) as any;
      candidate.data.preview.changes = [entry.change];
      expect(validatePreview(candidate), `${entry.name}: ${JSON.stringify(validatePreview.errors)}`)
        .toBe(entry.valid);
      writeFileSync(previewPath, JSON.stringify(candidate));
      let parserAccepted = true;
      try {
        readInboxPreviewFile(previewPath, "inbox.draft.save");
      } catch {
        parserAccepted = false;
      }
      expect(parserAccepted, entry.name).toBe(entry.valid);
    }

    const validConstraintRelation = structuredClone(resolved.requestFile.examples[0]!.request) as any;
    validConstraintRelation.action.draft.change = {
      kind: "spec.create",
      entityKind: "constraint",
      title: "Constraint",
      body: "Bounded body.",
      status: "in_flight",
      relation: {
        type: "constrained_by",
        target: { id: "mx_01ARZ3NDEKTSV4RRFFQ69G5FAV", kind: "constraint" },
      },
    };
    validConstraintRelation.action.draft.targetRevisions = [{
      target: { kind: "entity", id: "mx_01ARZ3NDEKTSV4RRFFQ69G5FAV" },
      revision: "a".repeat(64),
      semanticRevision: 1,
    }];
    const invalidNewSaveExpectation = structuredClone(resolved.requestFile.examples[0]!.request) as any;
    invalidNewSaveExpectation.expectedRevisions = [{
      target: { kind: "local", namespace: "inbox-draft", id: "draft-1" },
      revision: "a".repeat(64),
    }];
    const invalidProposalCardinality = structuredClone(resolved.requestFile.examples[1]!.request) as any;
    invalidProposalCardinality.expectedRevisions = [];
    const relationMissingExpectation = structuredClone(validConstraintRelation) as any;
    relationMissingExpectation.action.draft.targetRevisions = [];
    const dependencyFreeUnrelatedExpectation = structuredClone(resolved.requestFile.examples[0]!.request) as any;
    dependencyFreeUnrelatedExpectation.action.draft.targetRevisions = validConstraintRelation.action.draft.targetRevisions;
    const updateMissingExpectation = structuredClone(resolved.requestFile.examples[0]!.request) as any;
    updateMissingExpectation.action.draft.change = {
      kind: "spec.update",
      target: { id: "mx_01ARZ3NDEKTSV4RRFFQ69G5FAV", kind: "spec" },
      patch: { body: "Updated scope." },
    };
    const paddedProseUpdate = structuredClone(resolved.requestFile.examples[0]!.request) as any;
    paddedProseUpdate.action.draft.change = {
      kind: "spec.update",
      target: { id: "mx_01ARZ3NDEKTSV4RRFFQ69G5FAV", kind: "spec", title: "  Existing\nSpec  " },
      patch: { title: "  Revised\nTitle  " },
    };
    paddedProseUpdate.action.draft.evidence = [{ kind: "manual", note: "  Manual\nnote  " }];
    paddedProseUpdate.action.draft.targetRevisions = validConstraintRelation.action.draft.targetRevisions;
    const paddedReject = structuredClone(resolved.requestFile.examples[1]!.request) as any;
    paddedReject.action = {
      kind: "inbox.reject", proposalId: "proposal_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      rationale: "  Reviewed\nreason  ",
    };
    const whitespaceReject = structuredClone(paddedReject) as any;
    whitespaceReject.action.rationale = "\t\n";
    const whitespaceWithdraw = structuredClone(paddedReject) as any;
    whitespaceWithdraw.action = {
      kind: "inbox.withdraw", proposalId: "proposal_01ARZ3NDEKTSV4RRFFQ69G5FAV", rationale: "  ",
    };
    const spacedEvidencePath = structuredClone(resolved.requestFile.examples[0]!.request) as any;
    spacedEvidencePath.action.draft.evidence = [{ kind: "file", path: " docs/review file.md " }];
    const requestHostileCases = [
      ["whitespace title", (value: any) => { value.action.draft.change.title = "   "; }],
      ["whitespace body", (value: any) => { value.action.draft.change.body = "\t\n"; }],
      ["whitespace rationale", (value: any) => { value.action.draft.rationale = " \t\n"; }],
      ["whitespace manual note", (value: any) => { value.action.draft.evidence = [{ kind: "manual", note: "\t\n" }]; }],
      ["trim-invalid evidence ref", (value: any) => { value.action.draft.evidence = [{ kind: "entity", entity: { id: " entity ", kind: "spec" } }]; }],
      ["trim-invalid external label", (value: any) => { value.action.draft.evidence = [{ kind: "external", uri: "https://example.test/evidence", label: " Label " }]; }],
      ["upper-case URL scheme", (value: any) => { value.action.draft.evidence = [{ kind: "external", uri: "HTTPS://example.test/evidence" }]; }],
      ["non-absolute URL spelling", (value: any) => { value.action.draft.evidence = [{ kind: "external", uri: "http:example.test" }]; }],
      ["URL with internal whitespace", (value: any) => { value.action.draft.evidence = [{ kind: "external", uri: "https://example.test/a b" }]; }],
      ["missing URL host", (value: any) => { value.action.draft.evidence = [{ kind: "external", uri: "https://" }]; }],
      ["unsafe semantic revision", (value: any) => {
        value.action.draft.change = structuredClone(validConstraintRelation.action.draft.change);
        value.action.draft.targetRevisions = structuredClone(validConstraintRelation.action.draft.targetRevisions);
        value.action.draft.targetRevisions[0].semanticRevision = 9_007_199_254_740_992;
      }],
    ] as const;
    const extraField = structuredClone(resolved.requestFile.examples[0]!.request) as any;
    extraField.extra = true;
    const parityCases = [
      { name: "valid draft", command: "inbox.draft.save" as const, request: resolved.requestFile.examples[0]!.request, valid: true },
      { name: "valid constraint relation", command: "inbox.draft.save" as const, request: validConstraintRelation, valid: true },
      { name: "wrong relation direction", command: "inbox.draft.save" as const, request: (() => {
        const value = structuredClone(resolved.requestFile.examples[0]!.request) as any;
        value.action.draft.change = {
          kind: "spec.create",
          entityKind: "requirement",
          title: "Requirement",
          body: "Bounded body.",
          status: "in_flight",
          relation: {
          type: "verified_by",
          target: { id: "mx_01ARZ3NDEKTSV4RRFFQ69G5FAV", kind: "spec" },
          },
        };
        return value;
      })(), valid: false },
      { name: "new save expectation", command: "inbox.draft.save" as const, request: invalidNewSaveExpectation, valid: false },
      { name: "proposal cardinality", command: "inbox.proposal.approve" as const, request: invalidProposalCardinality, valid: false },
      { name: "relation dependency missing", command: "inbox.draft.save" as const, request: relationMissingExpectation, valid: false },
      { name: "dependency-free create unrelated expectation", command: "inbox.draft.save" as const, request: dependencyFreeUnrelatedExpectation, valid: false },
      { name: "update target expectation missing", command: "inbox.draft.save" as const, request: updateMissingExpectation, valid: false },
      { name: "padded multiline Inbox prose", command: "inbox.draft.save" as const, request: paddedProseUpdate, valid: true },
      { name: "padded lifecycle rationale", command: "inbox.proposal.reject" as const, request: paddedReject, valid: true },
      { name: "whitespace reject rationale", command: "inbox.proposal.reject" as const, request: whitespaceReject, valid: false },
      { name: "whitespace withdraw rationale", command: "inbox.proposal.withdraw" as const, request: whitespaceWithdraw, valid: false },
      { name: "repository evidence path with spaces", command: "inbox.draft.save" as const, request: spacedEvidencePath, valid: true },
      ...requestHostileCases.map(([name, mutate]) => {
        const request = structuredClone(resolved.requestFile.examples[0]!.request) as any;
        mutate(request);
        return { name, command: "inbox.draft.save" as const, request, valid: false };
      }),
      { name: "extra root field", command: "inbox.draft.save" as const, request: extraField, valid: false },
    ];
    const parityPath = join(exampleRoot, "parity.json");
    for (const entry of parityCases) {
      expect(validateRequest(entry.request), `${entry.name}: ${JSON.stringify(validateRequest.errors)}`)
        .toBe(entry.valid);
      writeFileSync(parityPath, JSON.stringify(entry.request));
      let runtimeAccepted = true;
      try {
        readInboxCommandFile(parityPath, entry.command);
      } catch {
        runtimeAccepted = false;
      }
      expect(runtimeAccepted, entry.name).toBe(entry.valid);
    }

    const hostile = structuredClone(resolved.requestFile.examples[0]!.request) as any;
    hostile.action.draft.change.body = "é".repeat(8_193);
    expect(validateRequest(hostile)).toBe(true);
    const hostilePath = join(exampleRoot, "multibyte.json");
    writeFileSync(hostilePath, JSON.stringify(hostile));
    expect(() => readInboxCommandFile(hostilePath, "inbox.draft.save")).toThrow();
    hostile.action.draft.change.body = "safe";
    hostile.action.draft.change.title = "e\u0301";
    writeFileSync(hostilePath, JSON.stringify(hostile));
    expect(() => readInboxCommandFile(hostilePath, "inbox.draft.save")).toThrow();
    hostile.action.draft.change.title = "bad\u0001title";
    writeFileSync(hostilePath, JSON.stringify(hostile));
    expect(() => readInboxCommandFile(hostilePath, "inbox.draft.save")).toThrow();

    const inboxPreview = envelope.data.commands.preview.filter((entry) => entry.id.startsWith("inbox."));
    const inboxApply = envelope.data.commands.apply.filter((entry) => entry.id.startsWith("inbox."));
    expect(inboxPreview).toHaveLength(8);
    expect(inboxApply).toHaveLength(8);
    expect(inboxPreview.every((entry) => entry.inputContract === "https://mex.dev/contracts/team-inbox-request-v1.json")).toBe(true);
    expect(inboxApply.every((entry) => entry.inputContract === "https://mex.dev/contracts/team-inbox-preview-envelope-v1.json"))
      .toBe(true);
    expect([...inboxPreview, ...inboxApply].every((entry) => entry.contractResolver === "inbox.contract"))
      .toBe(true);
    expect(envelope.data.commands.read.find((entry) => entry.id === "inbox.contract")).toMatchObject({
      path: "mex inbox contract",
      usage: "mex inbox contract --json",
      contractResolver: "inbox.contract",
    });
  });

  it("returns success with safe missing-index states and a concrete next action", async () => {
    const root = readyRoot();
    const writes: string[] = [];
    const setExitCode = vi.fn();

    const envelope = await runCapabilities({
      cwd: root,
      write: (line) => writes.push(line),
      setExitCode,
      dependencies: {
        inspectGraphIndex: async () => inspection("missing", [{
          code: "GRAPH_INDEX_MISSING",
          message: "The local code-graph index does not exist.",
          remediation: [{ command: "mex graph rebuild" }],
        }]),
        inspectWikiIndex: async () => inspection("missing"),
      },
    });

    expect(envelope).toMatchObject({
      ok: true,
      data: {
        repository: { graphIndexState: "missing", wikiIndexState: "missing" },
        nextInitializationAction: { command: "mex graph rebuild --json" },
      },
    });
    expect(setExitCode).not.toHaveBeenCalled();
    expect(writes).toEqual([JSON.stringify(envelope)]);
  });

  it("surfaces migration as preview first and never claims stale Graph reads are available", async () => {
    const root = readyRoot();
    const envelope = await inspectCapabilities(root, {
      inspectGraphIndex: async () => inspection("stale", [{
        code: "GRAPH_SOURCE_CORPUS_MISMATCH",
        message: "The source corpus changed.",
        remediation: [{ command: "mex graph refresh" }],
      }]),
      inspectWikiIndex: async () => inspection("migration_required"),
    });

    expect(envelope.data.nextInitializationAction).toEqual({
      command: "mex graph refresh --json",
      reason: "Refresh the stale Code Graph index.",
    });
    expect(envelope.data.commands.read.map((entry) => entry.id)).not.toContain("graph.scope");
    expect(envelope.data.commands.preview.map((entry) => entry.usage)).toContain(
      "mex wiki migrate --dry-run --json",
    );
    expect(envelope.data.commands.apply.map((entry) => entry.usage)).toContain("mex wiki migrate --json");
  });

  it("advertises Inbox partial availability and keeps mark-stale discoverable on stale Wiki state", async () => {
    const root = readyRoot();
    const stale = await inspectCapabilities(root, {
      inspectGraphIndex: async () => inspection("fresh"),
      inspectWikiIndex: async () => inspection("stale"),
    });
    expect(stale.data.capabilities.find((entry) => entry.id === "team_inbox")).toMatchObject({
      availability: "available",
      unavailableReason: null,
    });
    expect(stale.data.capabilities.find((entry) => entry.id === "spec_authoring")).toMatchObject({
      availability: "unavailable",
      unavailableReason: { code: "WIKI_INDEX_STALE" },
    });
    const read = stale.data.commands.read.map((entry) => entry.id);
    const preview = stale.data.commands.preview.map((entry) => entry.id);
    const apply = stale.data.commands.apply.map((entry) => entry.id);
    expect(read).toEqual(expect.arrayContaining([
      "inbox.draft.list", "inbox.draft.show", "inbox.proposal.list", "inbox.proposal.show",
    ]));
    expect(preview).toEqual(expect.arrayContaining([
      "inbox.draft.save.preview", "inbox.draft.delete.preview",
      "inbox.proposal.reject.preview", "inbox.proposal.withdraw.preview",
      "inbox.proposal.mark_stale.preview",
    ]));
    expect(apply).toContain("inbox.proposal.mark_stale.apply");
    expect(preview).not.toEqual(expect.arrayContaining([
      "inbox.publish.preview", "inbox.proposal.approve.preview", "inbox.proposal.repair.preview",
    ]));
  });

  it("reports corpus ceilings as capability-only states without doomed maintenance commands", async () => {
    const root = readyRoot();
    const graphLimited = await inspectCapabilities(root, {
      inspectGraphIndex: async () => ({
        state: "degraded",
        diagnostics: [{
          code: "GRAPH_SOURCE_CORPUS_LIMIT_EXCEEDED",
          message: "The supported source corpus exceeds MEX's bounded inspection policy.",
          remediation: [{ command: "mex graph rebuild" }],
        }],
      }),
      inspectWikiIndex: async () => inspection("fresh"),
    });

    expect(graphLimited.data.repository.graphIndexState).toBe("corpus_limit_exceeded");
    expect(graphLimited.data.capabilities.find((entry) => entry.id === "code_graph")?.unavailableReason?.code)
      .toBe("GRAPH_CORPUS_LIMIT_EXCEEDED");
    expect(graphLimited.data.commands.apply.map((entry) => entry.id))
      .not.toContain("graph.rebuild");
    expect(graphLimited.data.nextInitializationAction).toEqual({
      command: null,
      reason: "Manually narrow the Code Graph corpus, then run mex capabilities --json again.",
    });

    const wikiLimited = await inspectCapabilities(root, {
      inspectGraphIndex: async () => inspection("fresh"),
      inspectWikiIndex: async () => ({
        state: "degraded",
        diagnostics: [{
          code: "WIKI_PARSE_ERROR",
          message: "The canonical Wiki corpus exceeds MEX's bounded inspection policy.",
        }],
      }),
    });

    expect(wikiLimited.data.repository.wikiIndexState).toBe("corpus_limit_exceeded");
    expect(wikiLimited.data.capabilities.find((entry) => entry.id === "wiki")?.unavailableReason?.code)
      .toBe("WIKI_CORPUS_LIMIT_EXCEEDED");
    expect(wikiLimited.data.commands.read.map((entry) => entry.id)).not.toContain("wiki.validate");
    expect(wikiLimited.data.commands.apply.map((entry) => entry.id))
      .not.toContain("wiki.rebuild_index");
    expect(wikiLimited.data.nextInitializationAction).toEqual({
      command: null,
      reason: "Manually narrow wiki.exclude or the canonical Wiki corpus, then run mex capabilities --json again.",
    });
  });

  it("preserves Graph status remediation safety in advertised maintenance and next actions", async () => {
    const root = readyRoot();
    const unsafe = await inspectCapabilities(root, {
      inspectGraphIndex: async () => inspection("missing", [{
        code: "GRAPH_INDEX_MISSING",
        message: "The graph is missing, but build prerequisites could not be inspected.",
        remediation: [{}],
      }]),
      inspectWikiIndex: async () => inspection("fresh"),
    });

    expect(unsafe.data.commands.apply.map((entry) => entry.id)).not.toContain("graph.rebuild");
    expect(unsafe.data.nextInitializationAction).toEqual({
      command: null,
      reason: "Resolve the Code Graph status diagnostics, then run mex capabilities --json again.",
    });

    const safe = await inspectCapabilities(root, {
      inspectGraphIndex: async () => inspection("missing", [{
        code: "GRAPH_INDEX_MISSING",
        message: "The graph is missing and build prerequisites are complete.",
        remediation: [{ command: "mex graph rebuild" }],
      }]),
      inspectWikiIndex: async () => inspection("fresh"),
    });

    expect(safe.data.commands.apply.map((entry) => entry.id)).toContain("graph.rebuild");
    expect(safe.data.nextInitializationAction?.command).toBe("mex graph rebuild --json");

    const repairable = await inspectCapabilities(root, {
      inspectGraphIndex: async () => inspection("degraded", [{
        code: "GRAPH_INDEX_SIDECAR_ACTIVE",
        message: "A stranded WAL prevents immutable reads.",
        remediation: [{ command: "mex graph repair" }],
      }]),
      inspectWikiIndex: async () => inspection("fresh"),
    });
    expect(repairable.data.commands.apply.map((entry) => entry.id)).toContain("graph.repair");
    expect(repairable.data.commands.apply.map((entry) => entry.id)).not.toContain("graph.refresh");
    expect(repairable.data.nextInitializationAction).toEqual({
      command: "mex graph repair --json",
      reason: "Repair the recognized Code Graph index safely.",
    });
  });

  it("suppresses Team commands when the tracked scaffold identity has changed", async () => {
    const root = readyRoot();
    writeFileSync(join(root, ".mex", "config.json"), JSON.stringify({
      scaffold_id: "scaffold-capabilities-changed",
    }));

    const envelope = await inspectCapabilities(root, {
      inspectGraphIndex: async () => inspection("fresh"),
      inspectWikiIndex: async () => inspection("fresh"),
    });

    for (const id of ["project_hub", "team_identity", "activity_read", "activity_record"] as const) {
      expect(envelope.data.capabilities.find((entry) => entry.id === id)).toMatchObject({
        availability: "unavailable",
        unavailableReason: { code: "TEAM_SCAFFOLD_IDENTITY_CHANGED" },
      });
    }
    expect(JSON.stringify(envelope.data.commands)).not.toMatch(/mex (?:member|activity) /u);
    expect(envelope.data.nextInitializationAction).toEqual({
      command: null,
      reason: "Review and commit the intended .mex/config.json, then run mex capabilities --json again.",
    });
  });

  it("keeps Team available when Git itself rewrote the working copy's line endings", async () => {
    // `core.autocrlf` defaults to true on Windows: Git stores LF and writes
    // CRLF into the working tree, so the working copy and the blob at HEAD
    // differ by one byte per line on a tree Git reports as unmodified. The
    // old byte-for-byte comparison reported all eight Team capabilities as
    // TEAM_SCAFFOLD_IDENTITY_CHANGED to everyone who cloned the repository —
    // and never to the person who ran `mex setup`, whose working copy Git
    // never rewrote.
    //
    // `git checkout -- <path>` puts a checkout into the state a clone produces
    // in one line, which is what makes this testable here rather than only
    // against a real clone.
    const root = temporaryRoot();
    mkdirSync(join(root, ".mex"));
    writeFileSync(join(root, ".mex", "ROUTER.md"), "# Router\n");
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    execFileSync("git", ["config", "user.email", "capabilities@example.invalid"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Capabilities Contract"], { cwd: root });
    execFileSync("git", ["config", "core.autocrlf", "true"], { cwd: root });
    // Multi-line on purpose: a single-line file has no line ending to convert
    // and the defect does not reproduce.
    writeFileSync(
      join(root, ".mex", "config.json"),
      `${JSON.stringify({ scaffold_id: "scaffold-capabilities-crlf", version: 1 }, null, 2)}\n`,
    );
    execFileSync("git", ["add", ".mex/ROUTER.md", ".mex/config.json"], { cwd: root });
    execFileSync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: root });

    // Let Git write the working copy, exactly as a clone would.
    rmSync(join(root, ".mex", "config.json"));
    execFileSync("git", ["checkout", "--", ".mex/config.json"], { cwd: root });

    const working = readFileSync(join(root, ".mex", "config.json"));
    const blob = execFileSync("git", ["cat-file", "blob", "HEAD:.mex/config.json"], { cwd: root });
    // Not vacuous: the bytes genuinely differ and Git still calls the tree clean.
    expect(working.includes(Buffer.from("\r\n"))).toBe(true);
    expect(blob.equals(working)).toBe(false);
    expect(execFileSync("git", ["diff", "--name-only"], { cwd: root }).toString()).toBe("");

    const envelope = await inspectCapabilities(root, {
      inspectGraphIndex: async () => inspection("fresh"),
      inspectWikiIndex: async () => inspection("fresh"),
    });

    for (const entry of envelope.data.capabilities) {
      expect(entry.unavailableReason?.code).not.toBe("TEAM_SCAFFOLD_IDENTITY_CHANGED");
    }
    for (const id of ["project_hub", "team_identity", "activity_read", "activity_record"] as const) {
      expect(envelope.data.capabilities.find((entry) => entry.id === id)).toMatchObject({
        availability: "available",
      });
    }
  });

  it("withholds Team capabilities after a CRLF-only config edit between exact reads", async () => {
    const root = readyRoot();
    execFileSync("git", ["config", "core.autocrlf", "true"], { cwd: root });
    const path = join(root, ".mex/config.json");
    const original = `${JSON.stringify({ scaffold_id: "capabilities-config-race" }, null, 2)}\n`;
    writeFileSync(path, original);
    execFileSync("git", ["add", ".mex/config.json"], { cwd: root });
    execFileSync("git", ["commit", "--quiet", "-m", "track config"], { cwd: root });
    const createGit = repositoryGit.createRepositoryGitPort;
    vi.spyOn(repositoryGit, "createRepositoryGitPort").mockImplementation((...args) => {
      const port = createGit(...args);
      const read = port.readFileAtRevision.bind(port);
      vi.spyOn(port, "readFileAtRevision").mockImplementation(async (request) => {
        const result = await read(request);
        writeFileSync(path, original.replaceAll("\n", "\r\n"));
        return result;
      });
      return port;
    });
    const result = await inspectCapabilities(root, {
      inspectGraphIndex: async () => inspection("fresh"),
      inspectWikiIndex: async () => inspection("fresh"),
    });
    expect(result.data.capabilities.find((entry) => entry.id === "team_identity"))
      .toMatchObject({ unavailableReason: { code: "TEAM_STATE_UNAVAILABLE" } });
    expect(readFileSync(path, "utf8")).toBe(original.replaceAll("\n", "\r\n"));
    expect(execFileSync("git", ["diff", "--name-only"], { cwd: root }).toString()).toBe("");
  });

  it("does not advertise Wiki rebuild for degraded, migration, corrupt, or unavailable states", async () => {
    const root = readyRoot();
    for (const state of ["degraded", "migration_required", "corrupt"] as const) {
      const envelope = await inspectCapabilities(root, {
        inspectGraphIndex: async () => inspection("fresh"),
        inspectWikiIndex: async () => inspection(state),
      });
      expect(envelope.data.commands.apply.map((entry) => entry.id), state)
        .not.toContain("wiki.rebuild_index");
    }
  });

  it("classifies an over-limit Wiki corpus before advertising a missing-index rebuild", async () => {
    const root = readyRoot();
    let deepWikiDirectory = join(root, ".mex");
    for (let depth = 0; depth <= WIKI_CORPUS_LIMITS.maxDirectoryDepth; depth += 1) {
      deepWikiDirectory = join(deepWikiDirectory, `depth-${depth}`);
    }
    mkdirSync(deepWikiDirectory, { recursive: true });
    writeFileSync(join(deepWikiDirectory, "too-deep.md"), "# Too deep\n");

    const envelope = await inspectCapabilities(root, {
      inspectGraphIndex: async () => inspection("fresh"),
    });

    expect(envelope.data.repository.wikiIndexState).toBe("corpus_limit_exceeded");
    expect(envelope.data.commands.apply.map((entry) => entry.id)).not.toContain("wiki.rebuild_index");
    expect(envelope.data.nextInitializationAction).toEqual({
      command: null,
      reason: "Manually narrow wiki.exclude or the canonical Wiki corpus, then run mex capabilities --json again.",
    });

    const oversizedRoot = readyRoot();
    writeFileSync(join(oversizedRoot, ".mex", "a-canonical.md"), "---\nmex:\n  id: note:canonical\n---\n");
    writeFileSync(
      join(oversizedRoot, ".mex", "z-oversized.md"),
      "x".repeat(WIKI_CORPUS_LIMITS.maxFileBytes + 1),
    );
    const oversized = await inspectCapabilities(oversizedRoot, {
      inspectGraphIndex: async () => inspection("fresh"),
    });
    expect(oversized.data.repository.wikiIndexState).toBe("corpus_limit_exceeded");
    expect(oversized.data.commands.apply.map((entry) => entry.id)).not.toContain("wiki.rebuild_index");
  });

  it("uses the real initialized-index inspectors without writes or outbound requests", async () => {
    // Keep readyRoot's committed repository intact: this test covers initialized
    // index reads, not Git repository replacement.
    const root = readyRoot();
    const home = temporaryRoot();
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "example.ts"), "export const example = 1;\n");
    writeFileSync(join(root, ".mex", "config.json"), JSON.stringify({
      scaffold_id: "scaffold-capabilities-001",
      aiTools: ["claude"],
    }));
    execFileSync("git", ["add", "src/example.ts", ".mex/ROUTER.md", ".mex/config.json"], { cwd: root });
    execFileSync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: root });
    const graph = createGraphEngine({ rootDir: root, dbPath: join(root, ".mex", "graph.db") });
    try {
      await graph.build();
    } finally {
      graph.close();
    }
    rebuildWikiIndex({ scaffoldRoot: join(root, ".mex") });
    const projectBefore = snapshotTree(root);
    const homeBefore = snapshotTree(home);
    const originalHome = process.env.HOME;
    process.env.HOME = home;
    const socketConnect = vi.spyOn(Socket.prototype, "connect").mockImplementation((() => {
      throw new Error("Outbound network access is forbidden during capability discovery.");
    }) as typeof Socket.prototype.connect);
    const fetchCall = vi.fn(async () => {
      throw new Error("Outbound fetch is forbidden during capability discovery.");
    });
    vi.stubGlobal("fetch", fetchCall);

    try {
      const envelope = await inspectCapabilities(root);
      expect(envelope.ok).toBe(true);
      expect(envelope.data.repository.initializationState).toBe("ready");
      expect(envelope.data.repository.graphIndexState).toBe("fresh");
      expect(envelope.data.repository.wikiIndexState).toBe("fresh");
      expect(socketConnect).not.toHaveBeenCalled();
      expect(fetchCall).not.toHaveBeenCalled();
      expect(snapshotTree(root)).toEqual(projectBefore);
      expect(snapshotTree(home)).toEqual(homeBefore);

      const oversizedSource = join(root, "src", "oversized.ts");
      writeFileSync(oversizedSource, "x".repeat(GRAPH_CORPUS_LIMITS.maxSourceFileBytes + 1));
      const graphLimited = await inspectCapabilities(root);
      expect(graphLimited.data.repository.graphIndexState).toBe("corpus_limit_exceeded");
      expect(graphLimited.data.commands.apply.map((entry) => entry.id)).not.toContain("graph.rebuild");
      rmSync(oversizedSource);

      let deepWikiDirectory = join(root, ".mex");
      for (let depth = 0; depth <= WIKI_CORPUS_LIMITS.maxDirectoryDepth; depth += 1) {
        deepWikiDirectory = join(deepWikiDirectory, `depth-${depth}`);
      }
      mkdirSync(deepWikiDirectory, { recursive: true });
      writeFileSync(join(deepWikiDirectory, "too-deep.md"), "# Too deep\n");
      const wikiLimited = await inspectCapabilities(root);
      expect(wikiLimited.data.repository.wikiIndexState).toBe("corpus_limit_exceeded");
      expect(wikiLimited.data.commands.apply.map((entry) => entry.id)).not.toContain("wiki.rebuild_index");
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
    }
  }, 30_000);

  it("uses a bounded safe problem and exit 2 when inspection unexpectedly fails", async () => {
    const root = readyRoot();
    const writes: string[] = [];
    const setExitCode = vi.fn();
    const secret = join(root, "private-source-path");

    const envelope = await runCapabilities({
      cwd: root,
      write: (line) => writes.push(line),
      setExitCode,
      dependencies: {
        inspectGraphIndex: async () => { throw new Error(`failed at ${secret}`); },
        inspectWikiIndex: async () => inspection("fresh"),
      },
    });

    expect(envelope).toEqual({
      schemaVersion: 1,
      ok: false,
      data: null,
      diagnostics: [],
      problem: {
        title: "Capability discovery failed",
        status: 500,
        code: "INTERNAL_ERROR",
        detail: "MEX could not inspect repository capabilities safely.",
      },
    });
    expect(setExitCode).toHaveBeenCalledOnce();
    expect(setExitCode).toHaveBeenCalledWith(2);
    expect(writes).toEqual([JSON.stringify(envelope)]);
    expect(writes[0]).not.toContain(secret);
    expect(Buffer.byteLength(writes[0]!, "utf8")).toBeLessThanOrEqual(CAPABILITIES_MAX_BYTES);
  });

  it("advertises only registered current-product command paths", async () => {
    const registered = registeredCommandPaths(program);
    expect(registered.filter((path) => path === "mex relay" || path.startsWith("mex relay ")).sort())
      .toEqual([
        "mex relay",
        "mex relay acknowledge",
        "mex relay close",
        "mex relay contract",
        "mex relay draft",
        "mex relay draft delete",
        "mex relay draft list",
        "mex relay draft save",
        "mex relay draft show",
        "mex relay list",
        "mex relay publish",
        "mex relay show",
      ]);
    expect(CAPABILITY_COMMAND_CATALOG.map((entry) => entry.id))
      .not.toEqual(expect.arrayContaining(["wiki.build", "wiki.prepare", "wiki.propose.preview", "wiki.propose.apply"]));
    for (const descriptor of CAPABILITY_COMMAND_CATALOG) {
      expect(registered, descriptor.path).toContain(descriptor.path);
      expect(descriptor.usage.startsWith(descriptor.path), descriptor.usage).toBe(true);
      const registeredCommand = commandAtPath(program, descriptor.path);
      for (const option of descriptor.usage.match(/--[a-z-]+/g) ?? []) {
        expect(
          registeredCommand?.options.some((candidate) => candidate.long === option),
          `${descriptor.usage} advertises unregistered option ${option}`,
        ).toBe(true);
      }
    }

    const root = readyRoot();
    const envelope = await inspectCapabilities(root, {
      inspectGraphIndex: async () => inspection("fresh"),
      inspectWikiIndex: async () => inspection("fresh"),
    });
    expect(envelope.data.capabilities.map((entry) => entry.id)).toEqual([
      "project_hub",
      "team_identity",
      "team_workstreams",
      "team_inbox",
      "team_relay",
      "spec_authoring",
      "activity_read",
      "activity_record",
      "spec_read",
      "code_graph",
      "wiki",
    ]);
    const serializedCommands = JSON.stringify(envelope.data.commands);
    expect(serializedCommands).toMatch(/inbox/u);
    expect(serializedCommands).toMatch(/relay\.contract/u);
    expect(serializedCommands).not.toMatch(/relay\.(?:draft|list|show|publish|acknowledge|close)|playbook|catch[-_ ]?up/i);
    expect(serializedCommands).not.toMatch(/activity\.(?:create|update|delete)/i);
    expect(serializedCommands).not.toMatch(/wiki\.(?:build|prepare|propose)/i);
  });

  it("registers only --json and exempts discovery from telemetry and first-run writes", () => {
    const capabilities = program.commands.find((candidate) => candidate.name() === "capabilities");
    expect(capabilities?.options.map((option) => option.long)).toEqual(["--json"]);
    expect(isTelemetryExemptCommand("capabilities", "mex")).toBe(true);
    expect(isTelemetryExemptCommand("list", "member")).toBe(true);
    expect(isTelemetryExemptCommand("record", "activity")).toBe(false);
    expect(isTelemetryExemptCommand("list", "workstream")).toBe(true);
    expect(isTelemetryExemptCommand("save", "draft")).toBe(true);
    expect(isTelemetryExemptCommand("approve", "proposal")).toBe(true);
    expect(isTelemetryExemptCommand("list", "relay")).toBe(true);
    expect(isTelemetryExemptCommand("list", "spec")).toBe(true);
    expect(isTelemetryExemptCommand("sync", "skills")).toBe(true);
    expect(isFirstRunNoticeExemptCommand("telemetry")).toBe(true);
    expect(isFirstRunNoticeExemptCommand("config")).toBe(true);
    expect(isFirstRunNoticeExemptCommand("capabilities")).toBe(true);
    expect(isFirstRunNoticeExemptCommand("member")).toBe(true);
    expect(isFirstRunNoticeExemptCommand("activity")).toBe(true);
    expect(isFirstRunNoticeExemptCommand("workstream")).toBe(true);
    expect(isFirstRunNoticeExemptCommand("inbox")).toBe(true);
    expect(isFirstRunNoticeExemptCommand("relay")).toBe(true);
    expect(isFirstRunNoticeExemptCommand("spec")).toBe(true);
    expect(isFirstRunNoticeExemptCommand("skills")).toBe(true);
    expect(isFirstRunNoticeExemptCommand("check")).toBe(false);
  });
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "mex-capabilities-"));
  roots.push(root);
  return root;
}

function readyRoot(): string {
  const root = temporaryRoot();
  mkdirSync(join(root, ".mex"));
  writeFileSync(join(root, ".mex", "ROUTER.md"), "# Router\n");
  writeFileSync(join(root, ".mex", "config.json"), JSON.stringify({
    scaffold_id: "scaffold-capabilities-001",
  }));
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  execFileSync("git", ["config", "user.email", "capabilities@example.invalid"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Capabilities Contract"], { cwd: root });
  execFileSync("git", ["add", ".mex/ROUTER.md", ".mex/config.json"], { cwd: root });
  execFileSync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: root });
  return root;
}

function golden(name: string): string {
  return readFileSync(join("test", "fixtures", "capabilities", name), "utf8");
}

function inspection<State extends string>(
  state: State,
  diagnostics: Array<{
    code: string;
    message: string;
    remediation?: readonly { command?: string }[];
  }> = [],
): { state: State; diagnostics: typeof diagnostics } {
  return { state, diagnostics };
}

function snapshotTree(root: string): Record<string, string> {
  const snapshot: Record<string, string> = {};
  const visit = (absolute: string, prefix: string): void => {
    for (const name of readdirSync(absolute).sort()) {
      const path = join(absolute, name);
      const relative = prefix === "" ? name : `${prefix}/${name}`;
      const stats = lstatSync(path, { bigint: true });
      const identity = `${stats.mode}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}`;
      if (stats.isDirectory()) {
        snapshot[relative] = `directory:${identity}`;
        visit(path, relative);
      } else if (stats.isSymbolicLink()) {
        snapshot[relative] = `symlink:${identity}:${readlinkSync(path)}`;
      } else {
        const digest = createHash("sha256").update(readFileSync(path)).digest("hex");
        snapshot[relative] = `file:${identity}:${digest}`;
      }
    }
  };
  visit(root, "");
  return snapshot;
}

function registeredCommandPaths(root: Command): string[] {
  const paths: string[] = [];
  const visit = (parent: Command, prefix: readonly string[]): void => {
    for (const child of parent.commands) {
      const current = [...prefix, child.name()];
      paths.push(current.join(" "));
      visit(child, current);
    }
  };
  visit(root, [root.name()]);
  return paths;
}

function commandAtPath(root: Command, path: string): Command | undefined {
  const names = path.split(" ");
  if (names.shift() !== root.name()) return undefined;
  let current = root;
  for (const name of names) {
    const child = current.commands.find((candidate) => candidate.name() === name);
    if (!child) return undefined;
    current = child;
  }
  return current;
}
