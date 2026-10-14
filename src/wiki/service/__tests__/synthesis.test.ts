/**
 * §12 end to end, with the agent stubbed.
 *
 * This is the exit criterion the plan's own "run the builder against a real
 * repository" cannot check. mex makes no model calls, so with no agent every
 * count in that criterion is zero and it passes over an empty set — the first
 * vacuity shape, in the phase gate itself. What is actually checkable is the
 * deterministic half with the agent seam injected: a fixture response file *is*
 * the agent, and every stage runs against it with no model anywhere.
 *
 * The whole file also asserts H1 by construction: a `fetch` that throws is
 * planted for the duration, so any network call at all fails the run rather
 * than depending on the machine having no network.
 */

import { describe, it, expect, afterEach, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  wikiSynthesisBuild,
  wikiSynthesisPrepare,
  wikiSynthesisPropose,
  wikiPrepareSynthesisPropose,
  type SynthesisOptions,
} from "../synthesis.js";
import { wikiRebuildIndex } from "../write.js";
import { parseWikiMarkdown } from "../../markdown/contract.js";
import { readAuditLog } from "../../operations/audit.js";
import { appendAudit, auditRecord } from "../../operations/audit.js";
import { planOperation } from "../../operations/plan.js";
import { proposeUnits } from "../../synthesis/propose.js";
import type { CandidateUnit } from "../../synthesis/candidates.js";
import type { GroundingGraph, SynthesisGraph } from "../../grounding/adapter.js";

const ISSUE = "function:a3f8c21d9e4b7f60a1c2d3e4f5061728";
const VERIFY = "function:b4f8c21d9e4b7f60a1c2d3e4f5061729";
const FINGERPRINT = "mh:64:9f2a4c6e";
const BODY_HASH = "b".repeat(64);

const NODES: Record<string, { kind: string; name: string; filePath: string; startLine: number; endLine: number; isExported: boolean }> = {
  [ISSUE]: { kind: "function", name: "issueToken", filePath: "src/auth/tokens.ts", startLine: 1, endLine: 4, isExported: true },
  [VERIFY]: { kind: "function", name: "verifyToken", filePath: "src/auth/verify.ts", startLine: 1, endLine: 4, isExported: true },
};

const codeGraph: SynthesisGraph = {
  listFiles: () => [{ path: "src/auth/tokens.ts" }, { path: "src/auth/verify.ts" }],
  nodesInFile: (filePath) =>
    Object.entries(NODES)
      .filter(([, node]) => node.filePath === filePath)
      .map(([id, node]) => ({ id, kind: node.kind })),
  describeNode: (id) => {
    const node = NODES[id];
    return node === undefined ? null : { id, ...node };
  },
  callersOf: (id) => (id === VERIFY ? [ISSUE] : []),
  calleesOf: (id) => (id === ISSUE ? [VERIFY] : []),
  outgoingEdges: (id) => (id === ISSUE ? [{ source: ISSUE, target: VERIFY, kind: "calls" }] : []),
};

const graph: GroundingGraph = {
  getNode: (id) => {
    const node = NODES[id];
    return node === undefined ? null : { id, bodyHash: BODY_HASH, filePath: node.filePath, startLine: node.startLine, endLine: node.endLine };
  },
  getFingerprint: (id) => (NODES[id] === undefined ? null : FINGERPRINT),
  reconcile: () => null,
  getBaselineSource: () => {
    throw new Error("synthesis must not read the cached baseline");
  },
};

let fetchWas: typeof globalThis.fetch | undefined;

beforeAll(() => {
  fetchWas = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new Error("mex makes no model calls and must never reach the network");
  }) as typeof globalThis.fetch;
});

afterAll(() => {
  if (fetchWas !== undefined) globalThis.fetch = fetchWas;
});

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    try {
      rmSync(roots.pop()!, { recursive: true, force: true });
    } catch {
      // Windows keeps handles on just-closed SQLite files.
    }
  }
});

interface Fixture {
  repoRoot: string;
  scaffoldRoot: string;
  options: SynthesisOptions;
}

function fixture(): Fixture {
  const repoRoot = mkdtempSync(join(tmpdir(), "mex-syn-repo-"));
  roots.push(repoRoot);
  mkdirSync(join(repoRoot, "src", "auth"), { recursive: true });
  writeFileSync(
    join(repoRoot, "src", "auth", "tokens.ts"),
    "export function issueToken(userId: string): string {\n  return `tok:${userId}`;\n}\n",
    "utf-8",
  );
  writeFileSync(
    join(repoRoot, "src", "auth", "verify.ts"),
    "export function verifyToken(token: string): boolean {\n  return token.startsWith('tok:');\n}\n",
    "utf-8",
  );

  const scaffoldRoot = join(repoRoot, ".mex");
  mkdirSync(join(scaffoldRoot, "context"), { recursive: true });
  mkdirSync(join(scaffoldRoot, "patterns"), { recursive: true });
  writeFileSync(join(scaffoldRoot, "context", "architecture.md"), "# Architecture\n\nHow this is shaped.\n", "utf-8");
  writeFileSync(join(scaffoldRoot, "context", "conventions.md"), "# Conventions\n\nHow we work.\n", "utf-8");

  return { repoRoot, scaffoldRoot, options: { scaffoldRoot, repoRoot, codeGraph, graph } };
}

function writeResponse(root: string, name: string, body: unknown): string {
  const path = join(root, name);
  writeFileSync(path, JSON.stringify(body), "utf-8");
  return path;
}

function unitsResponse(cluster = "auth"): unknown {
  return {
    stage: "architecture_component",
    cluster,
    units: [
      {
        type: "component",
        title: "Token issuance is centralised",
        summary: "Every token in this system is minted by one exported function.",
        body: "The auth module exposes a single mint path; callers never build a token themselves.",
        confidence: 0.91,
        grounding: { nodeIds: [ISSUE] },
        reasoning: "scratch space mex drops",
      },
      {
        type: "component",
        title: "Token verification is a pure predicate",
        summary: "Verification reads the token and returns a boolean, touching no state.",
        body: "Verification is a pure function over the token string, which is what makes it safe to call anywhere.",
        confidence: 0.88,
        grounding: { nodeIds: [VERIFY] },
      },
      {
        type: "component",
        title: "A claim mex must refuse",
        summary: "Grounded to a node the agent invented rather than copied.",
        body: "This unit names a node id that was never in the cluster context it was given.",
        confidence: 0.95,
        grounding: { nodeIds: ["function:invented"] },
      },
      {
        type: "component",
        title: "A claim below the floor",
        summary: "The model itself said it was not confident about this one.",
        body: "Confidence beneath the in_flight floor, so mex must not propose it at all.",
        confidence: 0.2,
        grounding: { nodeIds: [ISSUE] },
      },
    ],
  };
}

describe("wiki build", () => {
  it("refuses without a code graph, rather than reporting an empty repository", () => {
    // The distinction matters: "no clusters" and "no graph to cluster" have
    // different fixes, and a caller that cannot tell them apart concludes the
    // repository has no structure worth writing about.
    const { options } = fixture();
    const result = wikiSynthesisBuild({ ...options, codeGraph: null });
    expect(result.data.clusters).toEqual([]);
    expect(result.diagnostics.map((entry) => entry.code)).toEqual(["WIKI_INDEX_MISSING"]);
  });

  it("finds the clusters and renders a playbook naming them", () => {
    const { options } = fixture();
    const result = wikiSynthesisBuild(options);
    expect(result.diagnostics).toEqual([]);
    expect(result.data.clusters).toEqual([{ name: "auth", files: 2, symbols: 2 }]);
    expect(result.data.playbook).toContain("auth");
    expect(result.data.playbook).toContain("mex wiki prepare");
    expect(result.data.playbook).toContain("mex wiki propose");
  });

  it("addresses commands rather than tools, and mentions no server", () => {
    // The reference addressed nine MCP tools. mex has no MCP server, so a
    // playbook that named one would send an agent looking for something that
    // does not exist and stop the run at step zero.
    const playbook = wikiSynthesisBuild(fixture().options).data.playbook;
    expect(playbook).not.toMatch(/kg_[a-z_]+/);
    expect(playbook.toLowerCase()).not.toContain("mcp");
  });

  it("writes nothing at all", () => {
    // The reference wrote its playbook beside the database. Under `.mex/` that
    // would be a write into the scaffold no operation accounts for.
    const { scaffoldRoot, options } = fixture();
    wikiSynthesisBuild(options);
    expect(existsSync(join(scaffoldRoot, "kg_build_prompt.md"))).toBe(false);
    expect(existsSync(join(scaffoldRoot, "events"))).toBe(false);
  });

  it("is deterministic", () => {
    const { options } = fixture();
    expect(JSON.stringify(wikiSynthesisBuild(options))).toBe(JSON.stringify(wikiSynthesisBuild(options)));
  });
});

describe("wiki prepare", () => {
  it("returns a stage's prompt with every node id the grounding check will accept", () => {
    const { options } = fixture();
    const result = wikiSynthesisPrepare({ ...options, stage: "architecture_component", cluster: "auth" });
    expect(result.diagnostics).toEqual([]);
    expect(result.data.cluster).toBe("auth");
    expect(result.data.prompt!.user).toContain(ISSUE);
    expect(result.data.prompt!.user).toContain(VERIFY);
    expect(result.data.prompt!.user).toContain("issueToken");
  });

  it("names the cluster it could not find rather than silently taking another", () => {
    const { options } = fixture();
    const result = wikiSynthesisPrepare({ ...options, stage: "pattern", cluster: "billing" });
    expect(result.data.prompt).toBeNull();
    expect(result.diagnostics[0]!.message).toContain("billing");
  });

  it("is deterministic across the three per-cluster stages", () => {
    const { options } = fixture();
    for (const stage of ["architecture_component", "pattern", "convention"] as const) {
      const once = wikiSynthesisPrepare({ ...options, stage, cluster: "auth" });
      const twice = wikiSynthesisPrepare({ ...options, stage, cluster: "auth" });
      expect(JSON.stringify(once), stage).toBe(JSON.stringify(twice));
    }
  });
});

describe("wiki propose — stage A", () => {
  it.each([false, true])("refuses intent-only recovery without reminting ids, canonical rename landed: %s", (landed) => {
    const { repoRoot, scaffoldRoot, options } = fixture();
    const response = unitsResponse() as { units: CandidateUnit[] };
    const proposed = proposeUnits([{ ...response.units[0]!, status: "promoted", stage: "architecture_component", cluster: "auth" }], { graph });
    const envelope = proposed.operations[0]!.envelope;
    const planned = planOperation(envelope, { scaffoldRoot, graph, captureCreationProvenance: true });
    if (!planned.ok) throw new Error(JSON.stringify(planned.diagnostics));
    appendAudit(scaffoldRoot, auditRecord(planned.plan, "intent"));
    if (landed) for (const file of planned.plan.files) writeFileSync(file.absolutePath, file.proposedText);
    const path = join(scaffoldRoot, "context/architecture.md");
    const before = readFileSync(path, "utf8");
    const auditPath = join(scaffoldRoot, "events/operations.jsonl");
    const auditBefore = readFileSync(auditPath, "utf8");
    const result = wikiSynthesisPropose({ ...options,
      responsePath: writeResponse(repoRoot, "units.json", response), apply: true });
    expect(result.data).toMatchObject({ applied: false, changedFiles: [], createdIds: [] });
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "CONTENT_HASH_CONFLICT",
      message: expect.stringContaining("Recovery required"), remediation: expect.stringContaining("exact original reviewed operation") }));
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(readFileSync(auditPath, "utf8")).toBe(auditBefore);
    const parsed = parseWikiMarkdown({ path: "context/architecture.md", text: before });
    expect(parsed.entities.map(entry => entry.entity.id)).toEqual(landed ? planned.plan.createdIds : []);
    expect(readAuditLog(scaffoldRoot).entries[0]!.createdIds).toEqual(planned.plan.createdIds);
  });

  it("prepares exact plans without writes, then publishes only those reviewed ids", () => {
    const { repoRoot, scaffoldRoot, options } = fixture();
    const responsePath = writeResponse(repoRoot, "units.json", unitsResponse());
    const path = join(scaffoldRoot, "context/architecture.md");
    const before = readFileSync(path, "utf8");
    const prepared = wikiPrepareSynthesisPropose({ ...options, responsePath });
    prepared.preflight();
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(existsSync(join(scaffoldRoot, "events"))).toBe(false);
    const result = prepared.commit();
    expect(result.data.applied).toBe(true);
    const parsed = parseWikiMarkdown({ path: "context/architecture.md", text: readFileSync(path, "utf8") });
    expect(parsed.entities.map(entry => entry.entity.id)).toEqual(result.data.createdIds);
    expect(result.data.createdIds).toHaveLength(2);
  });

  it("discards a prepared synthesis publication without touching knowledge or audit", () => {
    const { repoRoot, scaffoldRoot, options } = fixture();
    const path = join(scaffoldRoot, "context/architecture.md");
    const before = readFileSync(path, "utf8");
    const prepared = wikiPrepareSynthesisPropose({ ...options,
      responsePath: writeResponse(repoRoot, "units.json", unitsResponse()) });
    prepared.discard();
    expect(() => prepared.commit()).toThrow("no longer active");
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(existsSync(join(scaffoldRoot, "events"))).toBe(false);
  });

  it("refuses a changed canonical file before any prepared sibling is written", () => {
    const { repoRoot, scaffoldRoot, options } = fixture();
    const path = join(scaffoldRoot, "context/architecture.md");
    const prepared = wikiPrepareSynthesisPropose({ ...options,
      responsePath: writeResponse(repoRoot, "units.json", unitsResponse()) });
    const changed = `${readFileSync(path, "utf8")}\nA concurrent authored note.\n`;
    writeFileSync(path, changed);
    const result = prepared.commit();
    expect(result.data.applied).toBe(false);
    expect(result.data.changedFiles).toEqual([]);
    expect(result.diagnostics.some(entry => entry.severity === "error")).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(changed);
    expect(existsSync(join(scaffoldRoot, "events"))).toBe(false);
  });

  it("refuses a response that is not readable as one", () => {
    const { repoRoot, options } = fixture();
    const path = join(repoRoot, "broken.json");
    writeFileSync(path, "{ not json", "utf-8");
    const result = wikiSynthesisPropose({ ...options, responsePath: path });
    expect(result.diagnostics.map((entry) => entry.code)).toEqual(["INVALID_AGENT_RESPONSE"]);
  });

  it("refuses a response carrying no units array, distinctly from one carrying none", () => {
    // "You sent nothing valid" and "you validly sent nothing" must not read the
    // same, or a broken hand-off looks like a clean run that proposed nothing.
    const { repoRoot, options } = fixture();
    const broken = wikiSynthesisPropose({
      ...options,
      responsePath: writeResponse(repoRoot, "no-units.json", { stage: "pattern", cluster: "auth", notUnits: [] }),
    });
    expect(broken.diagnostics.map((entry) => entry.code)).toEqual(["INVALID_AGENT_RESPONSE"]);

    const empty = wikiSynthesisPropose({
      ...options,
      responsePath: writeResponse(repoRoot, "empty.json", { stage: "pattern", cluster: "auth", units: [] }),
    });
    expect(empty.diagnostics).toEqual([]);
    expect(empty.data.received).toBe(0);
    expect(empty.data.operations).toEqual([]);
  });

  it("gates, plans, and writes nothing without explicit authority", () => {
    const { repoRoot, scaffoldRoot, options } = fixture();
    const before = readFileSync(join(scaffoldRoot, "context", "architecture.md"), "utf-8");
    const result = wikiSynthesisPropose({
      ...options,
      responsePath: writeResponse(repoRoot, "units.json", unitsResponse()),
    });

    expect(result.data.received).toBe(4);
    expect(result.data.accepted).toBe(2);
    expect(result.data.rejected).toHaveLength(2);
    const reasons = result.data.rejected.flatMap((entry) => entry.reasons).join(" ");
    expect(reasons).toContain("function:invented");
    expect(reasons).toContain("0.2");

    expect(result.data.operations).toHaveLength(2);
    expect(result.data.diff).not.toBeNull();
    // The negative that matters: a plan is not a write.
    expect(result.data.applied).toBe(false);
    expect(readFileSync(join(scaffoldRoot, "context", "architecture.md"), "utf-8")).toBe(before);
    expect(existsSync(resolve(scaffoldRoot, "events", "operations.jsonl"))).toBe(false);
  });

  it("applies with authority, and every proposal survives its own preview", () => {
    const { repoRoot, scaffoldRoot, options } = fixture();
    const result = wikiSynthesisPropose({
      ...options,
      responsePath: writeResponse(repoRoot, "units.json", unitsResponse()),
      apply: true,
    });

    expect(result.diagnostics.filter((entry) => entry.severity === "error")).toEqual([]);
    expect(result.data.applied).toBe(true);
    expect(result.data.createdIds).toHaveLength(2);

    const path = join(scaffoldRoot, "context", "architecture.md");
    const parsed = parseWikiMarkdown({ path: "context/architecture.md", text: readFileSync(path, "utf-8") });
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.entities).toHaveLength(2);
    const completed = readAuditLog(scaffoldRoot).entries.filter((entry) => entry.phase === "complete");
    for (const entry of parsed.entities) {
      expect(entry.entity.status).toBe("promoted");
      // Every grounding came from the graph, so every one carries a body hash.
      expect(entry.entity.groundsTo[0]!.bodyHash).toBe(BODY_HASH);
      expect((entry.entity.metadata as { synthesis: { confidence: number } }).synthesis.confidence).toBeGreaterThan(0.8);
      const audit = completed.find((record) => record.createdIds.includes(entry.entity.id));
      expect(audit?.actor).toEqual({ kind: "agent", id: "synthesis" });
      expect(entry.entity.provenance).toEqual({ createdBy: audit!.actor, createdAt: audit!.timestamp });
    }
    // And the prose that was there is still there.
    expect(readFileSync(path, "utf-8")).toContain("How this is shaped.");
  });

  it("is idempotent: the same response applied twice creates nothing new", () => {
    const { repoRoot, scaffoldRoot, options } = fixture();
    const responsePath = writeResponse(repoRoot, "units.json", unitsResponse());
    const first = wikiSynthesisPropose({ ...options, responsePath, apply: true });
    const again = wikiSynthesisPropose({ ...options, responsePath, apply: true });

    // The opId is derived from the payload, so the second run replays: the
    // same ids come back rather than new ones, and nothing is written.
    expect(again.data.createdIds).toEqual(first.data.createdIds);
    expect(again.data.applied).toBe(false);
    const parsed = parseWikiMarkdown({
      path: "context/architecture.md",
      text: readFileSync(join(scaffoldRoot, "context", "architecture.md"), "utf-8"),
    });
    expect(parsed.entities).toHaveLength(2);
  });

  it("retains completed create ids when a later response includes another new unit", () => {
    const { repoRoot, scaffoldRoot, options } = fixture();
    const original = unitsResponse() as { stage: string; cluster: string; units: Array<Record<string, unknown>> };
    const first = wikiSynthesisPropose({ ...options,
      responsePath: writeResponse(repoRoot, "first.json", original), apply: true });
    const extended = { ...original, units: [...original.units, { ...original.units[0],
      title: "Token callers share the same issuer", body: "Token creation callers use the central issuer, so their token format follows that single implementation." }] };
    const second = wikiSynthesisPropose({ ...options,
      responsePath: writeResponse(repoRoot, "second.json", extended), apply: true });
    expect(second.data.applied).toBe(true);
    expect(second.data.createdIds.slice(0, 2)).toEqual(first.data.createdIds);
    expect(second.data.createdIds).toHaveLength(3);
    const parsed = parseWikiMarkdown({ path: "context/architecture.md",
      text: readFileSync(join(scaffoldRoot, "context/architecture.md"), "utf8") });
    expect(parsed.entities.map(entry => entry.entity.id)).toEqual(second.data.createdIds);
  });

  it("refuses every unit when the graph is gone, however good the candidates", () => {
    // §38's asymmetry: a read with no graph degrades, a write that mints a
    // permanent canonical reference does not.
    const { repoRoot, options } = fixture();
    const result = wikiSynthesisPropose({
      ...options,
      graph: null,
      responsePath: writeResponse(repoRoot, "units.json", unitsResponse()),
      apply: true,
    });
    expect(result.data.operations).toEqual([]);
    expect(result.data.applied).toBe(false);
    expect(result.diagnostics.map((entry) => entry.code)).toContain("GROUNDING_UNVERIFIED");
  });
});

describe("wiki propose — stages B and C, over applied state", () => {
  function withAppliedUnits(): Fixture {
    const made = fixture();
    wikiSynthesisPropose({
      ...made.options,
      responsePath: writeResponse(made.repoRoot, "units.json", unitsResponse()),
      apply: true,
    });
    wikiRebuildIndex({ scaffoldRoot: made.scaffoldRoot });
    return made;
  }

  it("groups nothing when the applied entities are genuinely different", () => {
    // The polarity first, so a later "it grouped them" is a measurement.
    const { options } = withAppliedUnits();
    const prepared = wikiSynthesisPrepare({ ...options, stage: "global" });
    expect(prepared.diagnostics).toEqual([]);
    expect(prepared.data.groups).toEqual([]);
    expect(prepared.data.prompt!.user).toContain("no candidate groups");
  });

  it("proposes relationship candidates from the code-graph edge between two entities", () => {
    const { options } = withAppliedUnits();
    const prepared = wikiSynthesisPrepare({ ...options, stage: "relationships" });
    expect(prepared.diagnostics).toEqual([]);
    expect(prepared.data.candidates).toHaveLength(1);
    const candidate = prepared.data.candidates[0]!;
    expect(candidate.allowedTypes).toContain("depends_on");
    expect(prepared.data.prompt!.user).toContain(candidate.candidateId);
  });

  it("turns a judgement into an add-relation the wiki actually carries", () => {
    const { repoRoot, scaffoldRoot, options } = withAppliedUnits();
    const candidate = wikiSynthesisPrepare({ ...options, stage: "relationships" }).data.candidates[0]!;

    const result = wikiSynthesisPropose({
      ...options,
      apply: true,
      responsePath: writeResponse(repoRoot, "judgments.json", {
        stage: "relationships",
        judgments: [
          {
            candidateId: candidate.candidateId,
            action: "create",
            type: "depends_on",
            sourceId: candidate.source.id,
            targetId: candidate.target.id,
            confidence: 0.9,
            evidence: "issueToken calls verifyToken in the code graph",
            reasoning: "the minting path needs the verification predicate to function",
          },
        ],
      }),
    });

    expect(result.diagnostics.filter((entry) => entry.severity === "error")).toEqual([]);
    expect(result.data.accepted).toBe(1);
    expect(result.data.applied).toBe(true);

    const parsed = parseWikiMarkdown({
      path: "context/architecture.md",
      text: readFileSync(join(scaffoldRoot, "context", "architecture.md"), "utf-8"),
    });
    const source = parsed.entities.find((entry) => entry.entity.id === candidate.source.id)!;
    expect(source.entity.relations).toContainEqual(
      expect.objectContaining({ type: "depends_on", target: candidate.target.id }),
    );
  });

  it("refuses a judgement whose type is outside the candidate's menu", () => {
    const { repoRoot, options } = withAppliedUnits();
    const candidate = wikiSynthesisPrepare({ ...options, stage: "relationships" }).data.candidates[0]!;
    expect(candidate.allowedTypes).not.toContain("constrained_by");

    const result = wikiSynthesisPropose({
      ...options,
      apply: true,
      responsePath: writeResponse(repoRoot, "bad.json", {
        stage: "relationships",
        judgments: [
          {
            candidateId: candidate.candidateId,
            action: "create",
            type: "constrained_by",
            sourceId: candidate.source.id,
            targetId: candidate.target.id,
            confidence: 0.99,
            evidence: "a type the structure does not support at all",
            reasoning: "the agent picked from outside the menu it was given",
          },
        ],
      }),
    });

    expect(result.data.operations).toEqual([]);
    expect(result.data.rejected[0]!.reasons.join(" ")).toContain("not in allowedTypes");
  });

  it("consolidates two entities that do say the same thing", () => {
    const { repoRoot, scaffoldRoot, options } = fixture();
    wikiSynthesisPropose({
      ...options,
      apply: true,
      responsePath: writeResponse(repoRoot, "dupes.json", {
        stage: "convention",
        cluster: "auth",
        units: [
          {
            type: "convention",
            title: "Tokens are minted in one place",
            summary: "Every token comes from the one exported mint function.",
            body: "Callers must not construct a token themselves; use the mint path.",
            confidence: 0.9,
            grounding: { nodeIds: [ISSUE] },
          },
          {
            type: "convention",
            title: "Tokens are minted in one place only",
            summary: "Every token comes from the single exported mint function.",
            body: "Callers should not construct a token themselves; always use the mint path.",
            confidence: 0.85,
            grounding: { nodeIds: [ISSUE] },
          },
        ],
      }),
    });
    wikiRebuildIndex({ scaffoldRoot });

    const prepared = wikiSynthesisPrepare({ ...options, stage: "global" });
    expect(prepared.data.groups).toHaveLength(1);
    const group = prepared.data.groups[0]!;
    expect(group.units).toHaveLength(2);

    const applied = wikiSynthesisPropose({
      ...options,
      apply: true,
      responsePath: writeResponse(repoRoot, "actions.json", {
        stage: "global",
        actions: [
          {
            groupId: group.groupId,
            action: "merge",
            reasoning: "the two state one rule about one function",
            canonicalUnit: {
              type: "convention",
              title: "Tokens are minted in one place",
              summary: "Every token comes from the one exported mint function.",
              body: "Callers must not construct a token themselves; always use the mint path.",
              groundingNodeIds: [ISSUE],
            },
          },
        ],
      }),
    });

    expect(applied.diagnostics.filter((entry) => entry.severity === "error")).toEqual([]);
    expect(applied.data.applied).toBe(true);

    const parsed = parseWikiMarkdown({
      path: "context/conventions.md",
      text: readFileSync(join(scaffoldRoot, "context", "conventions.md"), "utf-8"),
    });
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.entities.filter((entry) => entry.entity.status === "deprecated")).toHaveLength(2);
    const canonical = parsed.entities.find((entry) => entry.entity.status === "in_flight")!.entity;
    expect(canonical.relations.filter((relation) => relation.type === "supersedes")).toHaveLength(2);
    expect(canonical.groundsTo[0]!.node).toBe(ISSUE);
  });
});
