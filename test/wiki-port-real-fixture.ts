import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { stringify as stringifyYaml } from "yaml";
import { indexedCorpusRevision, exactFileContentHash } from "../src/wiki/model/hash.js";
import { openSqlite } from "../src/graph/db/sqlite.js";
import type { EntityRef, JsonValue } from "../src/team/contracts/shared.js";
import type { WikiOperationRequest, WikiPort } from "../src/team/contracts/wiki.js";
import {
  createRepositoryWikiPort,
  type RepositoryWikiGroundingSnapshot,
  type RepositoryWikiMigrationPlan,
  type RepositoryWikiOperationPayload,
  type RepositoryWikiOperationPlan,
} from "../src/wiki/application-adapter.js";
import {
  POPULATED_WIKI_FIXTURE,
  type MockWikiEntitySeed,
} from "../src/team/testing/wiki/populated-fixture.js";
import type {
  WikiContractOracle,
  WikiContractScenario,
  WikiContractSnapshot,
  WikiPortContractHarness,
} from "./contracts/wiki-port.contract.js";

type RealPort = WikiPort<
  never,
  RepositoryWikiOperationPayload,
  RepositoryWikiOperationPlan,
  RepositoryWikiMigrationPlan
>;

const refs = POPULATED_WIKI_FIXTURE.refs;
const BOOTSTRAP_AUDIT = `${JSON.stringify({
  v: 1,
  phase: "complete",
  opId: "operation_fixture_bootstrap",
  type: "update-entry",
  entityIds: [],
  createdIds: [],
  actor: { kind: "system", id: "fixture" },
  timestamp: "2026-08-21T00:00:00.000Z",
  files: [],
  payloadHash: "0".repeat(64),
  revisions: [],
})}\n`;

export const REAL_WIKI_ORACLE: WikiContractOracle = {
  lookup: ref(refs.spec),
  search: { text: "webhook", expected: ref(refs.pattern), kind: "pattern" },
  relation: {
    source: ref(refs.currentDecision),
    target: ref(refs.oldDecision),
    type: "supersedes",
  },
  groundingCases: {
    renamed: { ref: ref(refs.currentDecision), health: "fresh" },
    changed: { ref: ref(refs.requirement), health: "changed" },
    ambiguous: { ref: ref(refs.pattern), health: "ambiguous" },
    missing: { ref: ref(refs.risk), health: "missing" },
    unverified: { ref: ref(refs.evidence), health: "unverified" },
  },
  lifecycleCases: {
    changedButCurrent: ref(refs.requirement),
    deprecatedButFresh: ref(refs.oldDecision),
  },
  archived: ref(refs.archivedDecision),
};

interface Effects {
  canonicalWrites: number;
  indexRebuilds: number;
  indexRefreshes: number;
}

export async function openRealWikiHarness(
  scenario: WikiContractScenario,
): Promise<WikiPortContractHarness<
  never,
  RepositoryWikiOperationPayload,
  RepositoryWikiOperationPlan,
  RepositoryWikiMigrationPlan
>> {
  const root = mkdtempSync(join(tmpdir(), "mex-wiki-real-contract-"));
  const scaffoldRoot = join(root, ".mex");
  const indexPath = join(scaffoldRoot, "wiki.db");
  const effects: Effects = { canonicalWrites: 0, indexRebuilds: 0, indexRefreshes: 0 };
  const state: { failNextRefresh: boolean; migratedId: string | null } = {
    failNextRefresh: false,
    migratedId: null,
  };

  if (scenario === "legacy") copyLegacyFixture(scaffoldRoot);
  else writePopulatedFixture(scaffoldRoot, scenario === "invalid-reference");

  const raw = createRepositoryWikiPort(root, {
    groundingBridge: scenario === "legacy" ? null : fixtureGroundingBridge(),
    now: () => "2026-08-22T00:00:00.000Z",
    __internal: {
      failOperationIndexRefresh: () => {
        const fail = state.failNextRefresh;
        state.failNextRefresh = false;
        return fail;
      },
    },
  });
  const port = instrument(raw, effects, state);

  if (scenario !== "index-missing" && scenario !== "legacy") {
    await port.rebuildIndex();
  }
  if (scenario === "index-refresh-failure") state.failNextRefresh = true;
  if (scenario === "index-stale") {
    appendManualEdit(scaffoldRoot, POPULATED_WIKI_FIXTURE.entities[0]!.sourcePath, "\nUnindexed canonical edit.\n");
  }
  if (scenario === "index-corrupt") corruptIndex(indexPath);

  const legacyRef: EntityRef = {
    get id() {
      return state.migratedId ?? "mx_01J0000000000000000000000A";
    },
    kind: "architecture",
  };
  const oracle: WikiContractOracle = scenario === "legacy"
    ? {
        ...REAL_WIKI_ORACLE,
        legacy: {
          entity: legacyRef,
          sourcePath: ".mex/context/architecture.md",
          eventsPath: ".mex/events/decisions.jsonl",
          preservedFragments: [
            "The capture attempt is persisted before calling the payment gateway.",
            "mex://function:retryPaymentCapture",
            "grounds_to:",
          ],
        },
      }
    : REAL_WIKI_ORACLE;

  return {
    port,
    oracle,
    async makeOperation(kind) {
      const current = await port.getEntity(refs.currentDecision);
      if (!current) throw new Error("Current decision fixture is missing.");
      const invalidRelation = kind === "invalid-relation";
      const validThenInvalid = kind === "valid-then-invalid";
      const outside = kind === "outside-path";
      const type = invalidRelation ? "add-relation" : outside ? "move-entry" : "update-entry";
      const payload: JsonValue = validThenInvalid
        ? {
            operations: [
              {
                type: "update-entry",
                entityId: refs.currentDecision,
                summary: "This valid first item must be rolled back.",
              },
              {
                type: "add-relation",
                relation: {
                  type: "depends_on",
                  source: ref(refs.currentDecision),
                  target: { id: "mx_01J0000000000000000000000Z", kind: "component" },
                },
              },
            ],
          }
        : invalidRelation
        ? { relation: { type: "depends_on", target: "mx_01J0000000000000000000000Z" } }
        : outside
          ? { file: "../../outside.md", insertAt: { at: "end-of-file" } }
          : {
              body: kind === "changed-replay"
                ? "A different payload must not reuse an accepted operation ID."
                : "Retry gateway timeouts with bounded backoff and the original idempotency key.",
            };
      return {
        operation: {
          opId: validThenInvalid
            ? "operation_atomic_rollback"
            : invalidRelation
              ? "operation_invalid_relation"
            : "operation_update_decision",
          type,
          entityId: kind === "envelope-target-mismatch" ? refs.pattern : refs.currentDecision,
          baseRevision: kind === "envelope-base-mismatch"
            ? current.version.semanticRevision + 1
            : current.version.semanticRevision,
          baseContentHash: current.version.contentHash,
          actor: { kind: "human", id: "member_contract_reviewer" },
          reason: "Exercise the real WikiPort contract.",
          timestamp: "2026-08-22T00:00:00.000Z",
          payload,
        },
        expectedRevisions: kind === "missing-precondition" ? [] : [{
          target: { kind: "entity", id: refs.currentDecision },
          version: current.version,
        }],
      } satisfies WikiOperationRequest<RepositoryWikiOperationPayload>;
    },
    async makeConcurrentEdit() {
      const current = await port.getEntity(refs.currentDecision);
      if (!current) throw new Error("Current decision fixture is missing.");
      const request: WikiOperationRequest<RepositoryWikiOperationPayload> = {
        operation: {
          opId: "operation_concurrent_edit",
          type: "update-entry",
          entityId: refs.currentDecision,
          baseRevision: current.version.semanticRevision,
          baseContentHash: current.version.contentHash,
          actor: { kind: "human", id: "member_concurrent_editor" },
          reason: "Simulate a concurrent accepted edit.",
          timestamp: "2026-08-22T00:01:00.000Z",
          payload: { summary: "A teammate updated this decision after the first preview." },
        },
        expectedRevisions: [{ target: { kind: "entity", id: refs.currentDecision }, version: current.version }],
      };
      const preview = await port.previewOperations(request);
      await port.applyOperations({ ...request, plan: preview.plan, expectedPreviewRevision: preview.previewRevision });
    },
    async makeUnindexedCanonicalEdits() {
      const selected = await port.getEntity(refs.currentDecision);
      const untouched = await port.getEntity(refs.pattern);
      if (!selected || !untouched) throw new Error("Refresh fixture entities are missing.");
      const selectedText = "Manual decision edit awaiting an explicit targeted refresh.";
      const untouchedText = "Manual pattern edit that must remain stale after the first refresh.";
      replaceEntityBody(root, selected.location.path, selected.body, `\n${selectedText}\n`);
      replaceEntityBody(root, untouched.location.path, untouched.body, `\n${untouchedText}\n`);
      return {
        selected: { entityId: selected.ref.id, path: selected.location.path, body: `\n${selectedText}\n` },
        untouched: { entityId: untouched.ref.id, path: untouched.location.path, body: `\n${untouchedText}\n` },
      };
    },
    async makeMigrationConcurrentEdit(path) {
      appendManualEdit(scaffoldRoot, path, "\nConcurrent manual edit that migration must not overwrite.\n");
    },
    async snapshot() {
      return snapshot(root, effects, await port.inspectIndex());
    },
    async close() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function instrument(
  port: ReturnType<typeof createRepositoryWikiPort>,
  effects: Effects,
  state: { failNextRefresh: boolean; migratedId: string | null },
): RealPort {
  const rebuild = port.rebuildIndex.bind(port);
  port.rebuildIndex = async (context) => {
    const result = await rebuild(context);
    effects.indexRebuilds += 1;
    return result;
  };
  const refresh = port.refreshFiles.bind(port);
  port.refreshFiles = async (paths, context) => {
    const result = await refresh(paths, context);
    effects.indexRefreshes += 1;
    return result;
  };
  const apply = port.applyOperations.bind(port);
  port.applyOperations = async (request) => {
    const result = await apply(request);
    if (result.applied && !result.idempotentReplay) {
      effects.canonicalWrites += result.changes.length;
      if (result.indexRefresh.state === "refreshed") effects.indexRefreshes += 1;
    }
    return result;
  };
  const applyMigration = port.applyMigration.bind(port);
  port.applyMigration = async (request) => {
    const result = await applyMigration(request);
    if (result.applied) effects.canonicalWrites += result.changes.length;
    const entities = await port.listEntities({ includeArchived: true, limit: 100 });
    const migrated = entities.items.find((entity) => entity.location.path === ".mex/context/architecture.md");
    if (migrated) state.migratedId = migrated.ref.id;
    return result;
  };
  return port;
}

function writePopulatedFixture(scaffoldRoot: string, invalidReference: boolean): void {
  const documents = new Map<string, string[]>();
  for (const entity of POPULATED_WIKI_FIXTURE.entities) {
    const relations = POPULATED_WIKI_FIXTURE.relations
      .filter((relation) => relation.source.id === entity.id)
      .map((relation) => ({
        type: relation.type,
        target: relation.target.id,
        ...(relation.note === undefined ? {} : { note: relation.note }),
        ...(relation.metadata === undefined ? {} : { metadata: relation.metadata }),
      }));
    if (invalidReference && entity.id === refs.spec) {
      relations.push({ type: "depends_on", target: "mx_01J0000000000000000000000Z" });
    }
    const metadata: Record<string, unknown> = {
      id: entity.id,
      type: entity.kind,
      status: entity.lifecycleState,
      revision: entity.semanticRevision,
      summary: entity.payload.summary,
      ...(entity.payload.topics.length === 0 ? {} : { topics: entity.payload.topics }),
      ...(relations.length === 0 ? {} : { relations }),
      ...(entity.payload.sources.length === 0 ? {} : { sources: entity.payload.sources }),
    };
    const grounding = groundingFor(entity);
    if (grounding) metadata["grounds_to"] = [grounding];
    const relativePath = entity.sourcePath.replace(/^\.mex\//, "");
    const blocks = documents.get(relativePath) ?? [];
    blocks.push(`<!-- mex:entity\n${stringifyYaml(metadata).trimEnd()}\n-->\n## ${entity.title}\n\n${entity.payload.body}\n`);
    documents.set(relativePath, blocks);
  }
  for (const [relativePath, blocks] of documents) {
    const path = join(scaffoldRoot, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, blocks.join("\n"), "utf8");
  }
  const audit = join(scaffoldRoot, "events", "operations.jsonl");
  mkdirSync(dirname(audit), { recursive: true });
  writeFileSync(audit, BOOTSTRAP_AUDIT, "utf8");
}

function groundingFor(entity: MockWikiEntitySeed): Record<string, unknown> | null {
  const kind = entity.payload.groundingCase
    ?? (entity.groundingHealth === "fresh" ? "fresh" : null);
  if (kind === null) return null;
  const suffix = entity.id.slice(-8).toLowerCase().replace(/[^0-9a-f]/g, "a").padStart(8, "a");
  const node = `function:${suffix}${suffix}`;
  const fingerprint = `mh:4:${suffix}`;
  return {
    node,
    fingerprint,
    ...(kind === "changed" || kind === "fresh" || kind === "renamed" ? { bodyHash: `baseline-${node}` } : {}),
    reason: `Fixture ${kind} grounding`,
  };
}

function fixtureGroundingGraph(): RepositoryWikiGroundingSnapshot {
  const groundings = new Map(POPULATED_WIKI_FIXTURE.entities.flatMap((entity) => {
    const grounding = groundingFor(entity);
    return grounding ? [[entity.id, grounding] as const] : [];
  }));
  const byNode = new Map([...groundings.entries()].map(([id, grounding]) => [String(grounding["node"]), { id, grounding }]));
  return {
    revision: "fixture-graph-revision-v1",
    getNode(nodeId) {
      let entry = byNode.get(nodeId);
      if (!entry) {
        const original = [...groundings.entries()].find(([, grounding]) => String(grounding["node"]) === nodeId.replace(/a$/, ""));
        if (!original) return null;
        entry = { id: original[0], grounding: original[1] };
      }
      const seed = POPULATED_WIKI_FIXTURE.entities.find((entity) => entity.id === entry.id);
      if (!seed || ["ambiguous", "missing", "unverified"].includes(seed.payload.groundingCase ?? "")) return null;
      if (seed.payload.groundingCase === "renamed" && !nodeId.endsWith("a")) return null;
      const grounding = entry.grounding;
      return {
        id: nodeId,
        bodyHash: seed.payload.groundingCase === "changed"
          ? `current-${nodeId}`
          : String(grounding["bodyHash"]),
        filePath: seed.sourcePath.replace(/^\.mex\//, ""),
        startLine: 1,
        endLine: 1,
      };
    },
    getFingerprint(nodeId) {
      const entry = byNode.get(nodeId.replace(/a$/, "")) ?? byNode.get(nodeId);
      return entry ? String(entry.grounding["fingerprint"]) : null;
    },
    reconcile(nodeId) {
      const entry = byNode.get(nodeId);
      const seed = POPULATED_WIKI_FIXTURE.entities.find((entity) => entity.id === entry?.id);
      switch (seed?.payload.groundingCase) {
        case "renamed":
          return { kind: "MOVED", nodeId: `${nodeId}a` };
        case "ambiguous":
          return { kind: "AMBIGUOUS", candidate: `${nodeId}b` };
        case "missing":
          return { kind: "GONE" };
        case "unverified":
        default:
          return null;
      }
    },
    getBaselineSource() {
      return null;
    },
  };
}

function fixtureGroundingBridge() {
  const graph = fixtureGroundingGraph();
  return {
    async withFreshGroundingSnapshot<T>(callback: (snapshot: RepositoryWikiGroundingSnapshot) => T | Promise<T>): Promise<T> {
      return callback(graph);
    },
  };
}

function copyLegacyFixture(scaffoldRoot: string): void {
  const fixture = fileURLToPath(new URL("./fixtures/wiki/legacy-scaffold/.mex", import.meta.url));
  cpSync(fixture, scaffoldRoot, { recursive: true });
  // The historical fixture predates the graph-v3 node-id grammar. Preserve
  // its prose and URI evidence while making its structured grounding a valid,
  // migratable legacy input for the real adapter contract.
  const architecture = join(scaffoldRoot, "context", "architecture.md");
  writeFileSync(
    architecture,
    readFileSync(architecture, "utf8").replace(
      'node: "function:persistCaptureAttempt"',
      'node: "function:1111111111111111"',
    ),
    "utf8",
  );
  const unchanged = join(scaffoldRoot, "notes", "unchanged.md");
  mkdirSync(dirname(unchanged), { recursive: true });
  writeFileSync(
    unchanged,
    "# Historical notes\n\nThis path has no structural migration rule and must remain byte-identical.\n",
    "utf8",
  );
  const audit = join(scaffoldRoot, "events", "operations.jsonl");
  if (!existsSync(audit)) writeFileSync(audit, BOOTSTRAP_AUDIT, "utf8");
}

function corruptIndex(indexPath: string): void {
  const db = openSqlite(indexPath);
  try {
    db.prepare("DELETE FROM wiki_meta WHERE key = 'indexed_revision'").run();
  } finally {
    db.close();
  }
}

function replaceEntityBody(root: string, projectPath: string, before: string, after: string): void {
  const path = join(root, projectPath);
  const text = readFileSync(path, "utf8");
  if (!text.includes(before)) throw new Error(`Fixture body is missing from ${projectPath}.`);
  writeFileSync(path, text.replace(before, after), "utf8");
}

function appendManualEdit(scaffoldRoot: string, projectOrScaffoldPath: string, text: string): void {
  const relativePath = projectOrScaffoldPath.replace(/^\.mex\//, "");
  const path = join(scaffoldRoot, relativePath);
  writeFileSync(path, `${readFileSync(path, "utf8")}${text}`, "utf8");
}

async function snapshot(
  root: string,
  effects: Effects,
  status: Awaited<ReturnType<RealPort["inspectIndex"]>>,
): Promise<WikiContractSnapshot> {
  const files = canonicalFiles(root);
  const markdown = Object.entries(files)
    .filter(([path]) => /\.mdx?$/i.test(path))
    .map(([path, text]) => ({ path: path.replace(/^\.mex\//, ""), contentHash: exactFileContentHash(text) }));
  const canonicalDigest = indexedCorpusRevision(markdown);
  const dbPath = join(root, ".mex", "wiki.db");
  const indexDigest = status.indexedRevision
    ?? (existsSync(dbPath) ? createHash("sha256").update(readFileSync(dbPath)).digest("hex") : "0".repeat(64));
  return {
    canonicalDigest,
    indexDigest,
    files,
    canonicalWrites: effects.canonicalWrites,
    indexRebuilds: effects.indexRebuilds,
    indexRefreshes: effects.indexRefreshes,
    auditEntries: acceptedAuditCount(files[".mex/events/operations.jsonl"] ?? ""),
    agentLaunches: 0,
  };
}

function canonicalFiles(root: string): Record<string, string> {
  const scaffoldRoot = join(root, ".mex");
  const result: Record<string, string> = {};
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolute);
        continue;
      }
      const path = relative(root, absolute).replaceAll("\\", "/");
      if (/wiki\.db(?:$|[-.])/.test(entry.name)) continue;
      result[path] = readFileSync(absolute, "utf8");
    }
  };
  visit(scaffoldRoot);
  return result;
}

function acceptedAuditCount(text: string): number {
  return text.split("\n").filter(Boolean).filter((line) => {
    try {
      return (JSON.parse(line) as { phase?: unknown }).phase === "complete";
    } catch {
      return false;
    }
  }).length;
}

function ref(id: string): EntityRef {
  const entity = POPULATED_WIKI_FIXTURE.entities.find((candidate) => candidate.id === id);
  if (!entity) throw new Error(`Unknown fixture entity ${id}.`);
  return { id: entity.id, kind: entity.kind };
}
