import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { createFingerprint, serializeFingerprint } from "../fingerprint.js";
import { refreshGroundingBaselines, type GroundingRuntime } from "../runtime.js";
import { wikiGroundingDocumentReader } from "../../wiki/grounding/document-reader.js";
it("retains exact bounded failure details for authored entries and links", () => {
  const root = mkdtempSync(join(tmpdir(), "grounding-detail-"));
  mkdirSync(join(root, ".mex"));
  const file = join(root, ".mex/test.md");
  writeFileSync(file, '---\ngrounds_to:\n  - node: function:wrong\n    fingerprint: pending\n---\n[link](mex://function:missing)\n');
  const runtime = { graph: { getNode: () => null }, reconciler: { getFingerprint: () => null }, fingerprints: { getGroundedSource: () => null } } as unknown as GroundingRuntime;
  try {
    expect(refreshGroundingBaselines({ projectRoot: root, scaffoldRoot: join(root, ".mex"), aiTools: [] }, [file], runtime)).toMatchObject({ captured: 0, skipped: 2, failures: [
      { file: ".mex/test.md", entity: null, node: "function:wrong", reason: "Node is unavailable or has no verifiable body." },
      { file: ".mex/test.md", entity: null, node: "function:missing", reason: "Node is unavailable or has no verifiable body." },
    ] });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Classification: recorded knowledge whose code changed is drift; a reference
// nothing vouches for is new. Decided from recorded state, never from the reason text.
const run = (cwd: string, ...args: string[]) => {
  const out = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, encoding: "utf8" });
  expect(out.status, out.stderr).toBe(0);
};
const fp = (...tokens: string[]) => serializeFingerprint(createFingerprint(tokens.length ? tokens : ["a", "b", "c"]));
interface Fixture { root: string; file: string; scaffold: string }
function fixture(content: string, options: { committed?: string } = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), "grounding-kind-"));
  mkdirSync(join(root, ".mex"));
  const file = join(root, ".mex/test.md");
  run(root, "init", "-q");
  if (options.committed !== undefined) {
    writeFileSync(file, options.committed);
    run(root, "add", "-A");
    run(root, "commit", "-q", "-m", "x");
  }
  writeFileSync(file, content);
  return { root, file, scaffold: join(root, ".mex") };
}
/** `existing` ids resolve to a node whose current body hash is "now"; every other id is unknown. */
function runtimeWith(existing: string[], cached: Record<string, boolean> = {}): GroundingRuntime {
  return {
    graph: { getNode: (id: string) => existing.includes(id) ? { id, bodyHash: "now" } : null },
    reconciler: { getFingerprint: (id: string) => existing.includes(id) ? createFingerprint(["current", "body", "tokens", "here", "now"]) : null },
    fingerprints: { getBaseline: (_subject: unknown, id: string) => cached[id] ? { bodyHash: "old" } : null, getGroundedSource: (_file: string, id: string) => cached[id] ? { bodyHash: "old", fingerprint: fp("old"), source: "", nodeId: id } : null },
  } as unknown as GroundingRuntime;
}
const capture = (f: Fixture, runtime: GroundingRuntime) =>
  refreshGroundingBaselines({ projectRoot: f.root, scaffoldRoot: f.scaffold, aiTools: [] }, [f.file], runtime,
    { documentReader: wikiGroundingDocumentReader });
const kinds = (result: ReturnType<typeof capture>) => Object.fromEntries((result.failures ?? []).map(entry => [entry.node, entry.kind]));
const entry = (node: string, extra = "") => `- node: ${node}\n  fingerprint: ${fp("a")}\n${extra}`;
const indent = (text: string, pad: string) => text.split("\n").map(line => line ? pad + line : line).join("\n");
const document = (store: "root" | "mex", entries: string[]) => store === "root"
  ? `---\ngrounds_to:\n${indent(entries.join(""), "  ")}---\nbody\n`
  : `---\nmex:\n  id: e1\n  grounds_to:\n${indent(entries.join(""), "    ")}---\nbody\n`;

for (const store of ["root", "mex"] as const) {
  it(`classifies ${store} grounds_to by recorded state when the node is unavailable`, () => {
    const f = fixture(document(store, [
      entry("new-bare"),
      entry("rec-body", "  bodyHash: old\n"),
      entry("rec-code", "  codeHash: ch1:abc\n"),
      entry("rec-cache"),
    ]));
    try {
      const result = capture(f, runtimeWith([], { "rec-cache": true }));
      expect(kinds(result)).toEqual({ "new-bare": "new", "rec-body": "drift", "rec-code": "drift", "rec-cache": "drift" });
      expect(result.skipped).toBe(4);
      expect(result.driftCount).toBe(3);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it(`classifies ${store} grounds_to when the fingerprint or body differs`, () => {
    const f = fixture(document(store, [entry("changed", "  bodyHash: old\n"), entry("authored-wrong")]));
    try {
      const result = capture(f, runtimeWith(["changed", "authored-wrong"]));
      expect(kinds(result)).toEqual({ changed: "drift", "authored-wrong": "new" });
      expect(result.failures!.find(failure => failure.node === "changed")!.reason).toMatch(/differs/);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
}

it("classifies inline anchors: a cached baseline is drift, an unknown anchor is new", () => {
  const f = fixture("[a](mex://anchor-cached) [b](mex://anchor-new)\n");
  try {
    expect(kinds(capture(f, runtimeWith([], { "anchor-cached": true })))).toEqual({ "anchor-cached": "drift", "anchor-new": "new" });
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

it("treats a reference already in the committed file as drift and one added since as new", () => {
  const committed = `---\ngrounds_to:\n  - node: old-ref\n    fingerprint: ${fp("a")}\n---\n[kept](mex://old-anchor)\n`;
  const now = `---\ngrounds_to:\n  - node: old-ref\n    fingerprint: ${fp("a")}\n  - node: added-ref\n    fingerprint: ${fp("a")}\n---\n[kept](mex://old-anchor) [fresh](mex://added-anchor)\n`;
  const f = fixture(now, { committed });
  try {
    expect(kinds(capture(f, runtimeWith([])))).toEqual({
      "old-ref": "drift", "old-anchor": "drift", "added-ref": "new", "added-anchor": "new",
    });
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

it("treats an uncommitted file, or a committed file without the reference, as having nothing recorded", () => {
  const never = fixture("[x](mex://never)\n");
  try { expect(kinds(capture(never, runtimeWith([])))).toEqual({ never: "new" }); }
  finally { rmSync(never.root, { recursive: true, force: true }); }
  const other = fixture("[x](mex://other)\n", { committed: "unrelated\n" });
  try { expect(kinds(capture(other, runtimeWith([])))).toEqual({ other: "new" }); }
  finally { rmSync(other.root, { recursive: true, force: true }); }
});

it("fails safe to drift when Git cannot answer", () => {
  const f = fixture("[x](mex://unknown)\n");
  // No Git executable: "nothing was committed" cannot be told from "cannot tell".
  const key = Object.keys(process.env).find(name => name.toUpperCase() === "PATH")!;
  const path = process.env[key];
  process.env[key] = f.scaffold;
  try { expect(kinds(capture(f, runtimeWith([])))).toEqual({ unknown: "drift" }); }
  finally { process.env[key] = path; rmSync(f.root, { recursive: true, force: true }); }
});

it("keeps drift and new failures under separate bounds", () => {
  const drifted = Array.from({ length: 1030 }, (_, i) => entry(`d${i}`, "  bodyHash: old\n"));
  const f = fixture(document("root", [...drifted, entry("only-new")]));
  try {
    const result = capture(f, runtimeWith([]));
    expect(result.driftCount).toBe(1030);
    expect(result.skipped).toBe(1031);
    expect(result.failures!.filter(failure => failure.kind === "drift")).toHaveLength(1024);
    expect(result.failures!.filter(failure => failure.kind === "new").map(failure => failure.node)).toEqual(["only-new"]);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

// Block-level Wiki entities keep groundings in their own metadata comment.
const N = Object.fromEntries(["ghost_new", "ghost_recorded", "ghost_cached", "was_there", "added_now"]
  .map((name, i) => [name, `function:${String(i + 1).repeat(32)}`])) as Record<string, string>;
const block = (id: string, node: string, extra = "") => `<!-- mex:entity
id: ${id}
type: fact
status: promoted
revision: 1
provenance:
  createdBy:
    kind: agent
    id: hand
  createdAt: 2026-10-23T08:31:11.456Z
grounds_to:
  - node: ${node}
    fingerprint: ${fp("a")}
${extra}-->
## Title ${id}

Prose of ${id}.
`;
it("verifies block-entity groundings: recorded ones are drift, hand-written unknown ones are new", () => {
  const f = fixture("# Doc\n\n" + [
    block("mx_01AAAAAAAAAAAAAAAAAAAAAAAA", N.ghost_new!),
    block("mx_01BBBBBBBBBBBBBBBBBBBBBBBB", N.ghost_recorded!, "    bodyHash: old\n"),
    block("mx_01CCCCCCCCCCCCCCCCCCCCCCCC", N.ghost_cached!),
  ].join("\n"));
  try {
    const result = capture(f, runtimeWith([], { [N.ghost_cached!]: true }));
    expect(kinds(result)).toEqual({ [N.ghost_new!]: "new", [N.ghost_recorded!]: "drift", [N.ghost_cached!]: "drift" });
    expect(result.failures!.map(entry => entry.entity).sort()).toEqual(["mx_01AAAAAAAAAAAAAAAAAAAAAAAA", "mx_01BBBBBBBBBBBBBBBBBBBBBBBB", "mx_01CCCCCCCCCCCCCCCCCCCCCCCC"]);
    expect(result.driftCount).toBe(2);
    expect(result.skipped).toBe(3);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

it("treats a block grounding already in the committed file as drift", () => {
  const text = "# Doc\n\n" + block("mx_01AAAAAAAAAAAAAAAAAAAAAAAA", N.was_there!);
  const f = fixture(text + "\n" + block("mx_01BBBBBBBBBBBBBBBBBBBBBBBB", N.added_now!), { committed: text });
  try { expect(kinds(capture(f, runtimeWith([])))).toEqual({ [N.was_there!]: "drift", [N.added_now!]: "new" }); }
  finally { rmSync(f.root, { recursive: true, force: true }); }
});
