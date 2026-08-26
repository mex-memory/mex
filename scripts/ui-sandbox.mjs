// ============================================================================
// Wizard sandbox
// ============================================================================
//
// Runs `mex ui` against a throwaway project so the setup wizard can be tested
// from zero, repeatedly, without pointing this repo at a real codebase. Setup
// refuses to run inside the mex checkout (it would overwrite the templates it
// reads from), and every wizard run is one-way — the sandbox is what makes the
// flow re-runnable.
//
//   node scripts/ui-sandbox.mjs              reset the sandbox and serve the UI
//   node scripts/ui-sandbox.mjs --keep       serve without wiping (test the dashboard)
//   node scripts/ui-sandbox.mjs --populate   simulate the agent filling the scaffold
//
// `--populate` is the interesting one. The wizard hands you a prompt to paste
// into your coding agent, which is where prose and grounding come from; that
// makes the post-population half of the flow untestable without a live agent
// session. So this stands in for one: it fills the scaffold and authors real
// `grounds_to` entries and `mex://` anchors taken from the sandbox's own graph.
// Then "capture grounding" in the UI has something true to record.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(repoRoot, "dist", "cli.js");
const DEFAULT_DIR = ".sandbox/orders";

function main() {
  const args = parseArgs(process.argv.slice(2));
  const sandbox = resolve(repoRoot, args.dir);

  if (args.help) {
    usage();
    return;
  }

  if (!existsSync(CLI)) {
    fail("dist/cli.js not found. Run `npm run build` first.");
  }

  if (args.populate) {
    populate(sandbox);
    return;
  }

  if (!args.keep) rmSync(sandbox, { recursive: true, force: true });

  if (existsSync(sandbox)) {
    console.log(`[sandbox] reusing ${relative(repoRoot, sandbox)}`);
  } else {
    seed(sandbox);
    initGit(sandbox);
    console.log(`[sandbox] seeded ${relative(repoRoot, sandbox)}`);
  }

  warnIfUiUnbuilt();

  console.log(
    [
      "",
      "  Sandbox ready. In the browser:",
      "    1. Run the wizard end to end.",
      "    2. Then, in another terminal, stand in for the agent:",
      `         node scripts/ui-sandbox.mjs --populate${args.dir === DEFAULT_DIR ? "" : ` --dir ${args.dir}`}`,
      '    3. Back in the UI, hit "capture grounding" on Setup.',
      "",
      "  Re-run this script any time to reset and start over.",
      "",
    ].join("\n"),
  );

  const uiArgs = ["ui", "--root", sandbox];
  if (args.port) uiArgs.push("--port", String(args.port));
  if (args.noOpen) uiArgs.push("--no-open");

  const child = spawn(process.execPath, [CLI, ...uiArgs], { stdio: "inherit" });
  child.on("exit", (code) => process.exit(code ?? 0));
}

// ── Seeding ────────────────────────────────────────────────────────────────

/**
 * A small but genuine TypeScript project. It needs real call edges between real
 * symbols, because a graph with nothing in it can't demonstrate grounding — and
 * "the wizard looked fine against an empty repo" is not evidence.
 */
function seed(dir) {
  const files = {
    "package.json": `${JSON.stringify(
      {
        name: "sandbox-orders",
        version: "1.0.0",
        private: true,
        type: "module",
        description: "Throwaway order service used to exercise the mex web UI.",
        scripts: { build: "tsc", test: "node --test" },
        dependencies: { zod: "^3.23.8" },
      },
      null,
      2,
    )}\n`,

    "README.md": [
      "# sandbox-orders",
      "",
      "A deliberately small order service. It exists so the mex setup wizard has a",
      "real codebase to index, and is recreated from scratch by",
      "`node scripts/ui-sandbox.mjs`.",
      "",
      "## Layout",
      "",
      "- `src/index.ts` — entry point",
      "- `src/orders/` — order pricing and persistence",
      "- `src/lib/` — money helpers",
      "",
    ].join("\n"),

    "tsconfig.json": `${JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "bundler",
          strict: true,
          outDir: "dist",
        },
        include: ["src"],
      },
      null,
      2,
    )}\n`,

    "src/index.ts": [
      'import { placeOrder } from "./orders/service.js";',
      'import { formatMoney } from "./lib/money.js";',
      "",
      "/** Entry point. Places one demo order and prints the total. */",
      "export async function main(): Promise<void> {",
      "  const order = await placeOrder({",
      '    customerId: "cus_demo",',
      '    lines: [{ sku: "widget", quantity: 3, unitCents: 1299 }],',
      '    couponCode: "WELCOME10",',
      "  });",
      "  console.log(`order ${order.id} total ${formatMoney(order.totalCents)}`);",
      "}",
      "",
      "main().catch((error: unknown) => {",
      "  console.error(error);",
      "  process.exitCode = 1;",
      "});",
      "",
    ].join("\n"),

    "src/orders/types.ts": [
      "export interface OrderLine {",
      "  sku: string;",
      "  quantity: number;",
      "  unitCents: number;",
      "}",
      "",
      "export interface OrderDraft {",
      "  customerId: string;",
      "  lines: OrderLine[];",
      "  couponCode?: string;",
      "}",
      "",
      "export interface Order extends OrderDraft {",
      "  id: string;",
      "  totalCents: number;",
      "  createdAt: string;",
      "}",
      "",
    ].join("\n"),

    "src/orders/service.ts": [
      'import { applyDiscount, sumLines } from "../lib/money.js";',
      'import { saveOrder } from "./repository.js";',
      'import type { Order, OrderDraft } from "./types.js";',
      "",
      "/**",
      " * Price a draft and persist it. The total is computed here rather than in the",
      " * repository so pricing rules stay in one place.",
      " */",
      "export async function placeOrder(draft: OrderDraft): Promise<Order> {",
      "  const totalCents = priceOrder(draft);",
      "  const order: Order = {",
      "    ...draft,",
      "    id: `ord_${Math.random().toString(36).slice(2, 10)}`,",
      "    totalCents,",
      "    createdAt: new Date().toISOString(),",
      "  };",
      "  await saveOrder(order);",
      "  return order;",
      "}",
      "",
      "/** Subtotal minus any coupon discount, in cents. Never negative. */",
      "export function priceOrder(draft: OrderDraft): number {",
      "  const subtotal = sumLines(draft.lines);",
      "  if (!draft.couponCode) return subtotal;",
      "  return applyDiscount(subtotal, discountFor(draft.couponCode));",
      "}",
      "",
      "/** Coupon table. Unknown codes are worth nothing rather than an error. */",
      "export function discountFor(couponCode: string): number {",
      "  const table: Record<string, number> = {",
      "    WELCOME10: 0.1,",
      "    BULK25: 0.25,",
      "  };",
      "  return table[couponCode.toUpperCase()] ?? 0;",
      "}",
      "",
    ].join("\n"),

    "src/orders/repository.ts": [
      'import type { Order } from "./types.js";',
      "",
      "const orders = new Map<string, Order>();",
      "",
      "/** Persist an order. In-memory here; a real one would write to Postgres. */",
      "export async function saveOrder(order: Order): Promise<void> {",
      "  orders.set(order.id, order);",
      "}",
      "",
      "export async function findOrder(id: string): Promise<Order | undefined> {",
      "  return orders.get(id);",
      "}",
      "",
      "export async function listOrdersForCustomer(customerId: string): Promise<Order[]> {",
      "  return [...orders.values()].filter((order) => order.customerId === customerId);",
      "}",
      "",
    ].join("\n"),

    "src/lib/money.ts": [
      'import type { OrderLine } from "../orders/types.js";',
      "",
      "/** Sum line items in cents. Integer math only — no float drift. */",
      "export function sumLines(lines: readonly OrderLine[]): number {",
      "  return lines.reduce((total, line) => total + line.quantity * line.unitCents, 0);",
      "}",
      "",
      "/** Apply a 0-1 rate, rounding half up and clamping at zero. */",
      "export function applyDiscount(cents: number, rate: number): number {",
      "  const clamped = Math.min(Math.max(rate, 0), 1);",
      "  return Math.max(0, Math.round(cents * (1 - clamped)));",
      "}",
      "",
      "/** Render cents as a currency string, e.g. `$38.97`. */",
      "export function formatMoney(cents: number): string {",
      "  return `$${(cents / 100).toFixed(2)}`;",
      "}",
      "",
    ].join("\n"),
  };

  for (const [path, content] of Object.entries(files)) {
    const absolute = join(dir, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content, "utf-8");
  }
}

/**
 * A `.git` directory matters here: `findProjectRoot` walks upward until it finds
 * one, so without it the sandbox would resolve to the mex repo root and setup
 * would (correctly) refuse to run.
 */
function initGit(dir) {
  const git = (...gitArgs) => spawnSync("git", gitArgs, { cwd: dir, stdio: "ignore" });
  if (git("init", "-q").error) {
    console.warn("[sandbox] git not available — the wizard will treat this as a non-git project.");
    return;
  }
  git("add", "-A");
  git(
    "-c",
    "user.name=mex sandbox",
    "-c",
    "user.email=sandbox@example.invalid",
    "commit",
    "-q",
    "-m",
    "seed sandbox project",
  );
}

// ── Population (stands in for the agent) ───────────────────────────────────

const GROUNDED_FILES = {
  "context/architecture.md": {
    task: "place an order and compute its total",
    prefer: ["placeOrder", "priceOrder"],
    heading: "Order flow",
    prose: (anchor) =>
      `A draft enters through ${anchor} in \`src/orders/service.ts\`, which prices it and then hands the priced order to the repository layer. Pricing deliberately does not live in the repository, so every caller sees the same totals.`,
  },
  "context/conventions.md": {
    task: "money discount rounding helpers",
    prefer: ["applyDiscount", "sumLines"],
    heading: "Money is always integer cents",
    prose: (anchor) =>
      `Amounts are integer cents everywhere. ${anchor} in \`src/lib/money.ts\` is the only place a rate is applied, and it rounds half up and clamps at zero. Never introduce floating-point currency.`,
  },
};

function populate(dir) {
  const mexDir = join(dir, ".mex");
  if (!existsSync(mexDir)) {
    fail(
      `No .mex/ in ${relative(repoRoot, dir)}. Run the wizard first, then re-run with --populate.`,
    );
  }

  const today = new Date().toISOString().slice(0, 10);
  const projectName = "sandbox-orders";

  const markdown = readdirSync(mexDir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => join(entry.parentPath ?? entry.path, entry.name));

  let filled = 0;
  for (const absolute of markdown) {
    const relativePath = relative(mexDir, absolute).replaceAll("\\", "/");
    const original = readFileSync(absolute, "utf-8");
    let next = fillTemplate(original, { projectName, today });

    // Only an untouched `grounds_to: []` gets grounded, which makes re-running
    // --populate a no-op instead of stacking duplicate anchors.
    const plan = GROUNDED_FILES[relativePath];
    if (plan && /grounds_to: \[\]/.test(next)) {
      const facts = scopeFacts(dir, plan.task);
      if (facts.length === 0) {
        console.warn(
          `[sandbox] no graph facts for "${plan.task}" — ${relativePath} left ungrounded. Build the code graph first.`,
        );
      } else {
        next = ground(next, plan, facts);
      }
    }

    if (next !== original) {
      writeFileSync(absolute, next, "utf-8");
      filled += 1;
    }
  }

  console.log(
    `[sandbox] populated ${filled} scaffold file${filled === 1 ? "" : "s"} in ${relative(repoRoot, mexDir)}`,
  );
  console.log('[sandbox] now click "capture grounding" on the Setup page.');
}

/**
 * Make a template look filled in: drop the annotation comments and resolve the
 * placeholders the snapshot layer tests for, so `populated` flips true the same
 * way it would after a real agent pass.
 *
 * Templates are checked out with whatever line endings git gives them, hence
 * the `\r?` everywhere — on Windows this silently did nothing without it.
 */
function fillTemplate(content, { projectName, today }) {
  const [, frontmatter, body] = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(content) ?? [];
  if (frontmatter === undefined) return content;

  const filledBody = body
    .replace(/<!--[\s\S]*?-->\r?\n?/g, "")
    .replace(/\[Project Name\]/g, projectName)
    .replace(/(\r?\n){3,}/g, "\n\n")
    .replace(
      /^(##+ .*)$/gm,
      "$1\n\nFilled by the sandbox populate step, standing in for an agent pass.",
    );

  const filledFrontmatter = frontmatter.replace(
    /last_updated: \[YYYY-MM-DD\]/,
    `last_updated: "${today}"`,
  );

  return `---\n${filledFrontmatter}\n---\n${filledBody}`;
}

/** Author `grounds_to` entries plus one inline `mex://` anchor, as an agent would. */
function ground(content, plan, facts) {
  const chosen = pickFacts(plan, facts);
  const entries = chosen
    .map((fact) => `  - node: "${fact.id}"\n    fingerprint: "${fact.fingerprint}"`)
    .join("\n");

  const anchor = `[\`${chosen[0].name}()\`](mex://${chosen[0].id})`;
  const section = `\n## ${plan.heading}\n\n${plan.prose(anchor)}\n`;

  return `${content.replace(/grounds_to: \[\]/, `grounds_to:\n${entries}`)}${section}`;
}

/**
 * Prefer the symbols the prose actually talks about, so the anchor a reviewer
 * clicks matches the sentence around it. Falls back to whatever scope ranked
 * highest, which keeps the sandbox useful if the seed project changes.
 */
function pickFacts(plan, facts) {
  const byName = new Map(facts.map((fact) => [fact.name, fact]));
  const preferred = (plan.prefer ?? []).flatMap((name) => {
    const fact = byName.get(name);
    return fact ? [fact] : [];
  });
  return (preferred.length > 0 ? preferred : facts).slice(0, 2);
}

/**
 * Ask the sandbox's own graph for real node ids and fingerprints. Going through
 * `mex graph scope --fingerprint` is the point: it is the exact command the
 * population prompt tells the agent to use, so anything it can't supply is a
 * gap a real agent would hit too.
 */
function scopeFacts(dir, task) {
  const result = spawnSync(
    process.execPath,
    [CLI, "graph", "scope", task, "--fingerprint", "--detail", "standard"],
    { cwd: dir, encoding: "utf-8" },
  );

  if (result.status !== 0) {
    console.warn(`[sandbox] mex graph scope failed: ${result.stderr?.trim() || "unknown error"}`);
    return [];
  }

  return (result.stdout ?? "")
    .split("\n")
    .flatMap((line) => {
      if (!line.trim()) return [];
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    })
    .filter(
      (record) =>
        record.type === "fact" &&
        typeof record.fingerprint === "string" &&
        (record.kind === "function" || record.kind === "method"),
    )
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}

// ── Plumbing ───────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const parsed = { dir: DEFAULT_DIR, keep: false, populate: false, noOpen: false, port: null, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--keep") parsed.keep = true;
    else if (arg === "--populate") parsed.populate = true;
    else if (arg === "--no-open") parsed.noOpen = true;
    else if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (arg === "--dir") parsed.dir = argv[++index] ?? DEFAULT_DIR;
    else if (arg === "--port") parsed.port = Number(argv[++index]);
    else fail(`Unknown argument: ${arg}`);
  }
  return parsed;
}

function warnIfUiUnbuilt() {
  const built = [
    join(repoRoot, "dist", "ui", "index.html"),
    join(repoRoot, "packages", "mex-ui", "dist", "index.html"),
  ].some(existsSync);
  if (!built) {
    console.warn("[sandbox] the frontend isn't built — run `npm run build:ui` for the real UI.");
  }
}

function usage() {
  console.log(
    [
      "Usage: node scripts/ui-sandbox.mjs [options]",
      "",
      "  --keep         serve an existing sandbox instead of recreating it",
      "  --populate     fill the scaffold and author grounding, standing in for an agent",
      `  --dir <path>   sandbox location (default ${DEFAULT_DIR})`,
      "  --port <n>     port for the UI server",
      "  --no-open      do not open a browser",
      "",
    ].join("\n"),
  );
}

function fail(message) {
  console.error(`[sandbox] ${message}`);
  process.exit(1);
}

// Last line on purpose: the tables above are `const`, so calling main() any
// earlier reads them before initialization.
main();
