/**
 * `mex check` and the Wiki decide a code link's state with one function.
 *
 * Each case grounds a Wiki entity to real code, edits the code, rebuilds the
 * graph, and asks both paths: `check`'s verdict, carried on its finding, and
 * the Wiki's `resolveGrounding` through the Wiki's own graph adapter. They
 * must name the same verdict, and it must be the right one.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MexConfig } from "../src/types.js";
import { runDriftCheckWithGraphStatus } from "../src/drift/index.js";
import { openGraphDatabase } from "../src/graph/db/database.js";
import { createGraphEngine } from "../src/graph/engine-impl.js";
import { FingerprintStore } from "../src/graph/fingerprint-store.js";
import { serializeFingerprint } from "../src/graph/fingerprint.js";
import { MinHashReconciler } from "../src/graph/reconcile-engine.js";
import { loadGroundingRuntime, refreshGroundingBaselines } from "../src/graph/runtime.js";
import { writeGroundings } from "../src/markdown.js";
import { runSync } from "../src/sync/index.js";
import { createGroundingGraph } from "../src/wiki/grounding/adapter.js";
import { resolveGrounding } from "../src/wiki/grounding/resolve.js";
import { groundingVerdict, type GroundingVerdict } from "../src/wiki/grounding/verdict.js";
import { parseWikiMarkdown } from "../src/wiki/markdown/codec.js";
import { wikiGroundingStatus } from "../src/wiki/service/read.js";
import { wikiRebuildIndex } from "../src/wiki/service/write.js";
import { wikiRegroundEntity } from "../src/wiki/service/reground.js";

vi.mock("../src/cli-tools.js", () => ({ isCliAvailable: () => true }));

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const SOURCE = `export function calculateOrderTotal(items: number[]): number {
  const subtotal = items.reduce((sum, item) => sum + item, 0);
  const tax = subtotal * 0.18;
  const taxed = subtotal + tax;
  const count = items.length;
  const heavy = count > 20;
  const label = heavy ? "bulk" : "standard";
  const shipping = label === "bulk" ? 0 : 75;
  return taxed + shipping;
}

export function formatReceipt(lines: string[]): string {
  return lines.map((line) => line.trim()).join(", ");
}
`;

const FACT = "calculateOrderTotal sets `tax` to `subtotal * 0.18`.";
const ENTITY_ID = "mx_01ARZ3NDEKTSV4RRFFQ69G5FAA";

const EDITS: Array<{ name: string; edit: (source: string) => string; expected: GroundingVerdict }> = [
  { name: "unchanged", edit: (source) => source, expected: "fresh" },
  {
    name: "comment-only",
    edit: (source) => source.replace("const tax = subtotal * 0.18;", "const tax = subtotal * 0.18; // GST"),
    expected: "fresh",
  },
  {
    name: "formatting",
    edit: (source) => source.replace("const tax = subtotal * 0.18;", "const tax = subtotal * 0.18"),
    expected: "fresh",
  },
  {
    name: "changed away from the fact",
    edit: (source) => source.replace('? 0 : 75;', '? 0 : 95;'),
    expected: "changed-nearby",
  },
  {
    name: "behaviour change",
    edit: (source) => source.replace("subtotal * 0.18", "subtotal * 0.21"),
    expected: "changed",
  },
  {
    name: "rename",
    edit: (source) => source.replace("calculateOrderTotal", "computeOrderTotal"),
    expected: "moved",
  },
  {
    name: "deleted",
    edit: (source) => source.slice(source.indexOf("export function formatReceipt")),
    expected: "missing",
  },
];

interface Fixture {
  root: string;
  source: string;
  scaffold: string;
  config: MexConfig;
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "mex-verdict-agreement-"));
  roots.push(root);
  const source = join(root, "src", "orders.ts");
  const scaffold = join(root, ".mex", "context", "orders.md");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, ".mex", "context"), { recursive: true });
  writeFileSync(join(root, ".mex", "ROUTER.md"), "# Router\n");
  writeFileSync(join(root, "CLAUDE.md"), "Read `.mex/ROUTER.md` before starting.\n");
  const today = new Date().toISOString().slice(0, 10);
  writeFileSync(scaffold, [
    "---", "name: orders", "description: Order totals.", `last_updated: ${today}`,
    "mex:", `  id: ${ENTITY_ID}`, "  type: pattern", "  status: promoted", "---", "", "# Order totals", "", FACT, "",
  ].join("\n"));
  writeFileSync(source, SOURCE);
  return { root, source, scaffold, config: { projectRoot: root, scaffoldRoot: join(root, ".mex"), aiTools: ["claude"] } };
}

async function build(root: string): Promise<void> {
  const engine = createGraphEngine({ rootDir: root });
  await engine.build();
  engine.close();
}

/** Ground the entity to `calculateOrderTotal` and record its baseline, as `mex sync` does. */
async function ground(fx: Fixture): Promise<void> {
  const runtime = await loadGroundingRuntime(fx.config);
  try {
    const node = runtime!.graph.searchNodes("calculateOrderTotal").find((entry) => entry.kind === "function")!;
    const fingerprint = runtime!.reconciler.getFingerprint(node.id)!;
    writeFileSync(fx.scaffold, writeGroundings(readFileSync(fx.scaffold, "utf-8"), [{
      node: node.id,
      fingerprint: serializeFingerprint(fingerprint),
    }]));
    refreshGroundingBaselines(fx.config, [fx.scaffold], runtime!);
  } finally {
    runtime!.close();
  }
}

/** The verdict `check` reports for the entity's one link, with the entity it names. */
async function checkVerdict(fx: Fixture): Promise<{ verdict: GroundingVerdict | "silent"; entity?: string }> {
  const report = await runDriftCheckWithGraphStatus(fx.config, { graphWarning: () => {} });
  const found = report.issues.filter((issue) => issue.code.startsWith("GROUNDING_"));
  const withVerdict = found.find((issue) => issue.verdict !== undefined);
  return withVerdict === undefined
    ? { verdict: "silent" }
    : { verdict: withVerdict.verdict!, ...(withVerdict.entity ? { entity: withVerdict.entity.id } : {}) };
}

/**
 * The verdict the Wiki reaches for the same link, from the Wiki's own adapter,
 * and the health `wiki rebuild-index` stores for the entity from it.
 */
function wikiVerdict(fx: Fixture): { verdict: GroundingVerdict; stored: string | null } {
  const parsed = parseWikiMarkdown({ path: "context/orders.md", text: readFileSync(fx.scaffold, "utf-8") });
  const entity = parsed.entities[0]!.entity;
  const dbPath = join(fx.root, ".mex", "graph.db");
  const db = openGraphDatabase(dbPath);
  const engine = createGraphEngine({ rootDir: fx.root, dbPath });
  try {
    const graph = createGroundingGraph(engine, new MinHashReconciler(new FingerprintStore(db)), db, { projectRoot: fx.root });
    const verdict = groundingVerdict(resolveGrounding(entity.groundsTo[0]!, graph, { fact: `${entity.title}\n\n${entity.body}` })).verdict;
    const scaffoldRoot = join(fx.root, ".mex");
    wikiRebuildIndex({ scaffoldRoot, graph });
    const status = wikiGroundingStatus({ scaffoldRoot, id: ENTITY_ID });
    return { verdict, stored: status.data.entities[0]?.health ?? null };
  } finally {
    engine.close();
    db.close();
  }
}

describe("check and the Wiki share one code-link verdict", () => {
  it.each(EDITS)("$name: both say $expected", async ({ edit, expected }) => {
    const fx = fixture();
    await build(fx.root);
    await ground(fx);
    writeFileSync(fx.source, edit(SOURCE));
    await build(fx.root);

    const check = await checkVerdict(fx);
    const { verdict: wiki, stored } = wikiVerdict(fx);
    expect(wiki).toBe(expected);
    // The index stores the Wiki's coarser health, derived from the same verdict.
    const health: Record<string, string> = { "changed-nearby": "fresh", moved: "fresh" };
    expect(stored).toBe(health[wiki] ?? wiki);
    // `check` stays silent only for a link that needs nothing at all.
    expect(check.verdict === "silent" ? "fresh" : check.verdict).toBe(wiki);
    if (check.verdict !== "silent") expect(check.entity).toBe(ENTITY_ID);
  }, 60_000);
});

/** Run `fn` with the Wiki's graph adapter over the fixture's graph. */
function withWikiGraph<T>(fx: Fixture, fn: (graph: ReturnType<typeof createGroundingGraph>) => T): T {
  const dbPath = join(fx.root, ".mex", "graph.db");
  const db = openGraphDatabase(dbPath);
  const engine = createGraphEngine({ rootDir: fx.root, dbPath });
  try {
    return fn(createGroundingGraph(engine, new MinHashReconciler(new FingerprintStore(db)), db, { projectRoot: fx.root }));
  } finally {
    engine.close();
    db.close();
  }
}

describe("wiki reground re-records a reviewed entity", () => {
  it("re-records a changed link, after which check is clean", async () => {
    const fx = fixture();
    await build(fx.root);
    await ground(fx);
    writeFileSync(fx.source, SOURCE.replace("subtotal * 0.18", "subtotal * 0.21"));
    await build(fx.root);
    expect((await checkVerdict(fx)).verdict).toBe("changed");

    const scaffoldRoot = join(fx.root, ".mex");
    const planned = withWikiGraph(fx, (graph) => wikiRegroundEntity(ENTITY_ID, { scaffoldRoot, graph }));
    expect(planned.data.apply?.applied).toBe(false);
    expect((await checkVerdict(fx)).verdict).toBe("changed");

    const applied = withWikiGraph(fx, (graph) => wikiRegroundEntity(ENTITY_ID, { scaffoldRoot, graph, apply: true }));
    expect(applied.data.links).toMatchObject([{ verdict: "changed" }]);
    expect(applied.diagnostics).toEqual([]);
    expect(applied.data.apply?.applied).toBe(true);
    expect((await checkVerdict(fx)).verdict).toBe("silent");
  }, 60_000);

  it("follows a rename to the new node", async () => {
    const fx = fixture();
    await build(fx.root);
    await ground(fx);
    writeFileSync(fx.source, SOURCE.replace("calculateOrderTotal", "computeOrderTotal"));
    await build(fx.root);

    const scaffoldRoot = join(fx.root, ".mex");
    const applied = withWikiGraph(fx, (graph) => wikiRegroundEntity(ENTITY_ID, { scaffoldRoot, graph, apply: true }));
    expect(applied.data.links[0]!.verdict).toBe("moved");
    expect(applied.data.links[0]!.recordedNode).not.toBe(applied.data.links[0]!.node);
    expect(readFileSync(fx.scaffold, "utf-8")).toContain(applied.data.links[0]!.recordedNode!);
    expect((await checkVerdict(fx)).verdict).toBe("silent");
  }, 60_000);

  it("refuses a missing link and writes nothing", async () => {
    const fx = fixture();
    await build(fx.root);
    await ground(fx);
    writeFileSync(fx.source, SOURCE.slice(SOURCE.indexOf("export function formatReceipt")));
    await build(fx.root);
    const before = readFileSync(fx.scaffold, "utf-8");

    const scaffoldRoot = join(fx.root, ".mex");
    const refused = withWikiGraph(fx, (graph) => wikiRegroundEntity(ENTITY_ID, { scaffoldRoot, graph, apply: true }));
    expect(refused.data.apply).toBeNull();
    expect(refused.data.links).toMatchObject([{ verdict: "missing" }]);
    expect(readFileSync(fx.scaffold, "utf-8")).toBe(before);
  }, 60_000);
});

describe("mex sync reviews flagged Wiki entities in the same session", () => {
  async function syncWith(fx: Fixture, agent: (brief: string) => boolean, rebuild?: () => Promise<{ entityCount: number }>) {
    const lines: string[] = [];
    const briefs: string[] = [];
    const answers = ["1", "n", "n", "n"];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => { lines.push(args.join(" ")); });
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { lines.push(args.join(" ")); });
    try {
      await runSync(fx.config, {}, {
        ask: async () => answers.shift() ?? "n",
        runAgent: (_tool, brief) => {
          briefs.push(brief);
          return agent(brief);
        },
        reviewGrounding: false,
        ...(rebuild === undefined ? {} : { rebuildWikiIndex: rebuild }),
      });
    } finally {
      vi.restoreAllMocks();
    }
    return { lines: lines.map((line) => stripVTControlCharacters(line)), briefs };
  }

  afterEach(() => {
    process.exitCode = undefined;
  });

  it("hands the entity to the agent, which re-records it; the index is rebuilt and check is clean", async () => {
    const fx = fixture();
    await build(fx.root);
    await ground(fx);
    writeFileSync(fx.source, SOURCE.replace("subtotal * 0.18", "subtotal * 0.21"));
    await build(fx.root);

    // A deterministic agent answering "changed": it fixes the fact, then re-records.
    const { lines, briefs } = await syncWith(fx, () => {
      writeFileSync(fx.scaffold, readFileSync(fx.scaffold, "utf-8").replace("0.18`.", "0.21`."));
      const done = withWikiGraph(fx, (graph) => wikiRegroundEntity(ENTITY_ID, { scaffoldRoot: join(fx.root, ".mex"), graph, apply: true }));
      return done.data.apply?.applied === true;
    });

    expect(briefs).toHaveLength(1);
    expect(briefs[0]).toContain("WIKI ENTITY REVIEW");
    expect(briefs[0]).toContain(`${ENTITY_ID} "Order totals"`);
    expect(briefs[0]).toContain("mex wiki reground <entity-id> --apply");
    expect(briefs[0]).toContain("UNSURE: change nothing");
    expect(lines.some((line) => line.startsWith("Rebuilt the Wiki index (1 entities)"))).toBe(true);
    expect(lines).toContain("Wiki entities reviewed: 1 cleared, 0 still flagged.");
    expect((await checkVerdict(fx)).verdict).toBe("silent");
    expect(wikiGroundingStatus({ scaffoldRoot: join(fx.root, ".mex"), id: ENTITY_ID }).data.entities[0]?.health).toBe("fresh");
  }, 90_000);

  it("names a missing link the agent could not re-record as still flagged", async () => {
    const fx = fixture();
    await build(fx.root);
    await ground(fx);
    writeFileSync(fx.source, SOURCE.slice(SOURCE.indexOf("export function formatReceipt")));
    await build(fx.root);

    // "Unsure": the agent changes nothing.
    const { lines, briefs } = await syncWith(fx, () => true);
    expect(briefs[0]).toContain("GROUNDING_GONE (missing)");
    expect(briefs[0]).toContain("refuses them");
    expect(lines).toContain("Wiki entities reviewed: 0 cleared, 1 still flagged.");
    expect(lines).toContain(`  still flagged, not cleared: ${ENTITY_ID} "Order totals" — missing`);
  }, 90_000);

  it("stops loudly when the Wiki index rebuild fails", async () => {
    const fx = fixture();
    await build(fx.root);
    await ground(fx);
    writeFileSync(fx.source, SOURCE.replace("subtotal * 0.18", "subtotal * 0.21"));
    await build(fx.root);

    const { lines } = await syncWith(fx, () => true, async () => {
      throw new Error("disk full");
    });
    expect(lines).toContain("✗ Wiki index rebuild failed: disk full");
    expect(process.exitCode).toBe(1);
    expect(lines.some((line) => line.startsWith("Drift score:"))).toBe(false);
  }, 90_000);
});
