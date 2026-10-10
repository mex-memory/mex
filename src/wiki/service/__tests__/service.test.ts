/**
 * The service surface — §16's eight tools, and the parity §20.7 asks for.
 *
 * The parity assertions here are structural rather than comparative. There is
 * nothing to compare, because there is only one definition: the test asserts
 * that the mapping between §16's tools and §15.1's commands is complete and
 * consistent, and that the layer producing data has no way to produce a colour.
 * A test that compared two implementations would be a test that expected two
 * implementations to exist.
 */

import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  COMMAND_BINDINGS,
  COMMANDS_WITHOUT_TOOLS,
  TOOLS_WITHOUT_COMMANDS,
  SPEC_15_1_COMMANDS,
  WIKI_COMMANDS,
  WIKI_TOOLS,
} from "../surface.js";
import { wikiBacklinks, wikiGet, wikiGraph, wikiGroundingStatus, wikiList, wikiNeighborhood, wikiSearch } from "../read.js";
import { wikiApplyOperation, wikiMigrate, wikiPlanOperation, wikiRebuildIndex } from "../write.js";
import { wikiValidate } from "../validate.js";
import { readAuditLog } from "../../operations/audit.js";
import { locateEntity } from "../../operations/locate.js";
import { envelopeFor, exitCodeFor, WIKI_EXIT } from "../../cli/envelope.js";

const ARCH = "mx_01K4FAM7W8N9R3T5Y6Q2ZBCHJD";
const GATEWAY = "mx_01BX5ZZKBKACTAV9WEVGEMMVRZ";
const TOPIC = "mx_01KRMEXM00JAAVJPQVVRX8N56V";

const SCAFFOLD: Record<string, string> = {
  "context/architecture.md": `<!-- mex:entity
id: ${TOPIC}
type: topic
status: promoted
revision: 1
-->
## Authentication

Everything about tokens.

<!-- mex:entity
id: ${ARCH}
type: architecture
status: promoted
revision: 1
topics: [${TOPIC}]
relations:
  - type: depends_on
    target: ${GATEWAY}
-->
## System architecture

Three services behind one gateway.

<!-- mex:entity
id: ${GATEWAY}
type: component
status: promoted
revision: 1
-->
## Gateway

Terminates TLS and routes by path prefix.
`,
};

/** Source with block and line comments removed, so a rule reads code. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // Windows keeps handles on just-closed SQLite files.
    }
  }
});

function scaffold(indexed = true): string {
  const root = mkdtempSync(join(tmpdir(), "mex-service-"));
  roots.push(root);
  for (const [path, text] of Object.entries(SCAFFOLD)) {
    const absolute = join(root, path);
    mkdirSync(join(absolute, ".."), { recursive: true });
    writeFileSync(absolute, text, "utf-8");
  }
  if (indexed) wikiRebuildIndex({ scaffoldRoot: root });
  return root;
}

describe("the tool and command surfaces", () => {
  it("names eight tools, and §15.1's ten are a subset of what mex implements", () => {
    expect(WIKI_TOOLS).toHaveLength(8);
    // The spec's list is a floor rather than a closed surface. Keeping it
    // separate is what lets an added command be counted without making the
    // spec appear to name it — and what stops an added command from sitting
    // outside the table the suites below walk, which is how `regenerate-views`
    // came to be uncovered by the envelope suite that counts its own cases.
    expect(SPEC_15_1_COMMANDS).toHaveLength(10);
    for (const command of SPEC_15_1_COMMANDS) expect(WIKI_COMMANDS).toContain(command);
    expect(WIKI_COMMANDS).toHaveLength(14);
  });

  it("binds every command to a service function", () => {
    expect(COMMAND_BINDINGS.map((entry) => entry.command)).toEqual([...WIKI_COMMANDS]);
    for (const binding of COMMAND_BINDINGS) expect(binding.service).toBeTruthy();
  });

  it("accounts for every tool exactly once — bound to a command, or listed as having none", () => {
    const bound = new Set(COMMAND_BINDINGS.map((entry) => entry.tool).filter((tool) => tool !== null));
    const unbound = new Set(TOOLS_WITHOUT_COMMANDS);
    for (const tool of WIKI_TOOLS) {
      // Exactly one of the two, so a tool cannot be silently dropped from the
      // surface by being left out of both.
      expect(bound.has(tool) !== unbound.has(tool)).toBe(true);
    }
  });

  it("accounts for every command with no tool", () => {
    const toolless = COMMAND_BINDINGS.filter((entry) => entry.tool === null).map((entry) => entry.command);
    expect(toolless.sort()).toEqual([...COMMANDS_WITHOUT_TOOLS].sort());
  });

  it("marks exactly the commands that can write", () => {
    expect(COMMAND_BINDINGS.filter((entry) => entry.mutates).map((entry) => entry.command)).toEqual([
      "migrate",
      "apply",
      "regenerate-views",
      "propose",
    ]);
  });

  it("keeps every colour library out of the layer that produces data", () => {
    // Structural, not aspirational: §15.2's "no ANSI in JSON" holds because the
    // modules that build `data` have no colour library in scope at all.
    const directory = resolve(__dirname, "..");
    let scanned = 0;
    for (const name of readdirSync(directory)) {
      if (!name.endsWith(".ts")) continue;
      scanned += 1;
      // Comments stripped first: P5's §52.3 found a rule that read prose
      // *about* a ban as a violation of it, which teaches the next author to
      // reword a comment rather than think about the rule.
      const source = withoutComments(readFileSync(join(directory, name), "utf-8"));
      expect(source).not.toContain("chalk");
      expect(source).not.toContain("commander");
      expect(source).not.toMatch(/\bconsole\./);
    }
    // The scan has to have read something, or it proves nothing.
    expect(scanned).toBeGreaterThan(3);
  });
});

describe("the read tools", () => {
  it("list, get, search and neighborhood all answer over one scaffold", () => {
    const root = scaffold();
    const listed = wikiList({ scaffoldRoot: root });
    expect(listed.data.entities).toHaveLength(3);
    expect(listed.data.truncated).toBe(false);

    const got = wikiGet({ scaffoldRoot: root, id: ARCH, includeBody: true });
    expect(got.data.entity?.title).toBe("System architecture");
    expect(got.data.body).toContain("Three services");

    const found = wikiSearch({ scaffoldRoot: root, text: "gateway" });
    expect(found.data.hits.length).toBeGreaterThan(0);

    const near = wikiNeighborhood({ scaffoldRoot: root, id: ARCH });
    expect(near.data?.relations.map((edge) => edge.targetId)).toContain(GATEWAY);
  });

  it("omits the body unless it is asked for, because §16 bounds the answer", () => {
    const root = scaffold();
    expect(wikiGet({ scaffoldRoot: root, id: ARCH }).data.body).toBeNull();
  });

  it("gives backlinks as §7.2's flat list, without paying for a traversal", () => {
    const root = scaffold();
    const back = wikiBacklinks({ scaffoldRoot: root, id: GATEWAY });
    // A backlink names the entity at the *other* end — the one pointing here.
    expect(back.data.backlinks.map((edge) => edge.targetId)).toEqual([ARCH]);
    expect(back.data.backlinks[0]?.type).toBe("depends_on");
  });

  it("applies the §15.1 filters the same way wherever they apply", () => {
    const root = scaffold();
    expect(wikiList({ scaffoldRoot: root, type: "component" }).data.entities).toHaveLength(1);
    expect(wikiList({ scaffoldRoot: root, topicId: TOPIC }).data.entities.map((e) => e.id)).toEqual([ARCH]);
    expect(wikiList({ scaffoldRoot: root, status: "archived" }).data.entities).toHaveLength(0);
    expect(wikiList({ scaffoldRoot: root, status: "promoted" }).data.entities).toHaveLength(3);
  });

  it("clamps a limit rather than honouring it, so no caller can ask for the whole wiki", () => {
    const root = scaffold();
    const listed = wikiList({ scaffoldRoot: root, limit: 1_000_000 });
    expect(listed.data.limit).toBeLessThanOrEqual(500);
  });

  it("reports grounding status as null where nothing looked, never as unverified", () => {
    const root = scaffold();
    const status = wikiGroundingStatus({ scaffoldRoot: root, id: ARCH });
    expect(status.data.entities[0]?.health).toBeNull();
    // Null and "unverified" are different facts: one means no resolver ran.
    expect(status.data.entities[0]?.health).not.toBe("unverified");
    expect(status.data.entities[0]?.groundingCount).toBe(0);
  });
});

describe("wiki graph", () => {
  it("returns nodes and edges under the same bounds as every other command", () => {
    const root = scaffold();
    const graph = wikiGraph({ scaffoldRoot: root });
    expect(graph.data.nodes).toHaveLength(3);
    expect(graph.data.edges).toEqual([{ from: ARCH, type: "depends_on", to: GATEWAY, resolved: true }]);
    expect(graph.data.truncated).toBe(false);
  });

  it("says so when the answer is a sample rather than the whole graph", () => {
    const root = scaffold();
    const graph = wikiGraph({ scaffoldRoot: root, limit: 1 });
    expect(graph.data.nodes).toHaveLength(1);
    // Either the node list was cut, or an edge leaves the slice. Both make the
    // answer a sample, and the caller is told rather than left to assume.
    expect(graph.data.truncated).toBe(true);
  });

  it("is deterministic in edge order", () => {
    const root = scaffold();
    expect(wikiGraph({ scaffoldRoot: root }).data.edges).toEqual(wikiGraph({ scaffoldRoot: root }).data.edges);
  });
});

describe("a read never rebuilds", () => {
  it("returns a typed diagnostic naming the fix, and creates nothing", () => {
    const root = scaffold(false);
    const listed = wikiList({ scaffoldRoot: root });
    expect(listed.data.entities).toEqual([]);
    expect(listed.diagnostics.map((entry) => entry.code)).toEqual(["WIKI_INDEX_MISSING"]);
    expect(listed.diagnostics[0]?.remediation).toContain("rebuild-index");
    expect(existsSync(join(root, "wiki.db"))).toBe(false);
    // And the envelope turns that into an exit a script can branch on.
    expect(exitCodeFor(envelopeFor(listed.data, listed.diagnostics))).toBe(WIKI_EXIT.index);
  });

  it("gives every read command the same answer to a missing index", () => {
    const root = scaffold(false);
    const results = [
      wikiList({ scaffoldRoot: root }),
      wikiGet({ scaffoldRoot: root, id: ARCH }),
      wikiSearch({ scaffoldRoot: root, text: "gateway" }),
      wikiNeighborhood({ scaffoldRoot: root, id: ARCH }),
      wikiBacklinks({ scaffoldRoot: root, id: ARCH }),
      wikiGraph({ scaffoldRoot: root }),
      wikiGroundingStatus({ scaffoldRoot: root }),
    ];
    expect(results).toHaveLength(7);
    for (const result of results) {
      expect(result.diagnostics.map((entry) => entry.code)).toEqual(["WIKI_INDEX_MISSING"]);
    }
  });
});

describe("rebuild-index", () => {
  it("is the one command that builds one, and everything returns afterwards", () => {
    const root = scaffold(false);
    expect(wikiList({ scaffoldRoot: root }).data.entities).toEqual([]);

    const built = wikiRebuildIndex({ scaffoldRoot: root });
    expect(built.data.entityCount).toBe(3);
    expect(built.data.fileCount).toBe(1);

    expect(wikiList({ scaffoldRoot: root }).data.entities).toHaveLength(3);
    expect(wikiGet({ scaffoldRoot: root, id: ARCH }).data.entity?.id).toBe(ARCH);
  });

  it("brings everything back after the index is deleted — §5.2, demonstrated", () => {
    const root = scaffold();
    const before = wikiList({ scaffoldRoot: root }).data.entities;
    rmSync(join(root, "wiki.db"));
    expect(wikiList({ scaffoldRoot: root }).diagnostics[0]?.code).toBe("WIKI_INDEX_MISSING");
    wikiRebuildIndex({ scaffoldRoot: root });
    expect(wikiList({ scaffoldRoot: root }).data.entities).toEqual(before);
    expect(before.length).toBeGreaterThan(0);
  });
});

describe("mutation cannot bypass review", () => {
  /** A live envelope: the precondition is minted from the file as it is now. */
  function proposal(root: string, opId = "svc-1"): Record<string, unknown> {
    const current = wikiGet({ scaffoldRoot: root, id: GATEWAY }).data.entity;
    const located = locateEntity(GATEWAY, { scaffoldRoot: root });
    expect(located).not.toBeNull();
    expect(current?.revision).toBe(located?.entity.revision);
    return {
      opId,
      type: "set-property",
      actor: { kind: "agent", id: "service-tests" },
      timestamp: "2026-08-25T10:00:00.000Z",
      entityId: GATEWAY,
      baseRevision: located!.entity.revision,
      baseContentHash: located!.entity.location.entityContentHash,
      payload: { property: "status", value: "deprecated" },
    };
  }

  it("plans and writes nothing without explicit authority — asserted as a negative", () => {
    const root = scaffold();
    const before = readFileSync(join(root, "context/architecture.md"), "utf-8");

    const result = wikiApplyOperation(proposal(root), { scaffoldRoot: root });
    // It planned — so this is not passing because the proposal was rejected.
    expect(result.data.planned).toBe(true);
    expect(result.data.applied).toBe(false);

    // The assertions that matter: nothing moved, and nothing was journalled.
    expect(readFileSync(join(root, "context/architecture.md"), "utf-8")).toBe(before);
    expect(readAuditLog(root).entries).toHaveLength(0);
  });

  it("returns a diff a reviewer can read before anything is applied", () => {
    const root = scaffold();
    const planned = wikiPlanOperation(proposal(root), { scaffoldRoot: root });
    expect(planned.data.planned).toBe(true);
    expect(planned.data.diff).toContain("deprecated");
    expect(planned.data.files).toEqual(["context/architecture.md"]);
  });

  it("writes only when told to, and then says exactly what it changed", () => {
    const root = scaffold();
    const applied = wikiApplyOperation(proposal(root), { scaffoldRoot: root, apply: true });
    expect(applied.data.applied).toBe(true);
    expect(applied.data.changedFiles).toEqual(["context/architecture.md"]);
    expect(readFileSync(join(root, "context/architecture.md"), "utf-8")).toContain("status: deprecated");
    expect(readAuditLog(root).entries.length).toBeGreaterThan(0);
  });
});

describe("creation provenance through the ordinary Wiki service", () => {
  it("previews and applies exact recorded author/time/session, then preserves them on retry and update", () => {
    const root = scaffold(false);
    const path = "context/new-decision.md";
    const request = {
      opId: "service-created-provenance", type: "create-entry",
      actor: { kind: "agent", id: "explicit-agent", sessionId: "explicit-session" },
      timestamp: "2026-09-08T10:00:00.000Z",
      payload: { file: path, insertAt: { at: "end-of-file" }, type: "decision", title: "A documented choice", body: "The reason for this choice." },
    };
    const preview = wikiPlanOperation(request, { scaffoldRoot: root });
    expect(preview.data.planned, JSON.stringify(preview.diagnostics)).toBe(true);
    expect(existsSync(join(root, path))).toBe(false);
    const applied = wikiApplyOperation(request, {
      scaffoldRoot: root, apply: true,
      plan: preview.data.plan!, expectedPreviewRevision: preview.data.preview!.previewHash,
    });
    expect(applied.data.applied).toBe(true);
    expect(readFileSync(join(root, path), "utf8")).toBe(preview.data.proposedText[path]);
    const entity = locateEntity(applied.data.createdIds[0]!, { scaffoldRoot: root })!.entity;
    expect(entity.provenance).toEqual({
      createdBy: { kind: "agent", id: "explicit-agent" },
      createdAt: request.timestamp, agentSessionId: "explicit-session",
    });
    const retry = wikiApplyOperation(request, { scaffoldRoot: root, apply: true });
    expect(retry.data.replayed).toBe(true);
    expect(retry.data.createdIds).toEqual(applied.data.createdIds);
    const completedBytes = readFileSync(join(root, "events/operations.jsonl"), "utf8");
    const createdBytes = readFileSync(join(root, path), "utf8");
    for (const changed of [
      { ...request, payload: { ...request.payload, body: "Unapproved different content." } },
      { ...request, actor: { ...request.actor, id: "different-author" } },
      { ...request, timestamp: "2026-09-09T10:00:00.000Z" },
      { ...request, actor: { ...request.actor, sessionId: "different-session" } },
    ]) {
      const refused = wikiApplyOperation(changed, { scaffoldRoot: root, apply: true });
      expect(refused.data.applied).toBe(false);
      expect(refused.data.replayed).toBe(false);
      expect(refused.diagnostics.some((entry) => entry.code === "INVALID_OPERATION_ENVELOPE")).toBe(true);
    }
    expect(readFileSync(join(root, "events/operations.jsonl"), "utf8")).toBe(completedBytes);
    expect(readFileSync(join(root, path), "utf8")).toBe(createdBytes);
    expect(readAuditLog(root).entries.filter((entry) => entry.phase === "complete")).toHaveLength(1);
    const update = wikiApplyOperation({
      ...request, opId: "service-updated-provenance", type: "update-entry", entityId: entity.id,
      actor: { kind: "human", id: "explicit-editor" }, timestamp: "2026-09-08T11:00:00.000Z",
      baseRevision: entity.revision, baseContentHash: entity.location.entityContentHash,
      payload: { body: "The corrected reason for this choice." },
    }, { scaffoldRoot: root, apply: true });
    expect(update.data.applied).toBe(true);
    expect(locateEntity(entity.id, { scaffoldRoot: root })!.entity.provenance).toEqual(entity.provenance);
    expect(readAuditLog(root).entries.filter((entry) => entry.phase === "complete").at(-1)?.actor)
      .toEqual({ kind: "human", id: "explicit-editor" });
  });
});

describe("INDEX_REFRESH_REQUIRED", () => {
  it("is suppressed when the scaffold has no index at all", () => {
    const root = scaffold(false);
    const located = locateEntity(GATEWAY, { scaffoldRoot: root })!;
    const envelope: Record<string, unknown> = {
      opId: "svc-2",
      type: "set-property",
      actor: { kind: "agent", id: "service-tests" },
      timestamp: "2026-08-25T10:00:00.000Z",
      entityId: GATEWAY,
      baseRevision: located.entity.revision,
      baseContentHash: located.entity.location.entityContentHash,
      payload: { property: "status", value: "deprecated" },
    };
    const applied = wikiApplyOperation(envelope, { scaffoldRoot: root, apply: true });
    expect(applied.data.applied).toBe(true);
    // Handoff §54.8: every apply in the wild returns this today, and telling a
    // user to refresh a cache they have never had teaches them to ignore codes.
    expect(applied.diagnostics.map((entry) => entry.code)).not.toContain("INDEX_REFRESH_REQUIRED");
  });
});

describe("validate, through the service", () => {
  it("answers on a scaffold with no index and creates none", () => {
    const root = scaffold(false);
    const result = wikiValidate({ scaffoldRoot: root });
    expect(result.data.filesScanned).toBe(1);
    expect(result.data.entitiesChecked).toBe(3);
    expect(existsSync(join(root, "wiki.db"))).toBe(false);
  });

  it("reports how much it could actually check, in data rather than as a diagnostic", () => {
    const result = wikiValidate({ scaffoldRoot: scaffold(false) });
    expect(result.data.counts).toEqual({
      error: expect.any(Number),
      warning: expect.any(Number),
      info: expect.any(Number),
    });
  });
});

describe("wiki migrate, through the service", () => {
  it("dry-runs without writing and without minting an id", () => {
    const root = scaffold();
    const before = readFileSync(join(root, "context/architecture.md"), "utf-8");
    const result = wikiMigrate({ scaffoldRoot: root, dryRun: true });
    expect(result.data.dryRun).toBe(true);
    expect(result.data.report.idsGenerated).toEqual([]);
    expect(readFileSync(join(root, "context/architecture.md"), "utf-8")).toBe(before);
    expect(result.data.rendered).toContain("Migration dry run");
  });
});
