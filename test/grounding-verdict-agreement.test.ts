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
import { afterEach, describe, expect, it } from "vitest";
import type { MexConfig } from "../src/types.js";
import { runDriftCheckWithGraphStatus } from "../src/drift/index.js";
import { openGraphDatabase } from "../src/graph/db/database.js";
import { createGraphEngine } from "../src/graph/engine-impl.js";
import { FingerprintStore } from "../src/graph/fingerprint-store.js";
import { serializeFingerprint } from "../src/graph/fingerprint.js";
import { MinHashReconciler } from "../src/graph/reconcile-engine.js";
import { loadGroundingRuntime, refreshGroundingBaselines } from "../src/graph/runtime.js";
import { writeGroundings } from "../src/markdown.js";
import { createGroundingGraph } from "../src/wiki/grounding/adapter.js";
import { resolveGrounding } from "../src/wiki/grounding/resolve.js";
import { groundingVerdict, type GroundingVerdict } from "../src/wiki/grounding/verdict.js";
import { parseWikiMarkdown } from "../src/wiki/markdown/codec.js";

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

/** The verdict the Wiki stores for the same link, from the Wiki's own adapter. */
function wikiVerdict(fx: Fixture): GroundingVerdict {
  const parsed = parseWikiMarkdown({ path: "context/orders.md", text: readFileSync(fx.scaffold, "utf-8") });
  const entity = parsed.entities[0]!.entity;
  const dbPath = join(fx.root, ".mex", "graph.db");
  const db = openGraphDatabase(dbPath);
  const engine = createGraphEngine({ rootDir: fx.root, dbPath });
  try {
    const graph = createGroundingGraph(engine, new MinHashReconciler(new FingerprintStore(db)), db, { projectRoot: fx.root });
    return groundingVerdict(resolveGrounding(entity.groundsTo[0]!, graph, { fact: `${entity.title}\n\n${entity.body}` })).verdict;
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
    const wiki = wikiVerdict(fx);
    expect(wiki).toBe(expected);
    // `check` stays silent only for a link that needs nothing at all.
    expect(check.verdict === "silent" ? "fresh" : check.verdict).toBe(wiki);
    if (check.verdict !== "silent") expect(check.entity).toBe(ENTITY_ID);
  }, 60_000);
});
