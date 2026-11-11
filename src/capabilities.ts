import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { DEFAULT_WIKI_EXCLUDE } from "./config.js";
import type { GraphStatusKind } from "./team/contracts/graph.js";
import {
  TEAM_IDENTITY_ACTIVITY_LIMITS,
  TEAM_INBOX_SPEC_LIMITS,
} from "./team/contracts/workflow.js";
import {
  RELAY_CONTRACT_COMMAND,
  RELAY_CONTRACT_DESCRIPTOR_ID,
} from "./team/relay/cli/contract-catalog.js";
import {
  projectLocalSchemaClosure,
  projectSchemaDefinition,
} from "./team/cli/contract-projection.js";
import type { ContractWikiIndexState } from "./wiki/query/contract-session.js";
import { WIKI_MIGRATION_RECOVERY } from "./wiki/migration/recovery.js";
import { VERSION } from "./version.js";

export const CAPABILITIES_SCHEMA_VERSION = 1 as const;
export const CAPABILITIES_MAX_BYTES = 32 * 1024;

const MAX_ANCESTORS = 256;
const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_EXCLUDE_PATTERNS = 64;
const MAX_EXCLUDE_PATTERN_BYTES = 512;

export type RepositoryInitializationState =
  | "not_git_repository"
  | "scaffold_missing"
  | "scaffold_incomplete"
  | "ready"
  | "unavailable";

export type CapabilityIndexState =
  | GraphStatusKind
  | ContractWikiIndexState
  | "corpus_limit_exceeded"
  | "unavailable";
export type CapabilityAvailability = "available" | "unavailable";
export type CapabilityCommandKind = "read" | "preview" | "apply";
export type CapabilityCommandOutput = "json" | "jsonl-v3";

export interface CapabilityUnavailableReason {
  code: string;
  detail: string;
}

export interface InstalledCapability {
  id:
    | "project_hub"
    | "team_identity"
    | "team_workstreams"
    | "team_inbox"
    | "team_relay"
    | "spec_authoring"
    | "activity_read"
    | "activity_record"
    | "spec_read"
    | "code_graph"
    | "wiki";
  installed: true;
  availability: CapabilityAvailability;
  unavailableReason: CapabilityUnavailableReason | null;
}

export interface CapabilityCommandDescriptor {
  id: string;
  /** Exact Commander path, without arguments or flags. */
  path: string;
  /** Copy/paste-safe structured invocation. */
  usage: string;
  output: CapabilityCommandOutput;
  /** Machine-readable contract ID for caller-supplied input, when required. */
  inputContract?: string;
  /** Descriptor ID of the bounded command that resolves an out-of-line contract. */
  contractResolver?: "relay.contract";
}

export interface TeamCliContract {
  schemaVersion: 1;
  requestFile: {
    contractId: "team.identity_activity.request.v1";
    mediaType: "application/json";
    encoding: "utf-8";
    maxBytes: number;
    maxDepth: 32;
    maxNodes: 4_096;
    textPolicy: {
      normalization: "NFC";
      leadingOrTrailingWhitespace: "forbidden";
      controlCharacters: "forbidden";
    };
    utf8ByteLimits: {
      operationId: 128;
      memberDisplayName: 200;
      gitAliasName: 200;
      gitAliasEmail: 320;
      entityId: 256;
      entityKind: 64;
      entityTitle: 512;
      activityAction: 128;
      workstreamTitle: 512;
      workstreamText: 8_192;
      codeIdentifierOrFingerprint: 1_024;
      repositoryPath: 4_096;
    };
    schema: Readonly<Record<string, unknown>>;
    examples: readonly {
      command:
        | "member.add"
        | "member.update"
        | "member.deactivate"
        | "member.reactivate"
        | "member.select"
        | "member.clear"
        | "activity.record"
        | "workstream.create"
        | "workstream.update"
        | "workstream.archive";
      usage: string;
      schemaRef: string;
      request: Readonly<Record<string, unknown>>;
    }[];
  };
  applyFile: {
    contractId: "team.identity_activity.preview-envelope.v1";
    mediaType: "application/json";
    encoding: "utf-8";
    maxBytes: number;
    requirement: string;
  };
  exitCodes: readonly {
    code: 0 | 1 | 2 | 3 | 4 | 5;
    name: "ok" | "validation" | "usage" | "unavailable" | "conflict" | "refused";
    meaning: string;
  }[];
}

export interface NextInitializationAction {
  /** Null means the required recovery is a manual repository/configuration change. */
  command: string | null;
  reason: string;
}

export interface CapabilitiesManifest {
  mexVersion: string;
  repository: {
    initializationState: RepositoryInitializationState;
    graphIndexState: CapabilityIndexState;
    wikiIndexState: CapabilityIndexState;
  };
  capabilities: InstalledCapability[];
  commands: Record<CapabilityCommandKind, CapabilityCommandDescriptor[]>;
  teamCliContract: TeamCliContract;
  nextInitializationAction: NextInitializationAction | null;
}

export interface CapabilitiesSuccessEnvelope {
  schemaVersion: typeof CAPABILITIES_SCHEMA_VERSION;
  ok: true;
  data: CapabilitiesManifest;
  diagnostics: [];
}

export interface CapabilitiesProblemEnvelope {
  schemaVersion: typeof CAPABILITIES_SCHEMA_VERSION;
  ok: false;
  data: null;
  diagnostics: [];
  problem:
    | {
        title: "Capability discovery failed";
        status: 500;
        code: "INTERNAL_ERROR";
        detail: "MEX could not inspect repository capabilities safely.";
      }
    | {
        title: "Invalid capability command";
        status: 400;
        code: "INVALID_REQUEST";
        detail: "Use exactly: mex capabilities --json";
      };
}

export type CapabilitiesEnvelope = CapabilitiesSuccessEnvelope | CapabilitiesProblemEnvelope;

interface CapabilityInspectionDiagnostic {
  code: string;
  message: string;
  remediation?: string | readonly { command?: string }[];
}

export interface CapabilityInspectionResult<State extends string> {
  state: State;
  diagnostics: readonly CapabilityInspectionDiagnostic[];
}

interface MaintenanceAvailability {
  refresh: boolean;
  rebuild: boolean;
  repair: boolean;
}

export interface CapabilityInspectionDependencies {
  inspectTeam(projectRoot: string): Promise<CapabilityUnavailableReason | null>;
  inspectGraphIndex(projectRoot: string): Promise<CapabilityInspectionResult<GraphStatusKind>>;
  inspectWikiIndex(
    scaffoldRoot: string,
    exclude: readonly string[],
  ): Promise<CapabilityInspectionResult<ContractWikiIndexState>>;
}

export interface RunCapabilitiesOptions {
  cwd?: string;
  write?: (line: string) => void;
  setExitCode?: (code: number) => void;
  dependencies?: Partial<CapabilityInspectionDependencies>;
}

const TEAM_REQUEST_CONTRACT_ID = "team.identity_activity.request.v1" as const;
const TEAM_PREVIEW_CONTRACT_ID = "team.identity_activity.preview-envelope.v1" as const;
const EXAMPLE_MEMBER_ID = "member_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const EXAMPLE_WORKSTREAM_ID = "ws_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const EXAMPLE_REVISION = "a".repeat(64);
const EXAMPLE_SELECTION_REVISION = "b".repeat(64);
const EXAMPLE_PROPOSAL_ID = "proposal_01ARZ3NDEKTSV4RRFFQ69G5FAV";

function requestSchemaRef(name: string): string {
  return `${TEAM_REQUEST_CONTRACT_ID}#/$defs/${name}`;
}

function previewContractRef(commandName: string): string {
  return `${TEAM_PREVIEW_CONTRACT_ID}#${commandName}`;
}
const TEAM_REQUEST_SCHEMA_ID = "https://mex.dev/contracts/team-identity-activity-request-v1.json" as const;

interface SchemaCompaction {
  sourceId: string;
  targetId: string;
  anchorPrefix: string;
  definitions: ReadonlyMap<string, string>;
  anchors: ReadonlySet<string>;
}

function schemaCompaction(
  schema: Readonly<Record<string, unknown>>,
  targetId: string,
  anchorPrefix = targetId.at(-1) ?? "s",
): SchemaCompaction {
  const sourceId = typeof schema.$id === "string" ? schema.$id : "";
  const definitions = schema.$defs !== null && typeof schema.$defs === "object"
    ? Object.keys(schema.$defs as Readonly<Record<string, unknown>>)
    : [];
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  if (sourceId.length === 0 || definitions.length > alphabet.length) {
    throw new Error("Capability schema compaction configuration is invalid.");
  }
  const referenceCounts = new Map<string, number>();
  const countReferences = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(countReferences);
      return;
    }
    if (value === null || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value as Readonly<Record<string, unknown>>)) {
      if (key === "$ref" && typeof child === "string" && child.startsWith("#/$defs/")) {
        const name = child.slice("#/$defs/".length);
        referenceCounts.set(name, (referenceCounts.get(name) ?? 0) + 1);
      }
      countReferences(child);
    }
  };
  countReferences(schema);
  return {
    sourceId,
    targetId,
    anchorPrefix,
    definitions: new Map(definitions.map((name, index) => [name, alphabet[index]!])),
    anchors: new Set(definitions.filter((name) => (referenceCounts.get(name) ?? 0) >= 1)),
  };
}

/** Preserve standard JSON Schema semantics while keeping discovery below 32 KiB. */
function compactJsonSchema(
  schema: Readonly<Record<string, unknown>>,
  current: SchemaCompaction,
  all: readonly SchemaCompaction[],
): Readonly<Record<string, unknown>> {
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit);
    if (value === null || typeof value !== "object") return value;
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Readonly<Record<string, unknown>>)) {
      if (key === "$defs" && child !== null && typeof child === "object" && !Array.isArray(child)) {
        const compacted: Record<string, unknown> = {};
        for (const [name, definition] of Object.entries(child as Readonly<Record<string, unknown>>)) {
          const compactName = current.definitions.get(name) ?? name;
          const compactDefinition = visit(definition);
          compacted[compactName] = current.anchors.has(name)
            ? { $id: compactResourceId(current, compactName), ...(compactDefinition as Record<string, unknown>) }
            : compactDefinition;
        }
        result[key] = compacted;
      } else if (key === "$id" && child === current.sourceId) {
        result[key] = current.targetId;
      } else if (key === "$ref" && typeof child === "string") {
        result[key] = compactSchemaRef(child, current, all);
      } else {
        result[key] = visit(child);
      }
    }
    if (
      result.additionalProperties === false
      && Array.isArray(result.required)
      && result.properties !== null
      && typeof result.properties === "object"
      && !Array.isArray(result.properties)
    ) {
      const propertyNames = Object.keys(result.properties as Readonly<Record<string, unknown>>);
      const requiredNames = result.required.filter((name): name is string => typeof name === "string");
      if (
        propertyNames.length === requiredNames.length
        && propertyNames.every((name) => requiredNames.includes(name))
      ) {
        delete result.additionalProperties;
        result.maxProperties = propertyNames.length;
      }
    }
    return result;
  };
  return Object.freeze(visit(schema) as Record<string, unknown>);
}

function compactSchemaRef(
  ref: string,
  current: SchemaCompaction,
  all: readonly SchemaCompaction[],
): string {
  const localPrefix = "#/$defs/";
  if (ref.startsWith(localPrefix)) {
    const name = ref.slice(localPrefix.length);
    const compactName = current.definitions.get(name) ?? name;
    return current.anchors.has(name)
      ? compactResourceId(current, compactName)
      : `${localPrefix}${compactName}`;
  }
  for (const candidate of all) {
    if (ref === candidate.sourceId) return candidate.targetId;
    const prefix = `${candidate.sourceId}${localPrefix}`;
    if (ref.startsWith(prefix)) {
      const name = ref.slice(prefix.length);
      const compactName = candidate.definitions.get(name) ?? name;
      return candidate.anchors.has(name)
        ? compactResourceId(candidate, compactName)
        : `${candidate.targetId}${localPrefix}${compactName}`;
    }
  }
  return ref;
}

function compactResourceId(schema: SchemaCompaction, compactName: string): string {
  return `urn:mex:${schema.anchorPrefix}:${compactName}`;
}

const COMPACT_TEAM_REQUEST_SCHEMA_SOURCE: Readonly<Record<string, unknown>> = Object.freeze({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: TEAM_REQUEST_SCHEMA_ID,
  title: "MEX Team identity and Activity preview request v1",
  description:
    "Caller-authored authority-free request. Every object rejects extra keys; text is trimmed NFC without control characters and runtime byte ceilings apply.",
  type: "object",
  additionalProperties: false,
  required: ["operationId", "action", "expectedRevisions"],
  properties: {
    operationId: { $ref: "#/$defs/operationId" },
    action: { type: "object", unevaluatedProperties: false, oneOf: [
      {
        required: ["kind", "member"],
        properties: {
          kind: { const: "member.add" },
          member: {
            type: "object", additionalProperties: false, required: ["displayName", "gitAliases"],
            properties: {
              displayName: { $ref: "#/$defs/t200" },
              gitAliases: { type: "array", maxItems: 32, uniqueItems: true, items: { $ref: "#/$defs/gitAlias" } },
            },
          },
        },
      },
      {
        required: ["kind", "memberId", "patch"],
        properties: {
          kind: { const: "member.update" }, memberId: { $ref: "#/$defs/memberId" },
          patch: {
            type: "object", additionalProperties: false, minProperties: 1,
            properties: {
              displayName: { $ref: "#/$defs/t200" },
              gitAliases: { type: "array", maxItems: 32, uniqueItems: true, items: { $ref: "#/$defs/gitAlias" } },
            },
          },
        },
      },
      { required: ["kind", "memberId"], properties: { kind: { enum: ["member.deactivate", "member.reactivate", "member.select"] }, memberId: { $ref: "#/$defs/memberId" } } },
      { required: ["kind"], properties: { kind: { const: "member.clear" } } },
      {
        required: ["kind", "activity"],
        properties: {
          kind: { const: "activity.record" },
          activity: {
            type: "object", additionalProperties: false, required: ["action", "subjects"],
            properties: {
              action: { type: "string", minLength: 1, maxLength: 128, pattern: "^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$" },
              subjects: { type: "array", maxItems: 64, items: { $ref: "#/$defs/activitySubject" } },
              workstream: { $ref: "#/$defs/entityRef", type: "object", properties: { kind: { const: "workstream" } } },
            },
          },
        },
      },
      { required: ["kind", "workstream"], properties: { kind: { const: "workstream.create" }, workstream: { $ref: "#/$defs/workstreamCreate" } } },
      { required: ["kind", "workstreamId", "patch"], properties: { kind: { const: "workstream.update" }, workstreamId: { $ref: "#/$defs/workstreamId" }, patch: { $ref: "#/$defs/workstreamPatch" } } },
      { required: ["kind", "workstreamId"], properties: { kind: { const: "workstream.archive" }, workstreamId: { $ref: "#/$defs/workstreamId" } } },
    ] },
    expectedRevisions: { $ref: "#/$defs/expectations" },
  },
  allOf: [
    {
      if: { properties: { action: { type: "object", properties: { kind: { enum: ["member.update", "member.deactivate", "member.reactivate", "member.select", "member.clear"] } } } } },
      then: { properties: { expectedRevisions: { type: "array", minItems: 1 } } },
    },
    {
      if: { properties: { action: { type: "object", properties: { kind: { enum: ["workstream.update", "workstream.archive"] } } } } },
      then: { properties: { expectedRevisions: { type: "array", contains: { $ref: "#/$defs/workstreamExpectation" } } } },
    },
  ],
  $defs: {
    operationId: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" },
    exactRevision: { type: "string", pattern: "^[a-f0-9]{64}$" },
    revision: { anyOf: [{ $ref: "#/$defs/exactRevision" }, { type: "null" }] },
    memberId: { type: "string", pattern: "^member_[0-7][0-9A-HJKMNP-TV-Z]{25}$" },
    workstreamId: { type: "string", pattern: "^ws_[0-7][0-9A-HJKMNP-TV-Z]{25}$" },
    text: { type: "string", minLength: 1, pattern: "^(?!\\s)(?!.*\\s$)[^\\u0000-\\u001f\\u007f]+$" },
    t64: { $ref: "#/$defs/text", type: "string", maxLength: 64 },
    t200: { $ref: "#/$defs/text", type: "string", maxLength: 200 },
    t256: { $ref: "#/$defs/text", type: "string", maxLength: 256 },
    t512: { $ref: "#/$defs/text", type: "string", maxLength: 512 },
    t1024: { $ref: "#/$defs/text", type: "string", maxLength: 1_024 },
    t4096: { $ref: "#/$defs/text", type: "string", maxLength: 4_096 },
    t8192: { $ref: "#/$defs/text", type: "string", maxLength: 8_192 },
    canonicalRepoPath: { type: "string", minLength: 1, maxLength: 4_096 },
    gitAlias: {
      type: "object", additionalProperties: false, required: ["name", "email"],
      properties: {
        name: { anyOf: [{ $ref: "#/$defs/t200" }, { type: "null" }] },
        email: { anyOf: [{ $ref: "#/$defs/text", type: "string", maxLength: 320, pattern: "^(?=.*@)\\S+$" }, { type: "null" }] },
      },
      not: { required: ["name", "email"], properties: { name: { type: "null" }, email: { type: "null" } } },
    },
    entityRef: {
      type: "object", additionalProperties: false, required: ["id", "kind"],
      properties: { id: { $ref: "#/$defs/t256" }, kind: { $ref: "#/$defs/t64" }, title: { $ref: "#/$defs/t512" } },
    },
    codeRef: { type: "object", unevaluatedProperties: false, oneOf: [
      { required: ["kind", "symbolId"], properties: { kind: { const: "symbol" }, symbolId: { $ref: "#/$defs/t1024" }, fingerprint: { $ref: "#/$defs/t1024" } } },
      { required: ["kind", "path"], properties: { kind: { const: "file" }, path: { $ref: "#/$defs/canonicalRepoPath" }, fingerprint: { $ref: "#/$defs/t1024" } } },
    ] },
    actorRef: { type: "object", unevaluatedProperties: false, oneOf: [
      { required: ["kind", "memberId"], properties: { kind: { const: "member" }, memberId: { $ref: "#/$defs/memberId" }, displayName: { $ref: "#/$defs/t512" } } },
      {
        required: ["kind", "name", "email"],
        properties: { kind: { const: "git" }, name: { anyOf: [{ $ref: "#/$defs/t512" }, { type: "null" }] }, email: { anyOf: [{ $ref: "#/$defs/t512", type: "string", pattern: "^(?=.*@)\\S+$" }, { type: "null" }] } },
        not: { required: ["name", "email"], properties: { name: { type: "null" }, email: { type: "null" } } },
      },
      { required: ["kind"], properties: { kind: { const: "unknown" } } },
    ] },
    expectation: { type: "object", unevaluatedProperties: false, oneOf: [
      {
        required: ["target", "revision"],
        properties: {
          target: { type: "object", additionalProperties: false, required: ["kind", "id"], properties: { kind: { const: "entity" }, id: { $ref: "#/$defs/t256" } } },
          revision: { $ref: "#/$defs/revision" }, semanticRevision: { anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }] },
        },
        if: { required: ["revision"], properties: { revision: { type: "string" } } },
        then: { required: ["semanticRevision"], properties: { semanticRevision: {} } },
      },
      { required: ["target", "revision"], properties: { target: { type: "object", additionalProperties: false, required: ["kind", "path"], properties: { kind: { const: "artifact" }, path: { $ref: "#/$defs/canonicalRepoPath" } } }, revision: { $ref: "#/$defs/revision" } } },
      { required: ["target", "revision"], properties: { target: { type: "object", additionalProperties: false, required: ["kind", "namespace", "id"], properties: { kind: { const: "local" }, namespace: { enum: ["inbox-draft", "relay-draft", "cursor", "job", "member-selection"] }, id: { $ref: "#/$defs/t256" } } }, revision: { $ref: "#/$defs/revision" } } },
    ] },
    expectations: { type: "array", maxItems: 64, items: { $ref: "#/$defs/expectation" } },
    workstreamExpectation: {
      type: "object", additionalProperties: false, required: ["target", "revision"],
      properties: { target: { type: "object", additionalProperties: false, required: ["kind", "path"], properties: { kind: { const: "artifact" }, path: { type: "string", pattern: "^\\.mex/workstreams/ws_[0-7][0-9A-HJKMNP-TV-Z]{25}\\.md$" } } }, revision: { $ref: "#/$defs/exactRevision" } },
    },
    actorSet: { type: "array", maxItems: 64, uniqueItems: true, items: { $ref: "#/$defs/actorRef" } },
    entitySet: { type: "array", maxItems: 64, uniqueItems: true, items: { $ref: "#/$defs/entityRef" } },
    codeSet: { type: "array", maxItems: 64, uniqueItems: true, items: { $ref: "#/$defs/codeRef" } },
    pathSet: { type: "array", maxItems: 64, uniqueItems: true, items: { $ref: "#/$defs/canonicalRepoPath" } },
    workstreamCreate: {
      type: "object", additionalProperties: false, required: ["title", "goal", "summary", "owners", "nextMilestone"],
      properties: {
        title: { $ref: "#/$defs/t512" }, goal: { $ref: "#/$defs/t4096" }, summary: { $ref: "#/$defs/t4096" },
        owners: { $ref: "#/$defs/actorSet", type: "array", minItems: 1 },
        contributors: { $ref: "#/$defs/actorSet" }, paths: { $ref: "#/$defs/pathSet" }, code: { $ref: "#/$defs/codeSet" },
        topics: { $ref: "#/$defs/entitySet" }, components: { $ref: "#/$defs/entitySet" }, related: { $ref: "#/$defs/entitySet" },
        nextMilestone: { $ref: "#/$defs/t4096" },
      },
    },
    workstreamPatch: {
      type: "object", additionalProperties: false, minProperties: 1,
      properties: {
        title: { $ref: "#/$defs/t512" }, goal: { $ref: "#/$defs/t4096" }, summary: { $ref: "#/$defs/t4096" },
        state: { enum: ["planned", "active", "blocked", "done"] }, owners: { $ref: "#/$defs/actorSet", type: "array", minItems: 1 },
        contributors: { $ref: "#/$defs/actorSet" }, paths: { $ref: "#/$defs/pathSet" }, code: { $ref: "#/$defs/codeSet" }, topics: { $ref: "#/$defs/entitySet" }, components: { $ref: "#/$defs/entitySet" }, related: { $ref: "#/$defs/entitySet" },
        blockers: { type: "array", maxItems: 64, uniqueItems: true, items: { $ref: "#/$defs/t4096" } }, currentState: { $ref: "#/$defs/t8192" }, nextMilestone: { $ref: "#/$defs/t4096" },
      },
    },
    activitySubject: { type: "object", unevaluatedProperties: false, oneOf: [
      { required: ["kind", "entity"], properties: { kind: { const: "entity" }, entity: { $ref: "#/$defs/entityRef" } } },
      { required: ["kind", "code"], properties: { kind: { const: "code" }, code: { $ref: "#/$defs/codeRef" } } },
      { required: ["kind", "path"], properties: { kind: { const: "file" }, path: { $ref: "#/$defs/canonicalRepoPath" } } },
      { required: ["kind", "hash"], properties: { kind: { const: "commit" }, hash: { type: "string", pattern: "^(?:[a-f0-9]{40}|[a-f0-9]{64})$" } } },
    ] },
  },
});

const TEAM_SCHEMA_COMPACTION = Object.freeze({
  ...schemaCompaction(COMPACT_TEAM_REQUEST_SCHEMA_SOURCE, TEAM_REQUEST_SCHEMA_ID, "t"),
  // Only definitions referenced by another schema need a child resource ID.
  // Team-local refs stay as shorter JSON Pointers rooted in this resource.
  anchors: new Set(["operationId", "memberId"]),
});
const COMPACT_TEAM_REQUEST_SCHEMA_BASE = compactJsonSchema(
  COMPACT_TEAM_REQUEST_SCHEMA_SOURCE,
  TEAM_SCHEMA_COMPACTION,
  [TEAM_SCHEMA_COMPACTION],
);

function teamCommandRequestSchema(kind: string | readonly string[]): Readonly<Record<string, unknown>> {
  return Object.freeze({
    $ref: "#",
    type: "object",
    properties: {
      action: {
        type: "object",
        properties: { kind: Array.isArray(kind) ? { enum: kind } : { const: kind } },
      },
    },
  });
}

const TEAM_COMPATIBILITY_DEFINITIONS = Object.freeze(Object.fromEntries(
  [...TEAM_SCHEMA_COMPACTION.definitions].map(([name, compactName]) => [
    name,
    {
      $ref: TEAM_SCHEMA_COMPACTION.anchors.has(name)
        ? compactResourceId(TEAM_SCHEMA_COMPACTION, compactName)
        : `#/$defs/${compactName}`,
    },
  ]),
));

const TEAM_PUBLIC_COMPATIBILITY_DEFINITIONS = Object.freeze(Object.fromEntries(
  [
    "operationId", "revision", "memberId", "workstreamId", "gitAlias", "expectation",
    "expectations", "entityRef", "codeRef", "actorRef", "canonicalRepoPath", "actorSet",
    "entitySet", "codeSet", "pathSet", "activitySubject",
  ].map((name) => [name, TEAM_COMPATIBILITY_DEFINITIONS[name]]),
));

function teamActionCompatibilitySchema(kind: string): Readonly<Record<string, unknown>> {
  return Object.freeze({
    $ref: "#/properties/action",
    type: "object",
    properties: { kind: { const: kind } },
  });
}

function teamExpectationCompatibilitySchema(kind: "entity" | "artifact" | "local"): Readonly<Record<string, unknown>> {
  return Object.freeze({
    $ref: TEAM_COMPATIBILITY_DEFINITIONS.expectation.$ref,
    type: "object",
    properties: {
      target: { type: "object", properties: { kind: { const: kind } } },
    },
  });
}

/**
 * Public definitions shipped by the pre-Inbox Team v1 contract.
 *
 * The compact definitions they alias retain the same validation semantics;
 * expectation variants narrow the closed aggregate union so callers compiling
 * those pointers independently keep the original closure guarantees.
 */
const LEGACY_TEAM_COMPATIBILITY_DEFINITIONS = Object.freeze({
  canonicalText: TEAM_COMPATIBILITY_DEFINITIONS.text,
  memberArtifactExpectation: {
    $ref: TEAM_COMPATIBILITY_DEFINITIONS.expectation.$ref,
    type: "object",
    properties: {
      target: {
        type: "object",
        properties: {
          kind: { const: "artifact" },
          path: {
            type: "string",
            pattern: "^\\.mex/team/members/member_[0-7][0-9A-HJKMNP-TV-Z]{25}\\.md$",
          },
        },
      },
      revision: TEAM_COMPATIBILITY_DEFINITIONS.exactRevision,
    },
  },
  workstreamArtifactExpectation: TEAM_COMPATIBILITY_DEFINITIONS.workstreamExpectation,
  entityExpectation: teamExpectationCompatibilitySchema("entity"),
  artifactExpectation: teamExpectationCompatibilitySchema("artifact"),
  localExpectation: teamExpectationCompatibilitySchema("local"),
  nonEmptyExpectations: {
    $ref: TEAM_COMPATIBILITY_DEFINITIONS.expectations.$ref,
    type: "array",
    minItems: 1,
  },
  workstreamCreateInput: TEAM_COMPATIBILITY_DEFINITIONS.workstreamCreate,
  workstreamUpdatePatch: TEAM_COMPATIBILITY_DEFINITIONS.workstreamPatch,
  memberAddAction: teamActionCompatibilitySchema("member.add"),
  memberUpdateAction: teamActionCompatibilitySchema("member.update"),
  memberDeactivateAction: teamActionCompatibilitySchema("member.deactivate"),
  memberSelectAction: teamActionCompatibilitySchema("member.select"),
  memberClearAction: teamActionCompatibilitySchema("member.clear"),
  activityRecordAction: teamActionCompatibilitySchema("activity.record"),
  workstreamCreateAction: teamActionCompatibilitySchema("workstream.create"),
  workstreamUpdateAction: teamActionCompatibilitySchema("workstream.update"),
  workstreamArchiveAction: teamActionCompatibilitySchema("workstream.archive"),
  memberSelectOnlyRequest: teamCommandRequestSchema("member.select"),
  memberClearRequest: teamCommandRequestSchema("member.clear"),
});

/** Retain the shipped command-specific v1 JSON Pointers after compaction. */
const COMPACT_TEAM_REQUEST_SCHEMA = Object.freeze({
  ...COMPACT_TEAM_REQUEST_SCHEMA_BASE,
  $defs: {
    ...(COMPACT_TEAM_REQUEST_SCHEMA_BASE.$defs as Readonly<Record<string, unknown>>),
    ...TEAM_PUBLIC_COMPATIBILITY_DEFINITIONS,
    ...LEGACY_TEAM_COMPATIBILITY_DEFINITIONS,
    memberAddRequest: teamCommandRequestSchema("member.add"),
    memberUpdateRequest: teamCommandRequestSchema("member.update"),
    memberDeactivateRequest: teamCommandRequestSchema("member.deactivate"),
    memberReactivateRequest: teamCommandRequestSchema("member.reactivate"),
    memberSelectRequest: teamCommandRequestSchema(["member.select", "member.clear"]),
    activityRecordRequest: teamCommandRequestSchema("activity.record"),
    workstreamCreateRequest: teamCommandRequestSchema("workstream.create"),
    workstreamUpdateRequest: teamCommandRequestSchema("workstream.update"),
    workstreamArchiveRequest: teamCommandRequestSchema("workstream.archive"),
  },
});

const TEAM_CLI_CONTRACT: TeamCliContract = {
  schemaVersion: 1,
  requestFile: {
    contractId: TEAM_REQUEST_CONTRACT_ID,
    mediaType: "application/json",
    encoding: "utf-8",
    maxBytes: TEAM_IDENTITY_ACTIVITY_LIMITS.maxEnvelopeBytes,
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
    schema: COMPACT_TEAM_REQUEST_SCHEMA,
    // Representative request shapes; all command schemas remain discoverable.
    examples: [
      {
        command: "member.add",
        usage: "mex member add request.json --json",
        schemaRef: requestSchemaRef("memberAddRequest"),
        request: {
          operationId: "member-add-example-001",
          action: {
            kind: "member.add",
            member: {
              displayName: "Ada Lovelace",
              gitAliases: [{ name: "Ada", email: "ada@example.test" }],
            },
          },
          expectedRevisions: [],
        },
      },
      {
        command: "member.update",
        usage: "mex member update request.json --json",
        schemaRef: requestSchemaRef("memberUpdateRequest"),
        request: {
          operationId: "member-update-example-001",
          action: {
            kind: "member.update",
            memberId: EXAMPLE_MEMBER_ID,
            patch: { displayName: "Ada Byron" },
          },
          expectedRevisions: [{
            target: { kind: "artifact", path: `.mex/team/members/${EXAMPLE_MEMBER_ID}.md` },
            revision: EXAMPLE_REVISION,
          }],
        },
      },
      {
        command: "member.deactivate",
        usage: "mex member deactivate request.json --json",
        schemaRef: requestSchemaRef("memberDeactivateRequest"),
        request: {
          operationId: "member-deactivate-example-001",
          action: { kind: "member.deactivate", memberId: EXAMPLE_MEMBER_ID },
          expectedRevisions: [{
            target: { kind: "artifact", path: `.mex/team/members/${EXAMPLE_MEMBER_ID}.md` },
            revision: EXAMPLE_REVISION,
          }],
        },
      },
      {
        command: "member.reactivate",
        usage: "mex member reactivate request.json --json",
        schemaRef: requestSchemaRef("memberReactivateRequest"),
        request: {
          operationId: "member-reactivate-example-001",
          action: { kind: "member.reactivate", memberId: EXAMPLE_MEMBER_ID },
          expectedRevisions: [{
            target: { kind: "artifact", path: `.mex/team/members/${EXAMPLE_MEMBER_ID}.md` },
            revision: EXAMPLE_REVISION,
          }],
        },
      },
      {
        command: "member.select",
        usage: "mex member select request.json --json",
        schemaRef: requestSchemaRef("memberSelectRequest"),
        request: {
          operationId: "member-select-example-001",
          action: { kind: "member.select", memberId: EXAMPLE_MEMBER_ID },
          expectedRevisions: [
            {
              target: { kind: "artifact", path: `.mex/team/members/${EXAMPLE_MEMBER_ID}.md` },
              revision: EXAMPLE_REVISION,
            },
            {
              target: { kind: "local", namespace: "member-selection", id: "current" },
              revision: null,
            },
          ],
        },
      },
      {
        command: "member.clear",
        usage: "mex member select request.json --json",
        schemaRef: requestSchemaRef("memberSelectRequest"),
        request: {
          operationId: "member-clear-example-001",
          action: { kind: "member.clear" },
          expectedRevisions: [{
            target: { kind: "local", namespace: "member-selection", id: "current" },
            revision: EXAMPLE_SELECTION_REVISION,
          }],
        },
      },
      {
        command: "activity.record",
        usage: "mex activity record request.json --json",
        schemaRef: requestSchemaRef("activityRecordRequest"),
        request: {
          operationId: "activity-record-example-001",
          action: {
            kind: "activity.record",
            activity: {
              action: "review.completed",
              subjects: [{ kind: "file", path: "src/index.ts" }],
              workstream: { id: EXAMPLE_WORKSTREAM_ID, kind: "workstream" },
            },
          },
          expectedRevisions: [],
        },
      },
      {
        command: "workstream.create",
        usage: "mex workstream create request.json --json",
        schemaRef: requestSchemaRef("workstreamCreateRequest"),
        request: {
          operationId: "workstream-create-example-001",
          action: {
            kind: "workstream.create",
            workstream: {
              title: "Human-team release",
              goal: "Ship the next reviewed checkpoint",
              summary: "Canonical coordination for the current checkpoint.",
              owners: [{ kind: "unknown" }],
              nextMilestone: "Finish Checkpoint D review",
            },
          },
          expectedRevisions: [],
        },
      },
    ],
  },
  applyFile: {
    contractId: TEAM_PREVIEW_CONTRACT_ID,
    mediaType: "application/json",
    encoding: "utf-8",
    maxBytes: TEAM_IDENTITY_ACTIVITY_LIMITS.maxEnvelopeBytes,
    requirement:
      "Pass the exact complete successful schemaVersion 1 preview JSON emitted for the same command; fragments, altered envelopes, and reconstructed receipts are rejected.",
  },
  exitCodes: [
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
  ],
};
const SCHEMA_COMPACTIONS = [
  TEAM_SCHEMA_COMPACTION,
] as const;

const COMMANDS = {
  capabilities: command("capabilities.inspect", "mex capabilities", "mex capabilities --json", "json"),
  graphStatus: command("graph.status", "mex graph status", "mex graph status --json", "json"),
  graphScope: command("graph.scope", "mex graph scope", "mex graph scope <task>", "jsonl-v3"),
  graphGet: command("graph.get", "mex graph get", "mex graph get <id...>", "jsonl-v3"),
  graphQuery: command(
    "graph.query",
    "mex graph query",
    "mex graph query <who-calls|what-calls|where-defined> <target>",
    "jsonl-v3",
  ),
  graphImpact: command("graph.impact", "mex impact", "mex impact <target>", "jsonl-v3"),
  graphRefresh: command("graph.refresh", "mex graph refresh", "mex graph refresh --json", "json"),
  graphRebuild: command("graph.rebuild", "mex graph rebuild", "mex graph rebuild --json", "json"),
  graphRepair: command("graph.repair", "mex graph repair", "mex graph repair --json", "json"),
  wikiList: command("wiki.list", "mex wiki list", "mex wiki list --json", "json"),
  wikiShow: command("wiki.show", "mex wiki show", "mex wiki show <id> --json", "json"),
  wikiQuery: command("wiki.query", "mex wiki query", "mex wiki query <text...> --json", "json"),
  wikiRelated: command("wiki.related", "mex wiki related", "mex wiki related <id> --json", "json"),
  wikiBacklinks: command("wiki.backlinks", "mex wiki backlinks", "mex wiki backlinks <id> --json", "json"),
  wikiValidate: command("wiki.validate", "mex wiki validate", "mex wiki validate --json", "json"),
  wikiGraph: command("wiki.graph", "mex wiki graph", "mex wiki graph --json", "json"),
  wikiForCode: command(
    "wiki.for_code",
    "mex wiki for-code",
    "mex wiki for-code <node-id...> --json",
    "json",
  ),
  wikiApplyPreview: command(
    "wiki.apply.preview",
    "mex wiki apply",
    "mex wiki apply <operation-file> --json",
    "json",
  ),
  wikiApply: command(
    "wiki.apply.apply",
    "mex wiki apply",
    "mex wiki apply <operation-file> --apply --json",
    "json",
  ),
  wikiRegeneratePreview: command(
    "wiki.regenerate_views.preview",
    "mex wiki regenerate-views",
    "mex wiki regenerate-views --dry-run --json",
    "json",
  ),
  wikiRegenerate: command(
    "wiki.regenerate_views.apply",
    "mex wiki regenerate-views",
    "mex wiki regenerate-views --json",
    "json",
  ),
  wikiMigratePreview: command(
    "wiki.migrate.preview",
    "mex wiki migrate",
    "mex wiki migrate --dry-run --json",
    "json",
  ),
  wikiMigrate: command("wiki.migrate.apply", "mex wiki migrate", "mex wiki migrate --json", "json"),
  wikiRebuild: command(
    "wiki.rebuild_index",
    "mex wiki rebuild-index",
    "mex wiki rebuild-index --json",
    "json",
  ),
  memberList: command("member.list", "mex member list", "mex member list --json", "json"),
  memberShow: command("member.show", "mex member show", "mex member show <member-id> --json", "json"),
  memberCurrent: command("member.current", "mex member current", "mex member current --json", "json"),
  memberAddPreview: command(
    "member.add.preview",
    "mex member add",
    "mex member add <request-file> --json",
    "json",
    requestSchemaRef("memberAddRequest"),
  ),
  memberAddApply: command(
    "member.add.apply",
    "mex member add",
    "mex member add --apply <preview-envelope> --json",
    "json",
    previewContractRef("member.add"),
  ),
  memberUpdatePreview: command(
    "member.update.preview",
    "mex member update",
    "mex member update <request-file> --json",
    "json",
    requestSchemaRef("memberUpdateRequest"),
  ),
  memberUpdateApply: command(
    "member.update.apply",
    "mex member update",
    "mex member update --apply <preview-envelope> --json",
    "json",
    previewContractRef("member.update"),
  ),
  memberDeactivatePreview: command(
    "member.deactivate.preview",
    "mex member deactivate",
    "mex member deactivate <request-file> --json",
    "json",
    requestSchemaRef("memberDeactivateRequest"),
  ),
  memberDeactivateApply: command(
    "member.deactivate.apply",
    "mex member deactivate",
    "mex member deactivate --apply <preview-envelope> --json",
    "json",
    previewContractRef("member.deactivate"),
  ),
  memberReactivatePreview: command(
    "member.reactivate.preview",
    "mex member reactivate",
    "mex member reactivate <request-file> --json",
    "json",
    requestSchemaRef("memberReactivateRequest"),
  ),
  memberReactivateApply: command(
    "member.reactivate.apply",
    "mex member reactivate",
    "mex member reactivate --apply <preview-envelope> --json",
    "json",
    previewContractRef("member.reactivate"),
  ),
  memberSelectPreview: command(
    "member.select.preview",
    "mex member select",
    "mex member select <request-file> --json",
    "json",
    requestSchemaRef("memberSelectRequest"),
  ),
  memberSelectApply: command(
    "member.select.apply",
    "mex member select",
    "mex member select --apply <preview-envelope> --json",
    "json",
    previewContractRef("member.select"),
  ),
  activityList: command("activity.list", "mex activity list", "mex activity list --json", "json"),
  activityShow: command(
    "activity.show",
    "mex activity show",
    "mex activity show <event-id> --json",
    "json",
  ),
  activityRecordPreview: command(
    "activity.record.preview",
    "mex activity record",
    "mex activity record <request-file> --json",
    "json",
    requestSchemaRef("activityRecordRequest"),
  ),
  activityRecordApply: command(
    "activity.record.apply",
    "mex activity record",
    "mex activity record --apply <preview-envelope> --json",
    "json",
    previewContractRef("activity.record"),
  ),
  relayContract: command(
    RELAY_CONTRACT_DESCRIPTOR_ID,
    "mex relay contract",
    RELAY_CONTRACT_COMMAND,
    "json",
    undefined,
    RELAY_CONTRACT_DESCRIPTOR_ID,
  ),
} as const;

/** All paths a manifest can advertise, exported for the registration contract. */
export const CAPABILITY_COMMAND_CATALOG: readonly CapabilityCommandDescriptor[] = Object.freeze(
  Object.values(COMMANDS).filter((entry) => !/^(?:inbox|workstream|spec)(?:\.|$)/u.test(entry.id)),
);

const DEFAULT_DEPENDENCIES: CapabilityInspectionDependencies = {
  async inspectTeam(projectRoot) {
    return inspectTeamAvailability(projectRoot);
  },
  async inspectGraphIndex(projectRoot) {
    const { inspectGraphStatus } = await import("./graph/status.js");
    // Retain one diagnostic so a corpus-limit refusal is not collapsed into the
    // generic truncation marker used by callers that request zero changed paths.
    const status = await inspectGraphStatus({ projectRoot, maxChangedPaths: 1 });
    return { state: status.status, diagnostics: status.diagnostics };
  },
  async inspectWikiIndex(scaffoldRoot, exclude) {
    const { inspectWikiContractIndex } = await import("./wiki/query/contract-session.js");
    const status = inspectWikiContractIndex({ scaffoldRoot, exclude });
    return { state: status.state, diagnostics: status.diagnostics };
  },
};

/**
 * Inspect only repository and disposable-index state. This function never uses
 * `findConfig`: that legacy path may mint scaffold identity as a side effect.
 */
export async function inspectCapabilities(
  cwd = process.cwd(),
  dependencies: Partial<CapabilityInspectionDependencies> = {},
): Promise<CapabilitiesSuccessEnvelope> {
  const repository = inspectRepository(cwd);
  let graphIndexState: CapabilityIndexState = "unavailable";
  let wikiIndexState: CapabilityIndexState = "unavailable";
  let graphMaintenance: MaintenanceAvailability = { refresh: false, rebuild: false, repair: false };
  let teamUnavailableReason: CapabilityUnavailableReason | null = fixedReason(
    "REPOSITORY_UNAVAILABLE",
    "Repository state cannot be inspected safely.",
  );

  if (repository.initializationState === "ready") {
    const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies };
    const exclude = readWikiExclude(repository.scaffoldRoot);
    // Keep corpus inspections sequential so capability discovery cannot combine
    // their bounded working sets into one avoidable peak-RSS spike.
    teamUnavailableReason = await deps.inspectTeam(repository.projectRoot);
    const graphInspection = await deps.inspectGraphIndex(repository.projectRoot);
    graphIndexState = capabilityIndexState(graphInspection);
    graphMaintenance = graphMaintenanceAvailability(graphIndexState, graphInspection.diagnostics);
    wikiIndexState = capabilityIndexState(await deps.inspectWikiIndex(repository.scaffoldRoot, exclude));
  }

  const initializationState = repository.initializationState;
  const manifest: CapabilitiesManifest = {
    mexVersion: VERSION,
    repository: {
      initializationState,
      graphIndexState,
      wikiIndexState,
    },
    capabilities: [
      installedTeamCapability("project_hub", initializationState, teamUnavailableReason),
      installedTeamCapability("team_identity", initializationState, teamUnavailableReason),
      installedTeamCapability("team_relay", initializationState, teamUnavailableReason),
      installedTeamCapability("activity_read", initializationState, teamUnavailableReason),
      installedTeamCapability("activity_record", initializationState, teamUnavailableReason),
      installedCapability("code_graph", initializationState, graphIndexState),
      installedCapability("wiki", initializationState, wikiIndexState),
    ],
    commands: availableCommands(
      initializationState,
      graphIndexState,
      wikiIndexState,
      graphMaintenance,
      teamUnavailableReason,
    ),
    teamCliContract: TEAM_CLI_CONTRACT,
    nextInitializationAction: nextInitializationAction(
      initializationState,
      graphIndexState,
      wikiIndexState,
      graphMaintenance,
      teamUnavailableReason,
    ),
  };

  return {
    schemaVersion: CAPABILITIES_SCHEMA_VERSION,
    ok: true,
    data: manifest,
    diagnostics: [],
  };
}

/** Run the machine command with stable output and shell exit semantics. */
export async function runCapabilities(options: RunCapabilitiesOptions = {}): Promise<CapabilitiesEnvelope> {
  const write = options.write ?? console.log;
  const setExitCode = options.setExitCode ?? ((code: number) => {
    process.exitCode = code;
  });

  let envelope: CapabilitiesEnvelope;
  try {
    envelope = await inspectCapabilities(options.cwd, options.dependencies);
  } catch {
    envelope = capabilitiesProblemEnvelope();
    setExitCode(2);
  }

  const rendered = JSON.stringify(envelope);
  if (Buffer.byteLength(rendered, "utf8") > CAPABILITIES_MAX_BYTES) {
    envelope = capabilitiesProblemEnvelope();
    setExitCode(2);
    write(JSON.stringify(envelope));
    return envelope;
  }
  write(rendered);
  return envelope;
}

function command(
  id: string,
  path: string,
  usage: string,
  output: CapabilityCommandOutput,
  inputContract?: string,
  contractResolver?: CapabilityCommandDescriptor["contractResolver"],
): CapabilityCommandDescriptor {
  return Object.freeze({
    id,
    path,
    usage,
    output,
    ...(inputContract === undefined ? {} : { inputContract }),
    ...(contractResolver === undefined ? {} : { contractResolver }),
  });
}

function availableCommands(
  initializationState: RepositoryInitializationState,
  graphIndexState: CapabilityIndexState,
  wikiIndexState: CapabilityIndexState,
  graphMaintenance: MaintenanceAvailability,
  teamUnavailableReason: CapabilityUnavailableReason | null,
): Record<CapabilityCommandKind, CapabilityCommandDescriptor[]> {
  const read: CapabilityCommandDescriptor[] = [
    COMMANDS.capabilities,
    COMMANDS.relayContract,
  ];
  const preview: CapabilityCommandDescriptor[] = [];
  const apply: CapabilityCommandDescriptor[] = [];

  if (initializationState !== "ready") return { read, preview, apply };

  if (teamUnavailableReason === null) {
    read.push(
      COMMANDS.memberList,
      COMMANDS.memberShow,
      COMMANDS.memberCurrent,
      COMMANDS.activityList,
      COMMANDS.activityShow,
    );
    preview.push(
      COMMANDS.memberAddPreview,
      COMMANDS.memberUpdatePreview,
      COMMANDS.memberDeactivatePreview,
      COMMANDS.memberReactivatePreview,
      COMMANDS.memberSelectPreview,
      COMMANDS.activityRecordPreview,
    );
    apply.push(
      COMMANDS.memberAddApply,
      COMMANDS.memberUpdateApply,
      COMMANDS.memberDeactivateApply,
      COMMANDS.memberReactivateApply,
      COMMANDS.memberSelectApply,
      COMMANDS.activityRecordApply,
    );
  }

  read.push(COMMANDS.graphStatus);
  if (wikiIndexState !== "corpus_limit_exceeded") read.push(COMMANDS.wikiValidate);
  if (graphMaintenance.refresh) apply.push(COMMANDS.graphRefresh);
  if (graphMaintenance.rebuild) apply.push(COMMANDS.graphRebuild);
  if (graphMaintenance.repair) apply.push(COMMANDS.graphRepair);
  if (wikiRebuildIsSafe(wikiIndexState)) apply.push(COMMANDS.wikiRebuild);

  if (graphIndexState === "fresh") {
    read.push(COMMANDS.graphScope, COMMANDS.graphGet, COMMANDS.graphQuery, COMMANDS.graphImpact);
  }

  if (wikiIndexState === "fresh") {
    read.push(
      COMMANDS.wikiList,
      COMMANDS.wikiShow,
      COMMANDS.wikiQuery,
      COMMANDS.wikiRelated,
      COMMANDS.wikiBacklinks,
      COMMANDS.wikiGraph,
      COMMANDS.wikiForCode,
    );
    preview.push(COMMANDS.wikiApplyPreview, COMMANDS.wikiRegeneratePreview);
    apply.push(COMMANDS.wikiApply, COMMANDS.wikiRegenerate);
  } else if (wikiIndexState === "migration_required") {
    preview.push(COMMANDS.wikiMigratePreview);
    apply.push(COMMANDS.wikiMigrate);
  }

  return { read, preview, apply };
}

function installedTeamCapability(
  id: Extract<
    InstalledCapability["id"],
    "project_hub" | "team_identity" | "activity_read" | "activity_record"
    | "team_workstreams" | "team_inbox" | "team_relay"
  >,
  initializationState: RepositoryInitializationState,
  teamUnavailableReason: CapabilityUnavailableReason | null,
): InstalledCapability {
  const reason = repositoryUnavailableReason(initializationState) ?? teamUnavailableReason;
  return {
    id,
    installed: true,
    availability: reason === null ? "available" : "unavailable",
    unavailableReason: reason,
  };
}

function installedSpecAuthoringCapability(
  initializationState: RepositoryInitializationState,
  wikiIndexState: CapabilityIndexState,
  teamUnavailableReason: CapabilityUnavailableReason | null,
): InstalledCapability {
  const reason = repositoryUnavailableReason(initializationState)
    ?? teamUnavailableReason
    ?? unavailableReason("wiki", initializationState, wikiIndexState);
  return {
    id: "spec_authoring",
    installed: true,
    availability: reason === null ? "available" : "unavailable",
    unavailableReason: reason,
  };
}

function installedSpecCapability(
  initializationState: RepositoryInitializationState,
  wikiIndexState: CapabilityIndexState,
): InstalledCapability {
  const reason = unavailableReason("wiki", initializationState, wikiIndexState);
  return {
    id: "spec_read",
    installed: true,
    availability: reason === null ? "available" : "unavailable",
    unavailableReason: reason,
  };
}

function installedCapability(
  id: Extract<InstalledCapability["id"], "code_graph" | "wiki">,
  initializationState: RepositoryInitializationState,
  indexState: CapabilityIndexState,
): InstalledCapability {
  const reason = unavailableReason(id, initializationState, indexState);
  return {
    id,
    installed: true,
    availability: reason === null ? "available" : "unavailable",
    unavailableReason: reason,
  };
}

function unavailableReason(
  id: Extract<InstalledCapability["id"], "code_graph" | "wiki">,
  initializationState: RepositoryInitializationState,
  indexState: CapabilityIndexState,
): CapabilityUnavailableReason | null {
  const repositoryReason = repositoryUnavailableReason(initializationState);
  if (repositoryReason !== null) return repositoryReason;
  if (indexState === "fresh") return null;

  const prefix = id === "code_graph" ? "GRAPH" : "WIKI";
  const label = id === "code_graph" ? "Code Graph" : "Wiki";
  if (indexState === "corpus_limit_exceeded") {
    return fixedReason(
      `${prefix}_CORPUS_LIMIT_EXCEEDED`,
      `${label} reads are unavailable because the configured corpus exceeds a bounded safety limit.`,
    );
  }
  if (indexState === "unavailable") {
    return fixedReason(`${prefix}_INDEX_UNAVAILABLE`, `${label} index state cannot be inspected safely.`);
  }
  return fixedReason(
    `${prefix}_INDEX_${indexState.toUpperCase()}`,
    `${label} reads are unavailable because the index state is ${indexState}.`,
  );
}

function repositoryUnavailableReason(
  initializationState: RepositoryInitializationState,
): CapabilityUnavailableReason | null {
  if (initializationState === "not_git_repository") {
    return fixedReason("NOT_GIT_REPOSITORY", "Repository initialization is required before this capability can be used.");
  }
  if (initializationState === "scaffold_missing") {
    return fixedReason("SCAFFOLD_MISSING", "The MEX scaffold has not been initialized.");
  }
  if (initializationState === "scaffold_incomplete") {
    return fixedReason("SCAFFOLD_INCOMPLETE", "The MEX scaffold is incomplete or cannot be inspected safely.");
  }
  if (initializationState === "unavailable") {
    return fixedReason("REPOSITORY_UNAVAILABLE", "Repository state cannot be inspected safely.");
  }
  return null;
}

function fixedReason(code: string, detail: string): CapabilityUnavailableReason {
  return { code, detail };
}

function nextInitializationAction(
  initializationState: RepositoryInitializationState,
  graphIndexState: CapabilityIndexState,
  wikiIndexState: CapabilityIndexState,
  graphMaintenance: MaintenanceAvailability,
  teamUnavailableReason: CapabilityUnavailableReason | null,
): NextInitializationAction | null {
  if (initializationState === "not_git_repository") {
    return { command: "git init", reason: "Initialize the repository before MEX setup." };
  }
  if (initializationState === "scaffold_missing" || initializationState === "scaffold_incomplete") {
    return { command: "mex setup", reason: "Initialize or repair the MEX scaffold." };
  }
  if (initializationState === "unavailable") {
    return { command: "mex capabilities --json", reason: "Retry from a readable repository directory." };
  }
  if (teamUnavailableReason?.code === "TEAM_SCAFFOLD_IDENTITY_MISSING") {
    return {
      command: "mex setup",
      reason: "Initialize the bounded tracked scaffold identity required by Team workflows.",
    };
  }
  if (
    teamUnavailableReason?.code === "TEAM_SCAFFOLD_IDENTITY_UNTRACKED"
    || teamUnavailableReason?.code === "TEAM_SCAFFOLD_IDENTITY_CHANGED"
  ) {
    return {
      command: null,
      reason: "Review and commit the intended .mex/config.json, then run mex capabilities --json again.",
    };
  }
  if (teamUnavailableReason !== null) {
    return {
      command: "mex capabilities --json",
      reason: "Retry after repository Team state can be inspected safely.",
    };
  }
  if (graphIndexState === "corpus_limit_exceeded") {
    return {
      command: null,
      reason: "Manually narrow the Code Graph corpus, then run mex capabilities --json again.",
    };
  }
  if (graphIndexState === "stale" && graphMaintenance.refresh) {
    return { command: "mex graph refresh --json", reason: "Refresh the stale Code Graph index." };
  }
  if (graphIndexState !== "fresh" && graphMaintenance.repair) {
    return { command: "mex graph repair --json", reason: "Repair the recognized Code Graph index safely." };
  }
  if (graphIndexState !== "fresh" && graphMaintenance.rebuild) {
    return { command: "mex graph rebuild --json", reason: "Build a fresh Code Graph index." };
  }
  if (graphIndexState !== "fresh") {
    return {
      command: null,
      reason: "Resolve the Code Graph status diagnostics, then run mex capabilities --json again.",
    };
  }
  if (wikiIndexState === "corpus_limit_exceeded") {
    return {
      command: null,
      reason: "Manually narrow wiki.exclude or the canonical Wiki corpus, then run mex capabilities --json again.",
    };
  }
  if (wikiIndexState === "migration_required") {
    return {
      command: `${WIKI_MIGRATION_RECOVERY.command} --json`,
      reason: `${WIKI_MIGRATION_RECOVERY.label}.`,
    };
  }
  if (wikiIndexState === "degraded" || wikiIndexState === "unavailable") {
    return { command: "mex capabilities --json", reason: "Retry after Wiki index inspection is available." };
  }
  if (wikiIndexState !== "fresh" && wikiRebuildIsSafe(wikiIndexState)) {
    return { command: "mex wiki rebuild-index --json", reason: "Build a fresh Wiki index." };
  }
  if (wikiIndexState !== "fresh") {
    return {
      command: null,
      reason: "Resolve the Wiki index diagnostics, then run mex capabilities --json again.",
    };
  }
  return null;
}

function capabilityIndexState<State extends GraphStatusKind | ContractWikiIndexState>(
  inspection: CapabilityInspectionResult<State>,
): CapabilityIndexState {
  return inspection.diagnostics.some(isCorpusLimitDiagnostic)
    ? "corpus_limit_exceeded"
    : inspection.state;
}

function graphMaintenanceAvailability(
  state: CapabilityIndexState,
  diagnostics: readonly CapabilityInspectionDiagnostic[],
): MaintenanceAvailability {
  // A fresh status proves all build prerequisites were inspectable. For every
  // recovery state, preserve the status inspector's decision about whether an
  // executable maintenance action is safe to expose.
  if (state === "fresh") return { refresh: true, rebuild: true, repair: true };
  if (state === "corpus_limit_exceeded" || state === "unavailable") {
    return { refresh: false, rebuild: false, repair: false };
  }
  return {
    refresh: diagnosticsAdvertise(diagnostics, "mex graph refresh"),
    rebuild: diagnosticsAdvertise(diagnostics, "mex graph rebuild"),
    repair: diagnosticsAdvertise(diagnostics, "mex graph repair"),
  };
}

function diagnosticsAdvertise(
  diagnostics: readonly CapabilityInspectionDiagnostic[],
  expected: "mex graph refresh" | "mex graph rebuild" | "mex graph repair",
): boolean {
  return diagnostics.some((diagnostic) => (
    Array.isArray(diagnostic.remediation)
    && diagnostic.remediation.some((action: { command?: string }) => action.command === expected)
  ));
}

function wikiRebuildIsSafe(state: CapabilityIndexState): boolean {
  return state === "fresh"
    || state === "missing"
    || state === "stale"
    || state === "rebuild_required";
}

function isCorpusLimitDiagnostic(diagnostic: CapabilityInspectionDiagnostic): boolean {
  return diagnostic.code.includes("CORPUS_LIMIT_EXCEEDED")
    || /corpus (?:exceeds|exceeded).*bounded|corpus exceeded.*safety bound/iu.test(diagnostic.message);
}

interface RepositoryInspection {
  initializationState: RepositoryInitializationState;
  projectRoot: string;
  scaffoldRoot: string;
}

function inspectRepository(cwd: string): RepositoryInspection {
  const root = findRepositoryRoot(cwd);
  if (root.state !== "found") {
    return {
      initializationState: root.state,
      projectRoot: resolve(cwd),
      scaffoldRoot: resolve(cwd, ".mex"),
    };
  }

  const scaffoldRoot = resolve(root.path, ".mex");
  const scaffold = probePath(scaffoldRoot);
  if (scaffold === "missing") {
    return { initializationState: "scaffold_missing", projectRoot: root.path, scaffoldRoot };
  }
  if (scaffold !== "directory") {
    return { initializationState: "scaffold_incomplete", projectRoot: root.path, scaffoldRoot };
  }

  const router = probePath(resolve(scaffoldRoot, "ROUTER.md"));
  return {
    initializationState: router === "file" ? "ready" : "scaffold_incomplete",
    projectRoot: root.path,
    scaffoldRoot,
  };
}

function findRepositoryRoot(cwd: string):
  | { state: "found"; path: string }
  | { state: "not_git_repository" | "unavailable" } {
  let current = resolve(cwd);
  for (let inspected = 0; inspected < MAX_ANCESTORS; inspected++) {
    const marker = probePath(resolve(current, ".git"));
    if (marker === "directory" || marker === "file") return { state: "found", path: current };
    if (marker === "unavailable" || marker === "other") return { state: "unavailable" };
    const parent = dirname(current);
    if (parent === current) return { state: "not_git_repository" };
    current = parent;
  }
  return { state: "unavailable" };
}

type PathProbe = "missing" | "file" | "directory" | "other" | "unavailable";

function probePath(path: string): PathProbe {
  try {
    const stats = lstatSync(path);
    if (stats.isSymbolicLink()) return "other";
    if (stats.isFile()) return "file";
    if (stats.isDirectory()) return "directory";
    return "other";
  } catch (error) {
    return errorCode(error) === "ENOENT" ? "missing" : "unavailable";
  }
}

/** Internal bounded config projection shared by capability and read-only Spec discovery. */
export function readWikiExclude(scaffoldRoot: string): readonly string[] {
  const configPath = resolve(scaffoldRoot, "config.json");
  let descriptor: number | null = null;
  try {
    const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
    descriptor = openSync(configPath, constants.O_RDONLY | constants.O_NONBLOCK | noFollow);
    const stats = fstatSync(descriptor);
    if (!stats.isFile() || stats.size > MAX_CONFIG_BYTES) return DEFAULT_WIKI_EXCLUDE;

    const bytes = Buffer.alloc(MAX_CONFIG_BYTES + 1);
    const count = readSync(descriptor, bytes, 0, bytes.byteLength, 0);
    if (count > MAX_CONFIG_BYTES) return DEFAULT_WIKI_EXCLUDE;
    const parsed = JSON.parse(bytes.subarray(0, count).toString("utf8")) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed.wiki) || !Array.isArray(parsed.wiki.exclude)) {
      return DEFAULT_WIKI_EXCLUDE;
    }
    const exclude = parsed.wiki.exclude.filter((entry): entry is string => (
      typeof entry === "string"
      && entry.trim().length > 0
      && Buffer.byteLength(entry, "utf8") <= MAX_EXCLUDE_PATTERN_BYTES
    ));
    if (exclude.length === 0 || exclude.length > MAX_EXCLUDE_PATTERNS) return DEFAULT_WIKI_EXCLUDE;
    return exclude;
  } catch {
    return DEFAULT_WIKI_EXCLUDE;
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

async function inspectTeamAvailability(
  projectRoot: string,
): Promise<CapabilityUnavailableReason | null> {
  try {
    const [{ createRepositoryGitPort }, { tryReadContainedArtifact, canonicalCheckoutBytes }] = await Promise.all([
      import("./team/git/git-port.js"),
      import("./team/artifacts/filesystem.js"),
    ]);
    const config = tryReadContainedArtifact(projectRoot, ".mex/config.json", MAX_CONFIG_BYTES, "exact");
    if (config === null) {
      return fixedReason(
        "TEAM_SCAFFOLD_IDENTITY_MISSING",
        "Team workflows require one bounded scaffold identity in .mex/config.json.",
      );
    }

    const git = createRepositoryGitPort(projectRoot);
    const before = await git.getRepoState();
    if (before.head === null) {
      return fixedReason(
        "TEAM_SCAFFOLD_IDENTITY_UNTRACKED",
        "Team workflows require .mex/config.json to be tracked at the current repository HEAD.",
      );
    }
    const tracked = await git.readFileAtRevision({
      revision: before.head,
      path: ".mex/config.json",
      maxBytes: MAX_CONFIG_BYTES,
    });
    if (tracked === null) {
      return fixedReason(
        "TEAM_SCAFFOLD_IDENTITY_UNTRACKED",
        "Team workflows require .mex/config.json to be tracked at the current repository HEAD.",
      );
    }
    // Attest the whole tracked config, allowing only checkout CRLF conversion.
    // The stored bytes and revision stay exact for the second-read race check.
    if (tracked.truncated || !Buffer.from(canonicalCheckoutBytes(tracked.content))
      .equals(Buffer.from(canonicalCheckoutBytes(config.bytes)))) {
      return fixedReason(
        "TEAM_SCAFFOLD_IDENTITY_CHANGED",
        "Team workflows require the working .mex/config.json to match the current repository HEAD.",
      );
    }
    const scaffoldId = scaffoldIdentityOf(config.bytes);
    if (scaffoldId === null) {
      return fixedReason(
        "TEAM_SCAFFOLD_IDENTITY_MISSING",
        "Team workflows require one bounded scaffold identity in .mex/config.json.",
      );
    }

    const confirmedConfig = tryReadContainedArtifact(
      projectRoot,
      ".mex/config.json",
      MAX_CONFIG_BYTES,
      "exact",
    );
    const after = await git.getRepoState();
    if (
      confirmedConfig === null
      || confirmedConfig.revision !== config.revision
      || before.branch !== after.branch
      || before.head !== after.head
      || before.dirty !== after.dirty
    ) {
      return fixedReason(
        "TEAM_STATE_UNAVAILABLE",
        "Team repository state changed while it was being inspected.",
      );
    }
    return null;
  } catch {
    return fixedReason(
      "TEAM_STATE_UNAVAILABLE",
      "Team repository state cannot be inspected safely.",
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The bounded `scaffold_id` in a `.mex/config.json` body, or `null` when the
 * body is unparseable or the id is absent or malformed.
 *
 * One definition for the tracked copy and the working copy, so the two cannot
 * drift into disagreeing about what a well-formed identity is.
 */
function scaffoldIdentityOf(bytes: Uint8Array): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
  } catch {
    return null;
  }
  const value = isRecord(parsed) ? parsed.scaffold_id : undefined;
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > 512
    || /[\0-\x1f\x7f]/u.test(value)
  ) {
    return null;
  }
  return value;
}

function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}

export function capabilitiesProblemEnvelope(): CapabilitiesProblemEnvelope {
  return {
    schemaVersion: CAPABILITIES_SCHEMA_VERSION,
    ok: false,
    data: null,
    diagnostics: [],
    problem: {
      title: "Capability discovery failed",
      status: 500,
      code: "INTERNAL_ERROR",
      detail: "MEX could not inspect repository capabilities safely.",
    },
  };
}

export function capabilitiesInvalidRequestEnvelope(): CapabilitiesProblemEnvelope {
  return {
    schemaVersion: CAPABILITIES_SCHEMA_VERSION,
    ok: false,
    data: null,
    diagnostics: [],
    problem: {
      title: "Invalid capability command",
      status: 400,
      code: "INVALID_REQUEST",
      detail: "Use exactly: mex capabilities --json",
    },
  };
}
