/**
 * #226 — a file that keeps groundings both at the root and under `mex:`.
 *
 * Setup produced this shape itself: population wrote root `grounds_to`, then
 * migration gave multi-entity files a `mex:` map without moving them. On a
 * setup-populated Hono scaffold `mex check` then skipped 4 of 24 groundings and
 * `wiki for-code` returned 11 of 24. These tests pin the four halves of the
 * fix: the union read, the consolidating write, the file-level Wiki attachment,
 * and a setup path that no longer produces the shape.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import type { Grounding, MexConfig } from "../src/types.js";
import { extractGroundings, writeGroundings } from "../src/markdown.js";
import { runDriftCheckWithGraphStatus } from "../src/drift/index.js";
import { createGraphEngine } from "../src/graph/engine-impl.js";
import { loadGroundingRuntime } from "../src/graph/runtime.js";
import { serializeFingerprint } from "../src/graph/fingerprint.js";
import { rebuildWikiIndex } from "../src/wiki/index/rebuild.js";
import { knowledgeRecordsFor } from "../src/wiki/cli/for-code.js";
import { migrateScaffold } from "../src/wiki/migration/migrate.js";
import { validateScaffold } from "../src/wiki/validation/validate.js";
import { parseWikiMarkdown } from "../src/wiki/markdown/codec.js";
import { finalizeCodeRepoSetup } from "../src/setup/index.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const NODE_A = "function:1c9d4b7e2f5a8036c4e1b9d7a2f60358";
const NODE_B = "function:a3f8c21d9e4b7f60a1c2d3e4f5061728";
const A: Grounding = { node: NODE_A, fingerprint: "mh:64:4b1c7e29", bodyHash: "a".repeat(64) };
const B: Grounding = { node: NODE_B, fingerprint: "mh:64:9f2a4c6e", bodyHash: "b".repeat(64) };

const ARCH_ID = "mx_01KR2E4K002H3ZYA9G0C4XV531";
const INGEST_ID = "mx_01KR2E4K002H3ZYA9G0C4XV532";
const ROUTING_ID = "mx_01KR2E4K002H3ZYA9G0C4XV533";
const CONV_ID = "mx_01KR2E4K002H3ZYA9G0C4XV534";
const ERRORS_ID = "mx_01KR2E4K002H3ZYA9G0C4XV535";
const PATTERN_ID = "mx_01KR2E4K002H3ZYA9G0C4XV536";

function yamlList(key: string, groundings: readonly Grounding[], indent = ""): string {
  if (groundings.length === 0) return `${indent}${key}: []\n`;
  return `${indent}${key}:\n` + groundings.map((entry) =>
    `${indent}  - node: ${entry.node}\n${indent}    fingerprint: ${entry.fingerprint}\n` +
    (entry.bodyHash === undefined ? "" : `${indent}    bodyHash: ${entry.bodyHash}\n`)).join("");
}

/** Hono's `architecture.md` shape: root groundings, then a `mex:` map added by migration. */
function mixedDoc(root: readonly Grounding[], mex: readonly Grounding[] | null, id = ARCH_ID): string {
  return "---\nname: architecture\n# authored comment, kept byte for byte\ndescription: \"How it fits\"\n" +
    yamlList("grounds_to", root) +
    "last_updated: 2026-09-21\n" +
    `mex:\n  id: ${id}\n  type: architecture\n  status: promoted\n  revision: 2\n` +
    (mex === null ? "" : yamlList("grounds_to", mex, "  ")) +
    "---\n\n# Architecture\n\nBody prose.\n";
}

const SECTION_PROSE =
  "Prose enough to clear the threshold, over several lines of it here.\n" +
  "A second line of prose that carries several more words along with it.\n" +
  "And a third line of prose to be certain the bar is cleared.\n";

describe("extractGroundings reads both stores (#226)", () => {
  it("reads a root-only file", () => {
    const text = `---\nname: x\n${yamlList("grounds_to", [A, B])}---\n\n# X\n`;
    expect(extractGroundings(text).map((entry) => entry.node)).toEqual([NODE_A, NODE_B]);
  });

  it("reads a mex-only file", () => {
    expect(extractGroundings(mixedDoc([], [A])).map((entry) => entry.node)).toEqual([NODE_A]);
  });

  it("reads the union of a mixed file, mex entries first", () => {
    expect(extractGroundings(mixedDoc([B], [A])).map((entry) => entry.node)).toEqual([NODE_A, NODE_B]);
    // Hono's own shape: root groundings beside a `mex:` map that has none.
    expect(extractGroundings(mixedDoc([A, B], null)).map((entry) => entry.node)).toEqual([NODE_A, NODE_B]);
  });

  it("deduplicates a node both stores carry identically", () => {
    expect(extractGroundings(mixedDoc([A, B], [A]))).toEqual([A, B]);
  });

  it("returns the mex entry for a node the two stores ground differently", () => {
    const stale = { ...A, bodyHash: "c".repeat(64) };
    expect(extractGroundings(mixedDoc([stale, B], [A]))).toEqual([A, B]);
  });

  it("keeps one store's entries when the other is malformed", () => {
    const text = mixedDoc([], [A]).replace("grounds_to: []\n", "grounds_to:\n  - node: 42\n");
    expect(extractGroundings(text)).toEqual([A]);
  });
});

describe("writeGroundings consolidates a mixed file (#226)", () => {
  it("moves root entries under mex.grounds_to, removes the root key, and touches nothing else", () => {
    const before = mixedDoc([A, B], null);
    const after = writeGroundings(before, extractGroundings(before));

    const frontmatter = YAML.parse(after.split("---\n")[1]!) as Record<string, unknown>;
    expect(frontmatter["grounds_to"]).toBeUndefined();
    expect((frontmatter["mex"] as Record<string, unknown>)["grounds_to"]).toEqual([A, B]);
    expect(extractGroundings(after)).toEqual([A, B]);

    // Everything outside the two keys is byte-identical.
    const strip = (text: string) => text
      .replace(/^grounds_to:\n(?: {2}.*\n)*/m, "")
      .replace(/^ {2}grounds_to:\n(?: {4}.*\n)*/m, "");
    expect(strip(after)).toBe(strip(before));
    expect(after).toContain("# authored comment, kept byte for byte\n");

    // A second write of the same set is a no-op.
    expect(writeGroundings(after, extractGroundings(after))).toBe(after);
  });

  it("merges into an existing mex.grounds_to and drops an identical root duplicate", () => {
    const before = mixedDoc([A, B], [A]);
    const after = writeGroundings(before, extractGroundings(before));
    expect(after).not.toMatch(/^grounds_to:/m);
    expect((after.match(/grounds_to:/g) ?? []).length).toBe(1);
    expect(extractGroundings(after)).toEqual([A, B]);
  });

  it("removes an empty root list beside a mex map", () => {
    const before = mixedDoc([], [A]);
    const after = writeGroundings(before, [A]);
    expect(after).not.toMatch(/^grounds_to:/m);
    expect(after.replace(/^grounds_to: \[\]\n/m, "")).toBe(before.replace(/^grounds_to: \[\]\n/m, ""));
  });

  it("keeps a conflicting root entry at the root, and moves the rest", () => {
    const stale = { ...A, bodyHash: "c".repeat(64) };
    const before = mixedDoc([stale, B], [A]);
    const after = writeGroundings(before, extractGroundings(before));
    const frontmatter = YAML.parse(after.split("---\n")[1]!) as Record<string, unknown>;
    expect(frontmatter["grounds_to"]).toEqual([stale]);
    expect((frontmatter["mex"] as Record<string, unknown>)["grounds_to"]).toEqual([A, B]);
    expect(writeGroundings(after, extractGroundings(after))).toBe(after);
  });

  it("consolidates a CRLF file whose root key is the last frontmatter key", () => {
    const before = ("---\nname: x\nmex:\n  id: " + ARCH_ID + "\n  type: pattern\n  status: promoted\n" +
      yamlList("grounds_to", [A]) + "---\n\n# X\n").replace(/\n/g, "\r\n");
    const after = writeGroundings(before, extractGroundings(before));
    expect(after).not.toMatch(/^grounds_to:/m);
    expect(after).not.toMatch(/(?<!\r)\n/);
    expect(extractGroundings(after)).toEqual([A]);
    expect(after.endsWith("---\r\n\r\n# X\r\n")).toBe(true);
  });
});

describe("the Wiki attaches root groundings to the file-level entity only (#226)", () => {
  const multi = (rootGroundings: readonly Grounding[]) =>
    "---\nname: architecture\n" + yamlList("grounds_to", rootGroundings) +
    `mex:\n  id: ${ARCH_ID}\n  type: architecture\n  status: promoted\n  revision: 1\n---\n\n# Architecture\n\nIntro.\n\n` +
    `<!-- mex:entity\nid: ${INGEST_ID}\ntype: component\nstatus: promoted\nrevision: 1\n-->\n## Ingest\n\n${SECTION_PROSE}\n` +
    `<!-- mex:entity\nid: ${ROUTING_ID}\ntype: component\nstatus: promoted\nrevision: 1\n-->\n## Routing\n\n${SECTION_PROSE}`;

  it("gives the file-level entity the root groundings and every section none", () => {
    const parsed = parseWikiMarkdown({ path: "context/architecture.md", text: multi([A, B]) });
    const byId = new Map(parsed.entities.map((entry) => [entry.entity.id as string, entry.entity]));
    expect(byId.get(ARCH_ID)!.groundsTo.map((entry) => entry.node)).toEqual([NODE_A, NODE_B]);
    expect(byId.get(INGEST_ID)!.groundsTo).toEqual([]);
    expect(byId.get(ROUTING_ID)!.groundsTo).toEqual([]);
    expect(parsed.diagnostics.map((entry) => [entry.code, entry.severity])).toEqual([["GROUNDING_MIXED_SHAPE", "info"]]);
  });

  it("warns on a same-node conflict and keeps the mex entry", () => {
    const stale = { ...A, bodyHash: "c".repeat(64) };
    const text = multi([stale]).replace("  revision: 1\n---", "  revision: 1\n" + yamlList("grounds_to", [A], "  ") + "---");
    const parsed = parseWikiMarkdown({ path: "context/architecture.md", text });
    const fileLevel = parsed.entities.find((entry) => entry.entity.id === ARCH_ID)!;
    expect(fileLevel.entity.groundsTo).toEqual([A]);
    expect(parsed.diagnostics.map((entry) => [entry.code, entry.severity])).toEqual([["GROUNDING_MIXED_SHAPE", "warning"]]);
  });

  it("never attaches a root grounding in a file with only section entities", () => {
    const text = "---\nname: risks\n" + yamlList("grounds_to", [A]) + "---\n\n# Risks\n\n" +
      `<!-- mex:entity\nid: ${INGEST_ID}\ntype: risk\nstatus: promoted\nrevision: 1\n-->\n## One\n\n${SECTION_PROSE}`;
    const parsed = parseWikiMarkdown({ path: "context/risks.md", text });
    expect(parsed.entities).toHaveLength(1);
    expect(parsed.entities[0]!.entity.groundsTo).toEqual([]);
    expect(parsed.legacy.groundsTo).toHaveLength(1);
  });

  it("drops a malformed root entry rather than the entity beside it", () => {
    const text = multi([A]).replace(`fingerprint: ${A.fingerprint}`, "fingerprint: not-a-fingerprint");
    const parsed = parseWikiMarkdown({ path: "context/architecture.md", text });
    expect(parsed.entities.map((entry) => entry.entity.id)).toContain(ARCH_ID);
    expect(parsed.entities.find((entry) => entry.entity.id === ARCH_ID)!.entity.groundsTo).toEqual([]);
  });
});

describe("wiki migrate folds root groundings into an adopted file-level entity (#226)", () => {
  function scaffold(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), "mex-226-migrate-"));
    roots.push(root);
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(root, path, ".."), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    return root;
  }

  it("moves them, leaves one store, validates clean of the shape, and a second run changes nothing", () => {
    const root = scaffold({ "context/architecture.md": mixedDoc([A, B], null) });
    expect(validateScaffold({ scaffoldRoot: root }).diagnostics.map((entry) => entry.code)).toContain("GROUNDING_MIXED_SHAPE");

    const report = migrateScaffold({ scaffoldRoot: root });
    expect(report.groundingsMoved).toBe(2);
    expect(report.groundingsAmbiguous).toBe(0);
    const after = readFileSync(join(root, "context", "architecture.md"), "utf-8");
    expect(after).not.toMatch(/^grounds_to:/m);
    expect((after.match(/grounds_to:/g) ?? []).length).toBe(1);
    expect(extractGroundings(after)).toEqual([A, B]);
    expect(after).toContain("# authored comment, kept byte for byte\n");
    expect(validateScaffold({ scaffoldRoot: root }).diagnostics.map((entry) => entry.code)).not.toContain("GROUNDING_MIXED_SHAPE");

    const again = migrateScaffold({ scaffoldRoot: root });
    expect(again.groundingsMoved).toBe(0);
    expect(readFileSync(join(root, "context", "architecture.md"), "utf-8")).toBe(after);
  });

  it("keeps a malformed root entry it could not move, rather than deleting it", () => {
    const bad = { node: NODE_B, fingerprint: "not-a-fingerprint" };
    const root = scaffold({ "context/architecture.md": mixedDoc([A, bad], null) });
    const report = migrateScaffold({ scaffoldRoot: root });
    expect(report.groundingsMoved).toBe(1);
    expect(report.diagnostics.filter((entry) => entry.code === "AMBIGUOUS_MIGRATION")).toHaveLength(1);
    const frontmatter = YAML.parse(readFileSync(join(root, "context", "architecture.md"), "utf-8").split("---\n")[1]!) as Record<string, unknown>;
    expect(frontmatter["grounds_to"]).toEqual([bad]);
    expect((frontmatter["mex"] as Record<string, unknown>)["grounds_to"]).toEqual([A]);
  });

  it("keeps a conflicting root entry and reports it", () => {
    const stale = { ...A, bodyHash: "c".repeat(64) };
    const root = scaffold({ "context/architecture.md": mixedDoc([stale, B], [A]) });
    const report = migrateScaffold({ scaffoldRoot: root });
    expect(report.groundingsMoved).toBe(1);
    expect(report.diagnostics.filter((entry) => entry.code === "AMBIGUOUS_MIGRATION")).toHaveLength(1);
    const frontmatter = YAML.parse(readFileSync(join(root, "context", "architecture.md"), "utf-8").split("---\n")[1]!) as Record<string, unknown>;
    expect(frontmatter["grounds_to"]).toEqual([stale]);
    expect((frontmatter["mex"] as Record<string, unknown>)["grounds_to"]).toEqual([A, B]);
  });
});

describe("check reports the split without a graph (#226)", () => {
  it("is info for a plain split and a warning for a same-node conflict", async () => {
    const root = mkdtempSync(join(tmpdir(), "mex-226-shape-"));
    roots.push(root);
    const scaffoldRoot = join(root, ".mex");
    mkdirSync(join(scaffoldRoot, "context"), { recursive: true });
    writeFileSync(join(scaffoldRoot, "ROUTER.md"), "# Router\n");
    writeFileSync(join(scaffoldRoot, "context", "architecture.md"), mixedDoc([B], [A]));
    writeFileSync(join(scaffoldRoot, "context", "conventions.md"),
      mixedDoc([{ ...A, bodyHash: "c".repeat(64) }], [A], CONV_ID).replace("name: architecture", "name: conventions"));
    writeFileSync(join(scaffoldRoot, "context", "stack.md"), mixedDoc([], [A], PATTERN_ID).replace("name: architecture", "name: stack"));

    const report = await runDriftCheckWithGraphStatus({ projectRoot: root, scaffoldRoot, aiTools: [] }, { graphWarning: () => {} });
    const shape = report.issues.filter((issue) => issue.code === "GROUNDING_MIXED_SHAPE");
    expect(shape.map((issue) => [issue.file, issue.severity]).sort()).toEqual([
      [".mex/context/architecture.md", "info"],
      [".mex/context/conventions.md", "warning"],
    ]);
    expect(shape.find((issue) => issue.severity === "warning")!.message).toContain(NODE_A);
  });
});

// -- Against a real graph -----------------------------------------------------

const APP = `export function compose(middleware: Array<(next: () => number) => number>): () => number {
  let index = -1;
  const dispatch = (i: number): number => {
    if (i <= index) throw new Error("next() called multiple times");
    index = i;
    const handler = middleware[i];
    return handler ? handler(() => dispatch(i + 1)) : 0;
  };
  return () => dispatch(0);
}

export function errorHandler(error: Error): { status: number; body: string } {
  // Unknown errors are reported as a generic 500.
  const status = error.name === "HTTPException" ? 400 : 500;
  return { status, body: status === 500 ? "Internal Server Error" : error.message };
}
`;

interface Project { root: string; config: MexConfig; scaffoldRoot: string }

function project(prefix: string): Project {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, ".mex", "context"), { recursive: true });
  mkdirSync(join(root, ".mex", "patterns"), { recursive: true });
  writeFileSync(join(root, ".mex", "ROUTER.md"), "# Router\n");
  writeFileSync(join(root, "src", "app.ts"), APP);
  const scaffoldRoot = join(root, ".mex");
  return { root, scaffoldRoot, config: { projectRoot: root, scaffoldRoot, aiTools: [] } };
}

async function buildGraph(root: string): Promise<void> {
  const engine = createGraphEngine({ rootDir: root });
  await engine.build();
  engine.close();
}

/** Graph-derived grounding for one symbol, as setup's population agent copies it. */
async function groundingFor(config: MexConfig, symbol: string, withBodyHash: boolean): Promise<Grounding> {
  const runtime = await loadGroundingRuntime(config);
  try {
    const node = runtime!.graph.searchNodes(symbol).find((entry) => entry.kind === "function" && entry.name === symbol)!;
    const fingerprint = serializeFingerprint(runtime!.reconciler.getFingerprint(node.id)!);
    return withBodyHash ? { node: node.id, fingerprint, bodyHash: node.bodyHash! } : { node: node.id, fingerprint };
  } finally {
    runtime!.close();
  }
}

const multiEntityDoc = (name: string, type: string, rootGroundings: readonly Grounding[], ids: readonly string[] | null) =>
  `---\nname: ${name}\ndescription: "${name}"\n` + yamlList("grounds_to", rootGroundings) + "last_updated: 2026-09-21\n" +
  (ids === null ? "" : `mex:\n  id: ${ids[0]}\n  type: ${type}\n  status: promoted\n  revision: 2\n`) +
  `---\n\n# ${name}\n\nIntro.\n\n` +
  (ids === null ? "" : `<!-- mex:entity\nid: ${ids[1]}\ntype: ${type === "architecture" ? "component" : type}\nstatus: promoted\nrevision: 1\n-->\n`) +
  `## First\n\n${SECTION_PROSE}\n` +
  (ids === null ? "" : `<!-- mex:entity\nid: ${ids[2]}\ntype: ${type === "architecture" ? "component" : type}\nstatus: promoted\nrevision: 1\n-->\n`) +
  `## Second\n\n${SECTION_PROSE}`;

/** The survey on a fixture: what `check` and `wiki for-code` each see. */
async function seen(p: Project, nodes: readonly string[]): Promise<{ forCode: string[] }> {
  rebuildWikiIndex({ scaffoldRoot: p.scaffoldRoot, indexPath: join(p.scaffoldRoot, "wiki.db") });
  const records = knowledgeRecordsFor(nodes, { scaffoldRoot: p.scaffoldRoot }, p.root);
  return { forCode: records.map((record) => record.id).sort() };
}

describe("a setup-shaped scaffold against a real graph (#226)", () => {
  it("check reports drift on root groundings in mixed files, as the issue's compose()/errorHandler scenario", async () => {
    const p = project("mex-226-check-");
    await buildGraph(p.root);
    const compose = await groundingFor(p.config, "compose", true);
    const errorHandler = await groundingFor(p.config, "errorHandler", true);

    // The pattern grounds compose() under mex.grounds_to; architecture.md and
    // conventions.md carry setup's root groundings beside their `mex:` maps.
    writeFileSync(join(p.scaffoldRoot, "patterns", "compose.md"),
      `---\nname: compose\nmex:\n  id: ${PATTERN_ID}\n  type: pattern\n  status: promoted\n  revision: 1\n` +
      yamlList("grounds_to", [compose], "  ") + "---\n\n# Compose\n\nHow middleware composes.\n");
    writeFileSync(join(p.scaffoldRoot, "context", "architecture.md"),
      multiEntityDoc("architecture", "architecture", [compose], [ARCH_ID, INGEST_ID, ROUTING_ID]));
    writeFileSync(join(p.scaffoldRoot, "context", "conventions.md"),
      multiEntityDoc("conventions", "convention", [errorHandler], [CONV_ID, ERRORS_ID, "mx_01KR2E4K002H3ZYA9G0C4XV537"]));

    const clean = await runDriftCheckWithGraphStatus(p.config, { graphWarning: () => {} });
    expect(clean.graphStatus?.status).toBe("fresh");
    expect(clean.issues.filter((issue) => issue.code === "GROUNDING_DRIFT")).toEqual([]);

    // Body edit in compose(), comment-only edit inside errorHandler().
    writeFileSync(join(p.root, "src", "app.ts"), APP
      .replace("if (i <= index) throw", "if (i < index + 1) throw")
      .replace("reported as a generic 500", "reported as an opaque 500"));
    (await loadGroundingRuntime(p.config))!.close();

    const drifted = await runDriftCheckWithGraphStatus(p.config, { graphWarning: () => {} });
    expect(drifted.graphStatus?.status).toBe("fresh");
    expect(drifted.issues.filter((issue) => issue.code === "GROUNDING_DRIFT").map((issue) => issue.file).sort()).toEqual([
      ".mex/context/architecture.md",
      ".mex/context/conventions.md",
      ".mex/patterns/compose.md",
    ]);
    // Both mixed files are reported as split stores, at info.
    expect(clean.issues.filter((issue) => issue.code === "GROUNDING_MIXED_SHAPE")
      .map((issue) => [issue.file, issue.severity]).sort()).toEqual([
      [".mex/context/architecture.md", "info"],
      [".mex/context/conventions.md", "info"],
    ]);
  }, 60_000);

  it("wiki for-code returns root groundings on the file-level entity, never on a section", async () => {
    const p = project("mex-226-forcode-");
    await buildGraph(p.root);
    const compose = await groundingFor(p.config, "compose", true);
    writeFileSync(join(p.scaffoldRoot, "context", "architecture.md"),
      multiEntityDoc("architecture", "architecture", [compose], [ARCH_ID, INGEST_ID, ROUTING_ID]));
    // A file with only section entities: its root grounding has no owner.
    writeFileSync(join(p.scaffoldRoot, "context", "risks.md"),
      "---\nname: risks\n" + yamlList("grounds_to", [compose]) + "---\n\n# Risks\n\n" +
      `<!-- mex:entity\nid: ${ERRORS_ID}\ntype: risk\nstatus: promoted\nrevision: 1\n-->\n## One\n\n${SECTION_PROSE}`);

    expect((await seen(p, [compose.node])).forCode).toEqual([ARCH_ID]);
  }, 60_000);

  it("setup finalization leaves no file with both stores, and every grounding reachable", async () => {
    const p = project("mex-226-setup-");
    await buildGraph(p.root);
    const compose = await groundingFor(p.config, "compose", false);
    const errorHandler = await groundingFor(p.config, "errorHandler", false);

    // What population writes on a fresh scaffold: root groundings, no `mex:` map
    // yet, in files migration will split into a file-level entity plus sections.
    const files = {
      architecture: join(p.scaffoldRoot, "context", "architecture.md"),
      conventions: join(p.scaffoldRoot, "context", "conventions.md"),
    };
    writeFileSync(files.architecture, multiEntityDoc("architecture", "architecture", [compose], null));
    writeFileSync(files.conventions, multiEntityDoc("conventions", "convention", [errorHandler], null));

    await finalizeCodeRepoSetup(p.root, p.scaffoldRoot);

    for (const path of Object.values(files)) {
      const text = readFileSync(path, "utf-8");
      const frontmatter = YAML.parse(text.split("---\n")[1]!) as Record<string, unknown>;
      expect(frontmatter["mex"]).toBeDefined();
      expect(frontmatter["grounds_to"]).toBeUndefined();
      expect(extractGroundings(text)).toHaveLength(1);
    }
    expect(existsSync(join(p.scaffoldRoot, "wiki.db"))).toBe(true);
    const forCode = knowledgeRecordsFor([compose.node, errorHandler.node], { scaffoldRoot: p.scaffoldRoot }, p.root);
    expect(forCode.map((record) => record.file).sort()).toEqual(["context/architecture.md", "context/conventions.md"]);
  }, 90_000);
});
