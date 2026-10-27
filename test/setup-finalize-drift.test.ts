import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGraphEngine } from "../src/graph/engine-impl.js";
import { runGraphScope } from "../src/graph/cli-agent.js";
import { describeGroundingDrift } from "../src/graph/grounding-failures.js";
import { extractGroundings, writeGroundings } from "../src/markdown.js";
import { finalizeCodeRepoSetup } from "../src/setup/index.js";
import { loadGroundingRuntime } from "../src/graph/runtime.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const git = (cwd: string, ...args: string[]) => {
  const out = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, encoding: "utf8" });
  expect(out.status, out.stderr).toBe(0);
};
const SOURCE = `
export function totalPrice(items: number[], member: boolean): number {
  const subtotal = items.reduce((sum, item) => sum + item, 0);
  const discount = member ? subtotal * 0.05 : 0;
  return subtotal - discount;
}

export function shippingCost(subtotal: number): number {
  const free = subtotal >= 100;
  return free ? 0 : 12;
}
`;

async function project() {
  const root = mkdtempSync(join(tmpdir(), "mex-finalize-drift-"));
  roots.push(root);
  const scaffold = join(root, ".mex");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(scaffold, "patterns"), { recursive: true });
  git(root, "init", "-q");
  writeFileSync(join(scaffold, "ROUTER.md"), "# Router\n");
  writeFileSync(join(root, "src", "price.ts"), SOURCE);
  const engine = createGraphEngine({ rootDir: root });
  await engine.build();
  engine.close();
  const fact = (name: string) => {
    const rows: string[] = [];
    runGraphScope(name, root, { write: (line) => rows.push(line) }, { fingerprint: true });
    const found = rows.map((row) => JSON.parse(row) as Record<string, unknown>).find((row) => row.type === "fact" && row.name === name)!;
    return { node: String(found.id), fingerprint: String(found.fingerprint) };
  };
  return { root, scaffold, fact, pattern: join(scaffold, "patterns", "pricing.md") };
}

const skeleton = "---\nname: pricing\ndescription: How prices are computed\ngrounds_to: []\n---\n\n# Pricing\n";
const BAD = { node: "function:00000000000000000000000000000000", fingerprint: "mh2:64:AAAA" };
const quiet = { onMessage: () => {} };
const editedSource = () => SOURCE.replace("subtotal * 0.05", "subtotal * 0.10");

describe("finalize leaves recorded knowledge whose code changed alone", () => {
  async function recorded() {
    const p = await project();
    const total = p.fact("totalPrice");
    writeFileSync(p.pattern, writeGroundings(skeleton, [total]) + `\n[\`totalPrice()\`](mex://${total.node}) discounts members.\n`);
    // The first setup records the baseline; the user then commits the scaffold.
    const first = await finalizeCodeRepoSetup(p.root, p.scaffold, quiet);
    expect(first).toEqual({ dropped: [], drift: null });
    git(p.root, "add", "-A");
    git(p.root, "commit", "-q", "-m", "setup");
    return p;
  }

  it("completes a rerun after a code change, drops nothing, keeps every byte and points to mex sync", async () => {
    const p = await recorded();
    const before = readFileSync(p.pattern, "utf8");
    writeFileSync(join(p.root, "src", "price.ts"), editedSource());
    const populate = vi.fn(async () => ({ tool: "codex" as const, completed: true }));
    const outcome = await finalizeCodeRepoSetup(p.root, p.scaffold, { selectedTools: ["codex"], populate, ...quiet });
    expect(outcome.dropped).toEqual([]);
    expect(outcome.drift).toMatchObject({ entities: 1, files: [".mex/patterns/pricing.md"] });
    expect(populate).not.toHaveBeenCalled();
    expect(readFileSync(p.pattern, "utf8")).toBe(before);
    const text = describeGroundingDrift(outcome.drift);
    expect(text).toContain("changed since they were recorded");
    expect(text).toContain(".mex/patterns/pricing.md");
    expect(text).toContain("mex sync");
  }, 60_000);

  it("repairs and drops only the new bad reference; the drifted recorded fact is untouched", async () => {
    const p = await recorded();
    writeFileSync(join(p.root, "src", "price.ts"), editedSource());
    const recordedText = readFileSync(p.pattern, "utf8");
    const recordedGrounding = extractGroundings(recordedText)[0]!;
    // The agent adds one reference that does not exist, next to the recorded one.
    writeFileSync(p.pattern, writeGroundings(recordedText, [recordedGrounding, BAD]) + `\n[gone](mex://${BAD.node})\n`);
    const populate = vi.fn(async (input: { prompt: string }) => {
      expect(input.prompt).toContain(BAD.node);
      expect(input.prompt).not.toContain(recordedGrounding.node);
      return { tool: "codex" as const, completed: true };
    });
    const outcome = await finalizeCodeRepoSetup(p.root, p.scaffold, { selectedTools: ["codex"], populate, ...quiet });
    expect(populate).toHaveBeenCalledOnce();
    expect(outcome.dropped.map((entry) => entry.node)).toEqual([BAD.node]);
    expect(outcome.drift).toMatchObject({ entities: 1 });
    const after = readFileSync(p.pattern, "utf8");
    expect(extractGroundings(after)).toEqual([recordedGrounding]);
    expect(after).not.toContain(BAD.node);
    expect(after).toContain("gone");
    expect(after).toContain(`mex://${recordedGrounding.node}`);
  }, 60_000);

  it("keeps a new reference the repair turn fixed", async () => {
    const p = await recorded();
    const text = readFileSync(p.pattern, "utf8");
    const total = extractGroundings(text)[0]!;
    const shipping = p.fact("shippingCost");
    writeFileSync(p.pattern, writeGroundings(text, [total, BAD]));
    const populate = vi.fn(async () => {
      writeFileSync(p.pattern, writeGroundings(readFileSync(p.pattern, "utf8"), [total, shipping]));
      return { tool: "codex" as const, completed: true };
    });
    const outcome = await finalizeCodeRepoSetup(p.root, p.scaffold, { selectedTools: ["codex"], populate, ...quiet });
    expect(populate).toHaveBeenCalledOnce();
    expect(outcome).toEqual({ dropped: [], drift: null });
    expect(extractGroundings(readFileSync(p.pattern, "utf8")).map((entry) => entry.node)).toEqual([total.node, shipping.node]);
  }, 60_000);

  it("drops a new bad reference and keeps a drifted one when no repair agent is available", async () => {
    const p = await recorded();
    writeFileSync(join(p.root, "src", "price.ts"), editedSource());
    const recordedText = readFileSync(p.pattern, "utf8");
    const total = extractGroundings(recordedText)[0]!;
    writeFileSync(p.pattern, writeGroundings(recordedText, [total, BAD]));
    const outcome = await finalizeCodeRepoSetup(p.root, p.scaffold, quiet);
    expect(outcome.dropped.map((entry) => entry.node)).toEqual([BAD.node]);
    expect(extractGroundings(readFileSync(p.pattern, "utf8"))).toEqual([total]);
    // A rerun has nothing to drop and still reports the drift.
    const rerun = await finalizeCodeRepoSetup(p.root, p.scaffold, quiet);
    expect(rerun.dropped).toEqual([]);
    expect(rerun.drift).toMatchObject({ entities: 1 });
  }, 60_000);

  it("treats a fact whose node was removed from the code as drift too", async () => {
    const p = await recorded();
    writeFileSync(join(p.root, "src", "price.ts"), SOURCE.replace(/export function totalPrice[\s\S]*?\n}\n/, ""));
    const before = readFileSync(p.pattern, "utf8");
    const outcome = await finalizeCodeRepoSetup(p.root, p.scaffold, quiet);
    expect(outcome.dropped).toEqual([]);
    expect(outcome.drift).not.toBeNull();
    expect(readFileSync(p.pattern, "utf8")).toBe(before);
  }, 60_000);

  const blockText = (id: string, entries: string) => `<!-- mex:entity
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
${entries}-->
## Claim ${id.slice(-4)}

Prose of ${id.slice(-4)}.
`;
  const item = (g: { node: string; fingerprint: string }, extra = "") => `  - node: ${g.node}\n    fingerprint: ${g.fingerprint}\n${extra}`;
  const A = "mx_01AAAAAAAAAAAAAAAAAAAAAAAA", C = "mx_01CCCCCCCCCCCCCCCCCCCCCCCC", D = "mx_01DDDDDDDDDDDDDDDDDDDDDDDD";
  const PHANTOM = { node: "function:11111111111111111111111111111111", fingerprint: BAD.fingerprint };

  it("verifies block-entity groundings: drift untouched, a new bad one removed with the rest kept", async () => {
    const p = await project();
    const total = p.fact("totalPrice");
    const shipping = p.fact("shippingCost");
    const runtime = await loadGroundingRuntime({ projectRoot: p.root, scaffoldRoot: p.scaffold, aiTools: [] });
    const bodyHash = runtime!.graph.getNode(total.node)!.bodyHash!;
    runtime!.close();
    const committed = "# Pricing\n\n" + [blockText(A, item(total, `    bodyHash: ${bodyHash}\n`)), blockText(C, item(shipping))].join("\n");
    writeFileSync(p.pattern, committed);
    git(p.root, "add", "-A"); git(p.root, "commit", "-q", "-m", "x");
    // The code A is recorded against changes; the agent then adds a bad second grounding to C.
    writeFileSync(join(p.root, "src", "price.ts"), editedSource());
    writeFileSync(p.pattern, committed.replace(item(shipping), item(shipping) + item(PHANTOM)));
    const populate = vi.fn(async (input: { prompt: string }) => {
      expect(input.prompt).toContain(PHANTOM.node);
      expect(input.prompt).not.toContain(total.node);
      return { tool: "codex" as const, completed: true };
    });
    const outcome = await finalizeCodeRepoSetup(p.root, p.scaffold, { selectedTools: ["codex"], populate, ...quiet });
    expect(populate).toHaveBeenCalledOnce();
    expect(outcome.dropped.map((e) => e.node)).toEqual([PHANTOM.node]);
    expect(outcome.drift).not.toBeNull();
    expect(readFileSync(p.pattern, "utf8")).toBe(committed);
  }, 90_000);

  it("removes the only grounding of a new block fact, keeps its prose and says so", async () => {
    const p = await project();
    writeFileSync(p.pattern, "# Pricing\n\n" + blockText(D, item({ node: BAD.node, fingerprint: p.fact("totalPrice").fingerprint })));
    const messages: string[] = [];
    const outcome = await finalizeCodeRepoSetup(p.root, p.scaffold, { onMessage: (m) => messages.push(m) });
    expect(outcome.dropped.map((e) => e.node)).toEqual([BAD.node]);
    const after = readFileSync(p.pattern, "utf8");
    expect(after).toContain("Prose of DDDD.");
    expect(after).not.toContain(BAD.node);
    expect(messages.join("\n")).toContain(`${D} now has no code grounding`);
  }, 90_000);
});
