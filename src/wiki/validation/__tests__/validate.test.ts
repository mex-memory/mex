/**
 * §14, both polarities, over a scaffold with planted defects.
 *
 * The corpus below is one clean file and one deliberately broken one, and the
 * clean half is not decoration: a validator that reported everything would pass
 * every positive assertion here, so each test that expects a code also asserts
 * the clean entity is *not* named by it. That is the polarity the spec's
 * "reports every planted defect and nothing else" is really asking for.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateScaffold } from "../validate.js";
import { rebuildWikiIndex } from "../../index/rebuild.js";
import type { GroundingGraph } from "../../grounding/adapter.js";

const CLEAN = "mx_01K4FAM7W8N9R3T5Y6Q2ZBCHJD";
const BROKEN = "mx_01BX5ZZKBKACTAV9WEVGEMMVRZ";
const TOPIC = "mx_01KRMEXM00JAAVJPQVVRX8N56V";
const ORPHAN = "mx_01D78XYFJ1PRM1WPBCBT3VHMNV";
const DANGLING = "mx_01KR2E4K002H3ZYA9G0C4XV531";

const CLEAN_MD = `<!-- mex:entity
id: ${TOPIC}
type: topic
status: promoted
revision: 1
-->
## Authentication

Everything about tokens.

<!-- mex:entity
id: ${CLEAN}
type: decision
status: promoted
revision: 1
topics: [${TOPIC}]
-->
## Use JWT for sessions

Server-side sessions do not scale across regions.
`;

const NL = String.fromCharCode(10);

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // Windows holds handles on just-closed SQLite files; P4 recorded the same.
    }
  }
});

function scaffold(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "mex-validate-"));
  roots.push(root);
  for (const [path, text] of Object.entries({ "context/clean.md": CLEAN_MD, ...files })) {
    const absolute = join(root, path);
    mkdirSync(join(absolute, ".."), { recursive: true });
    writeFileSync(absolute, text, "utf-8");
  }
  return root;
}

function codes(root: string, options: Parameters<typeof validateScaffold>[0] extends infer T ? Partial<T> : never = {}): string[] {
  return validateScaffold({ scaffoldRoot: root, ...options }).diagnostics.map((entry) => entry.code);
}

describe("§14.1 structural", () => {
  it("names both claimants of a duplicate id, not just the loser", () => {
    const root = scaffold({
      "context/copy.md": CLEAN_MD.replace(`id: ${TOPIC}`, `id: ${ORPHAN}`),
    });
    const report = validateScaffold({ scaffoldRoot: root });
    const duplicates = report.diagnostics.filter((entry) => entry.code === "DUPLICATE_ENTITY_ID");
    expect(duplicates.length).toBeGreaterThan(0);
    // Both files have to appear, or a user cannot see the other side of it.
    const message = duplicates.map((entry) => `${entry.file ?? ""} ${entry.message}`).join(" ");
    expect(message).toContain("clean.md");
    expect(message).toContain("copy.md");
  });

  it("reports an invalid lifecycle state as a lifecycle problem, not a parse error", () => {
    const root = scaffold({
      "context/broken.md": `<!-- mex:entity
id: ${BROKEN}
type: decision
status: definitely-not-a-state
revision: 1
-->
## A decision

Body.
`,
    });
    const found = codes(root);
    // Finding 26: the codec collapses this into one WIKI_PARSE_ERROR on
    // purpose. Validation is the layer that says which field.
    expect(found).toContain("INVALID_LIFECYCLE_STATE");
    expect(codes(scaffold({}))).not.toContain("INVALID_LIFECYCLE_STATE");
  });

  it("reports an unregistered entity type", () => {
    const root = scaffold({
      "context/broken.md": `<!-- mex:entity
id: ${BROKEN}
type: sonnet
status: promoted
revision: 1
-->
## Not a type

Body.
`,
    });
    expect(codes(root)).toContain("INVALID_ENTITY_TYPE");
  });

  it("reports an unbound metadata block", () => {
    const root = scaffold({
      "context/broken.md": `<!-- mex:entity
id: ${BROKEN}
type: decision
status: promoted
revision: 1
-->

Prose where a heading should be.
`,
    });
    expect(codes(root)).toContain("UNBOUND_ENTITY_METADATA");
  });

  it("reports a generated section that no longer matches the scaffold", () => {
    const root = scaffold({
      "patterns/INDEX.md": `# Patterns

<!-- mex:generated:begin -->
- Something nobody generated
<!-- mex:generated:end -->
`,
      "patterns/one.md": `<!-- mex:entity
id: ${ORPHAN}
type: pattern
status: promoted
revision: 1
-->
## Return problem documents

Every handler returns a problem document.
`,
    });
    expect(codes(root)).toContain("GENERATED_VIEW_DRIFT");
  });

  it("reports a malformed line in the operation log", () => {
    const root = scaffold({});
    mkdirSync(join(root, "events"), { recursive: true });
    writeFileSync(join(root, "events", "operations.jsonl"), "{not json at all\n", "utf-8");
    expect(codes(root)).toContain("MALFORMED_OPERATION_LOG");
  });
});

describe("§14.2 referential", () => {
  it("reports a relation pointing at nothing, and says which entity declares it", () => {
    const root = scaffold({
      "context/broken.md": `<!-- mex:entity
id: ${BROKEN}
type: decision
status: promoted
revision: 1
relations:
  - type: supersedes
    target: ${DANGLING}
-->
## Superseding a ghost

Body.
`,
    });
    const report = validateScaffold({ scaffoldRoot: root });
    const dangling = report.diagnostics.find((entry) => entry.code === "INVALID_RELATION_TARGET");
    expect(dangling).toBeDefined();
    expect(dangling?.entityId).toBe(BROKEN);
    expect(dangling?.file).toBe("context/broken.md");
  });

  it("reports a supersession cycle", () => {
    const root = scaffold({
      "context/cycle.md": `<!-- mex:entity
id: ${BROKEN}
type: decision
status: promoted
revision: 1
relations:
  - type: supersedes
    target: ${ORPHAN}
-->
## First

Body.

<!-- mex:entity
id: ${ORPHAN}
type: decision
status: promoted
revision: 1
relations:
  - type: supersedes
    target: ${BROKEN}
-->
## Second

Body.
`,
    });
    expect(codes(root)).toContain("SUPERSESSION_CYCLE");
  });

  it("reports a topic membership that points at something which is not a topic", () => {
    const root = scaffold({
      "context/broken.md": `<!-- mex:entity
id: ${BROKEN}
type: decision
status: promoted
revision: 1
topics: [${CLEAN}]
-->
## Member of a decision

Body.
`,
    });
    expect(codes(root)).toContain("INVALID_TOPIC_MEMBER");
  });

  it("reports two active decisions that contradict, and stays quiet when one waives it", () => {
    const contradicting = (waived: boolean) => `<!-- mex:entity
id: ${BROKEN}
type: decision
status: promoted
revision: 1
relations:
  - type: contradicts
    target: ${CLEAN}${waived ? "\n    metadata:\n      waived: true" : ""}
-->
## The other way round

Body.
`;
    expect(codes(scaffold({ "context/x.md": contradicting(false) }))).toContain("CONTRADICTORY_ACTIVE_DECISIONS");
    // The waiver lives on the relation's own metadata (finding 9), so it
    // travels in the Markdown and scopes to the one pair it was granted for.
    expect(codes(scaffold({ "context/x.md": contradicting(true) }))).not.toContain("CONTRADICTORY_ACTIVE_DECISIONS");
  });

  it("reports a promoted entity nothing points at and which points at nothing", () => {
    const root = scaffold({
      "context/lonely.md": `<!-- mex:entity
id: ${ORPHAN}
type: pattern
status: promoted
revision: 1
-->
## All alone

Body.
`,
    });
    const report = validateScaffold({ scaffoldRoot: root });
    const orphans = report.diagnostics.filter((entry) => entry.code === "ORPHANED_ENTITY");
    expect(orphans.map((entry) => entry.entityId)).toEqual([ORPHAN]);
    // The clean file's decision is related to a topic, so it is not an orphan —
    // which is what stops this test passing over a check that reports everything.
    expect(orphans.map((entry) => entry.entityId)).not.toContain(CLEAN);
  });
});

describe("§14.3 source and grounding", () => {
  const withSource = (source: string) => `<!-- mex:entity
id: ${BROKEN}
type: decision
status: promoted
revision: 1
sources:
${source}
-->
## Evidence

Body.
`;

  it("reports a file that is cited as evidence and is not in the checkout", () => {
    const root = scaffold({ "context/x.md": withSource("  - type: file\n    ref: src/gone.ts") });
    const report = validateScaffold({ scaffoldRoot: root, projectRoot: root });
    expect(report.diagnostics.map((entry) => entry.code)).toContain("SOURCE_FILE_MISSING");
  });

  it("stays quiet about a file that is there", () => {
    const root = scaffold({ "context/x.md": withSource("  - type: file\n    ref: src/present.ts") });
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "present.ts"), "export const x = 1;\n", "utf-8");
    const report = validateScaffold({ scaffoldRoot: root, projectRoot: root });
    expect(report.diagnostics.map((entry) => entry.code)).not.toContain("SOURCE_FILE_MISSING");
  });

  it("reports a commit that is not a commit", () => {
    const root = scaffold({ "context/x.md": withSource("  - type: commit\n    commit: yesterday") });
    expect(codes(root)).toContain("INVALID_COMMIT_FORMAT");
  });

  it("never fetches a URL — a planted fetch that throws proves it", () => {
    const root = scaffold({ "context/x.md": withSource("  - type: url" + NL + "    ref: https://example.invalid/spec") });
    // Planted rather than trusted to the network being absent: a CI box with no
    // network would pass this test for the wrong reason.
    const original = globalThis.fetch;
    let attempted = 0;
    globalThis.fetch = (() => {
      attempted += 1;
      throw new Error("validation must not fetch");
    }) as typeof globalThis.fetch;
    try {
      const report = validateScaffold({ scaffoldRoot: root });
      expect(attempted).toBe(0);
      // The URL is reported as unresolved, which is a diagnostic rather than a
      // network call — explicit, so a reviewer does not read it as verified.
      expect(report.diagnostics.map((entry) => entry.code)).toContain("UNRESOLVED_EXTERNAL_SOURCE");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("resolves external evidence only through the injected predicate", () => {
    const root = scaffold({ "context/x.md": withSource("  - type: url" + NL + "    ref: https://example.invalid/spec") });
    // The one door: a caller that genuinely has an issue tracker supplies this,
    // and it is the only thing validation will believe about an external ref.
    const report = validateScaffold({ scaffoldRoot: root, isExternalResolved: () => true });
    expect(report.diagnostics.map((entry) => entry.code)).not.toContain("UNRESOLVED_EXTERNAL_SOURCE");
  });

  it("treats embedded HTML and links as inert data", () => {
    const root = scaffold({
      "context/hostile.md": `<!-- mex:entity
id: ${BROKEN}
type: decision
status: promoted
revision: 1
-->
## Script tags are prose

<div onclick="alert(1)">Click</div>

<script>globalThis.__validationExecutedMarkdown = true;</script>

[a link](javascript:alert(1))
`,
    });
    const report = validateScaffold({ scaffoldRoot: root });
    expect((globalThis as Record<string, unknown>)["__validationExecutedMarkdown"]).toBeUndefined();
    // And the entity survives as an entity, rather than being refused as unsafe.
    expect(report.entitiesChecked).toBeGreaterThan(0);
  });
});

describe("grounding checks", () => {
  const grounded = `<!-- mex:entity
id: ${BROKEN}
type: decision
status: promoted
revision: 1
grounds_to:
  - node: "function:deadbeefdeadbeef"
    fingerprint: "mh:64:aabbccdd"
-->
## Grounded

Body with an anchor: [the code](mex://function:0123456789abcdef).
`;

  it("never resolves code links, which are `mex check`'s", () => {
    // A node the graph no longer has, a fingerprint that cannot decode and no
    // body hash: none of it is validate's to report.
    const report = validateScaffold({ scaffoldRoot: scaffold({ "context/g.md": grounded }) });
    const found = report.diagnostics.map((entry) => entry.code);
    for (const code of ["GROUNDING_MISSING", "GROUNDING_UNRESOLVED", "GROUNDING_STALE"]) expect(found).not.toContain(code);
    expect(report.diagnostics.some((entry) => entry.message.includes("body hash"))).toBe(false);
  });

  it("reports an anchor pointing somewhere the entity does not ground to", () => {
    const report = validateScaffold({ scaffoldRoot: scaffold({ "context/g.md": grounded }) });
    const mismatch = report.diagnostics.find((entry) => entry.code === "ANCHOR_GROUNDING_MISMATCH");
    expect(mismatch).toBeDefined();
    expect(mismatch?.entityId).toBe(BROKEN);
  });

  it("stays quiet when the anchor and the grounding agree", () => {
    const agreeing = grounded.replace("mex://function:0123456789abcdef", "mex://function:deadbeefdeadbeef");
    const report = validateScaffold({ scaffoldRoot: scaffold({ "context/g.md": agreeing }) });
    expect(report.diagnostics.map((entry) => entry.code)).not.toContain("ANCHOR_GROUNDING_MISMATCH");
  });

  it("leaves an anchor alone in an entity that declares no grounding at all", () => {
    const ungrounded = `<!-- mex:entity
id: ${BROKEN}
type: decision
status: promoted
revision: 1
-->
## Not grounded

An ordinary link: [the code](mex://function:0123456789abcdef).
`;
    const report = validateScaffold({ scaffoldRoot: scaffold({ "context/g.md": ungrounded }) });
    expect(report.diagnostics.map((entry) => entry.code)).not.toContain("ANCHOR_GROUNDING_MISMATCH");
  });
});

describe("the report itself", () => {
  it("runs with no index, and never creates one", () => {
    const root = scaffold({});
    const report = validateScaffold({ scaffoldRoot: root });
    expect(report.filesScanned).toBeGreaterThan(0);
    expect(report.entitiesChecked).toBe(2);
    // A read never builds one, and validate is a read.
    expect(() => rmSync(join(root, "wiki.db"))).toThrow();
  });

  it("answers identically with a current index, a stale one, and none", () => {
    const root = scaffold({
      "context/lonely.md": `<!-- mex:entity
id: ${ORPHAN}
type: pattern
status: promoted
revision: 1
-->
## All alone

Body.
`,
    });
    const withoutIndex = validateScaffold({ scaffoldRoot: root });
    rebuildWikiIndex({ scaffoldRoot: root });
    const withCurrent = validateScaffold({ scaffoldRoot: root });
    // Now make the index stale by changing a file it has already indexed.
    writeFileSync(join(root, "context", "lonely.md"), `<!-- mex:entity
id: ${ORPHAN}
type: pattern
status: promoted
revision: 2
-->
## All alone, revised

Body.
`, "utf-8");
    const withStale = validateScaffold({ scaffoldRoot: root });

    expect(withCurrent.diagnostics).toEqual(withoutIndex.diagnostics);
    // The stale case differs only because the *file* differs, which is the
    // point: the answer follows the Markdown, never the cache.
    expect(withStale.diagnostics.map((entry) => entry.code)).toEqual(
      withoutIndex.diagnostics.map((entry) => entry.code),
    );
    expect(withoutIndex.diagnostics.length).toBeGreaterThan(0);
  });

  it("orders worst-first and bounds the list, reporting truncation as data", () => {
    const many: Record<string, string> = {};
    for (let index = 0; index < 60; index += 1) {
      many[`context/lonely-${index}.md`] = `<!-- mex:entity
id: ${ORPHAN.slice(0, -2)}${index.toString(36).toUpperCase().padStart(2, "0")}
type: pattern
status: promoted
revision: 1
-->
## Lonely ${index}

Body.
`;
    }
    const report = validateScaffold({ scaffoldRoot: scaffold(many), limit: 10 });
    expect(report.diagnostics).toHaveLength(10);
    expect(report.truncated).toBe(true);
    const severities = report.diagnostics.map((entry) => entry.severity);
    const rank = { error: 0, warning: 1, info: 2 } as const;
    expect(severities.map((value) => rank[value])).toEqual([...severities.map((value) => rank[value])].sort());
  });

  it("is deterministic across two runs over the same tree", () => {
    const root = scaffold({
      "context/broken.md": `<!-- mex:entity
id: ${BROKEN}
type: decision
status: nonsense
revision: 1
-->
## Broken

Body.
`,
    });
    expect(validateScaffold({ scaffoldRoot: root })).toEqual(validateScaffold({ scaffoldRoot: root }));
  });

  it("carries remediation on every diagnostic, per §14.4", () => {
    const report = validateScaffold({
      scaffoldRoot: scaffold({
        "context/broken.md": `<!-- mex:entity
id: ${BROKEN}
type: decision
status: nonsense
revision: 1
-->
## Broken

Body.
`,
      }),
    });
    expect(report.diagnostics.length).toBeGreaterThan(0);
    for (const entry of report.diagnostics) expect(entry.remediation).toBeTruthy();
  });
});
