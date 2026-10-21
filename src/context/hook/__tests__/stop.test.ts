import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildGraph, cleanupProjects, createProject, graphSymbol, writeEntities } from "../../__tests__/fixture.js";
import { loadFlags, mutateFlags } from "../../flags.js";
import { checkSessionReview } from "../../../drift/checkers/session-review.js";
import { ensureContextIndex } from "../../index-store.js";
import { reviewSession } from "../../review.js";
import { loadConfirmed, loadStopAsked, recordConfirmation } from "../../session.js";
import { openGraphReader } from "../../graph-reader.js";
import { composeStopReason, handleStop, STOP_REASON_LIMIT } from "../stop.js";
import { HOOK_LOG_NAME } from "../run.js";
import {
  parseRegroundOutput,
  runSettleWorker,
  settleOnce,
  SETTLE_AGAIN_NAME,
  SETTLE_LOCK_NAME,
  settleRunning,
  startSettle,
  type CliResult,
  type CliRunner,
} from "../settle.js";
import { BILLING_V1, createHookProject, git, promptPayload, toolPayload, type HookProject } from "./fixture.js";

// The in-session review is opt-in; these tests exercise it unless one says otherwise.
beforeEach(() => {
  vi.stubEnv("MEX_HOOK_STOP_REVIEW", "1");
});

afterEach(async () => {
  // A stub worker started in a project may still be exiting; Windows then refuses to remove the directory.
  await new Promise((resolve) => setTimeout(resolve, 150));
  try {
    cleanupProjects();
  } catch {
    // A temporary directory left behind costs nothing.
  }
  vi.unstubAllEnvs();
});

const PROMPT = "The order total looks wrong: does the order total count the items in the basket, and does a discount change it?";
const BILLING_V2 = BILLING_V1.replace("return items.length;", "return items.length + 1;")
  .replace("return total - 1;", "return total - 2;")
  .replace("return `Total: ${total}`;", "return `Total = ${total}`;");

const ok = (stdout = ""): CliResult => ({ code: 0, stdout, stderr: "", ms: 5 });

/** A fake `mex`: records every call and answers refresh and reground like the real commands. */
function fakeCli(options: { refresh?: CliResult; failing?: string[]; onRefresh?: () => void } = {}): { run: CliRunner; calls: string[][] } {
  const calls: string[][] = [];
  const run: CliRunner = (args) => {
    calls.push([...args]);
    if (args[0] === "graph") {
      options.onRefresh?.();
      return options.refresh ?? ok();
    }
    if (args[0] === "wiki") {
      const ids = args.slice(2).filter((a) => !a.startsWith("--") && a.startsWith("mx_"));
      const entities = ids.map((id) => ({ entityId: id, ok: !(options.failing ?? []).includes(id), diagnostics: [{ message: "refused: fake" }] }));
      return ok(JSON.stringify({ ok: true, data: { entities, applied: entities.filter((e) => e.ok).length }, diagnostics: [] }));
    }
    return ok();
  };
  return { run, calls };
}

async function startSession(project: HookProject, session: string): Promise<void> {
  // The first event of a session pins where the code and the prose stood at HEAD.
  await project.run(promptPayload(session, PROMPT));
}

function editProse(project: HookProject, from: string, to: string): void {
  const path = join(project.fx.context.scaffoldRoot, "context", "billing.md");
  writeFileSync(path, readFileSync(path, "utf8").replace(from, to));
}

const TOTALS_PROSE = "so a discount never changes it.";

describe("refresh and integrity without a touched fact", () => {
  it("refreshes indexed source with no linked fact and never regrounds it", async () => {
    const project = await createHookProject();
    // This indexed function has no knowledge grounding.
    project.fx.writeSource("src/report.ts", "export function buildReport(): number { return 42; }\n");
    const cli = fakeCli();
    const pass = await settleOnce(project.fx.context, { sessionId: "source-only", runCli: cli.run });
    expect(pass).toMatchObject({ touched: 0, eligible: 0, refresh: { code: 0 }, reground: null });
    expect(cli.calls.map((args) => args.slice(0, 2))).toEqual([["graph", "refresh"]]);
    const start = { entry: stubWorker(project, 0) };
    const stop = await handleStop({ root: project.fx.context, sessionId: "source-only", stopHookActive: false, start });
    expect(stop).toMatchObject({ stdout: "", log: { touched: 0, settle: "started" } });
    expect((await handleStop({ root: project.fx.context, sessionId: "source-only", stopHookActive: false, start })).log).toMatchObject({ settle: "unchanged" });
  });

  it.each(["heading", "id"])("reports a damaged %s after the entity vanishes from the index", async (damage) => {
    const project = await createHookProject();
    const path = join(project.fx.context.scaffoldRoot, "context/billing.md");
    const before = readFileSync(path, "utf8");
    writeFileSync(path, damage === "heading" ? before.replace("### Order totals count the items", "Order totals count the items") : before.replace(project.ids.total, "broken-id"));
    await ensureContextIndex(project.fx.context, "force");
    const stop = await handleStop({ root: project.fx.context, sessionId: "damage", stopHookActive: false });
    expect(stop.log["damaged"]).toEqual(expect.arrayContaining([expect.objectContaining({ code: "WIKI_ENTITY_DAMAGED", entity: expect.objectContaining({ id: project.ids.total }) })]));
    expect(checkSessionReview(project.fx.root, project.fx.context.scaffoldRoot)).toEqual(expect.arrayContaining([expect.objectContaining({ code: "WIKI_ENTITY_DAMAGED", entity: expect.objectContaining({ id: project.ids.total }) })]));
  });

  it("does not treat an unresolved grounding as a file-level code review", async () => {
    const project = await createHookProject();
    const path = join(project.fx.context.scaffoldRoot, "context/billing.md");
    writeFileSync(path, readFileSync(path, "utf8").replace(/node: [^\r\n]+/g, "node: function:missing"));
    project.fx.writeSource("src/billing.ts", BILLING_V2);
    const cli = fakeCli();
    const pass = await settleOnce(project.fx.context, { sessionId: "unresolved", runCli: cli.run });
    expect(pass).toMatchObject({ touched: 0, eligible: 0, reground: null, refresh: { code: 0 } });
    expect(Object.keys(loadFlags(project.fx.context.localDir).entities)).toHaveLength(0);
    // Old flags cannot turn a never-resolved link into a file-level review either.
    mutateFlags(project.fx.context.localDir, (flags) => {
      flags.entities[project.ids.total] = { title: "Order totals", file: "context/billing.md", line: 1,
        why: "file changed", status: "flagged", since: "2026-01-01", updatedAt: "2026-01-01" };
    });
    expect(checkSessionReview(project.fx.root, project.fx.context.scaffoldRoot)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "GROUNDING_UNVERIFIED", verdict: "unverified", entity: expect.objectContaining({ id: project.ids.total }) }),
    ]));
    expect(checkSessionReview(project.fx.root, project.fx.context.scaffoldRoot).some((issue) => issue.code === "GROUNDING_REVIEW")).toBe(false);
  });
});

describe("the rule: only edited or confirmed entities are re-recorded", () => {
  it("re-records the edited and the confirmed, and leaves the merely touched flagged", async () => {
    const project = await createHookProject();
    await startSession(project, "s-rule");
    project.fx.writeSource("src/billing.ts", BILLING_V2);
    // total: prose rewritten. discount: confirmed. invoice: touched and left alone.
    editProse(project, TOTALS_PROSE, `${TOTALS_PROSE} Now it also counts one extra.`);
    recordConfirmation(project.fx.context.localDir, "s-rule", [project.ids.discount], "still one flat unit per the new rule");

    const cli = fakeCli();
    const pass = await settleOnce(project.fx.context, { sessionId: "s-rule", runCli: cli.run });

    expect(pass).toMatchObject({ touched: 3, eligible: 2, flagged: 1, refresh: { code: 0 }, reground: { ids: 2, ok: 2, failed: 0 } });
    // One refresh, then ONE batch reground of exactly the two vouched-for ids.
    expect(cli.calls.map((c) => c.slice(0, 2).join(" "))).toEqual(["graph refresh", "wiki reground"]);
    const reground = cli.calls[1]!;
    expect(reground.filter((a) => a.startsWith("mx_")).sort()).toEqual([project.ids.total, project.ids.discount].sort());
    expect(reground).not.toContain(project.ids.invoice);
    expect(reground).toContain("--apply");

    const flags = loadFlags(project.fx.context.localDir);
    expect(Object.keys(flags.entities)).toEqual([project.ids.invoice]);
    expect(flags.entities[project.ids.invoice]).toMatchObject({ status: "flagged", file: "context/billing.md" });
    expect(Object.keys(flags.reconciled).sort()).toEqual([project.ids.total, project.ids.discount].sort());
  });

  it("an entity that was only touched is never re-recorded, however often the worker runs", async () => {
    const project = await createHookProject();
    await startSession(project, "s-touched");
    project.fx.writeSource("src/billing.ts", BILLING_V2);
    const cli = fakeCli();
    for (let i = 0; i < 3; i += 1) await settleOnce(project.fx.context, { sessionId: "s-touched", runCli: cli.run });
    expect(cli.calls.filter((c) => c[0] === "wiki")).toEqual([]);
    expect(Object.keys(loadFlags(project.fx.context.localDir).entities)).toHaveLength(3);
  });

  it("seeing the fact, reading its code and a changed packet are not confirmations", async () => {
    const project = await createHookProject();
    await startSession(project, "s-seen");
    project.fx.writeSource("src/billing.ts", BILLING_V2);
    await project.run(toolPayload("s-seen", "Read", { file_path: join(project.fx.root, "src/billing.ts") }));
    await project.run(toolPayload("s-seen", "Edit", { file_path: join(project.fx.root, "src/billing.ts") }));
    const cli = fakeCli();
    const pass = await settleOnce(project.fx.context, { sessionId: "s-seen", runCli: cli.run });
    expect(pass.eligible).toBe(0);
    expect(cli.calls.some((c) => c[0] === "wiki")).toBe(false);
  });

  it("flagged entities read as changed in the packets that follow, before the graph is refreshed", async () => {
    const project = await createHookProject();
    await startSession(project, "s-warn");
    project.fx.writeSource("src/billing.ts", BILLING_V2);
    await handleStop({ root: project.fx.context, sessionId: "s-warn", stopHookActive: true, start: { entry: stubWorker(project, 0) } });
    const text = project.text(await project.run(toolPayload("s-new", "Read", { file_path: join(project.fx.root, "src/billing.ts") })));
    expect(text).toContain("Order totals count the items");
    expect(text).toMatch(/changed/);
    expect(text).not.toContain("(fresh");
  });

  it("a later session that confirms a flagged entity makes it eligible at once", async () => {
    const project = await createHookProject();
    await startSession(project, "s-first");
    project.fx.writeSource("src/billing.ts", BILLING_V2);
    await settleOnce(project.fx.context, { sessionId: "s-first", runCli: fakeCli().run });
    expect(Object.keys(loadFlags(project.fx.context.localDir).entities)).toHaveLength(3);

    const { runContextConfirm } = await import("../../cli.js");
    const out: string[] = [];
    await runContextConfirm({ write: (l) => out.push(l), writeError: (l) => out.push(l), setExitCode: () => undefined, cwd: project.fx.root }, [project.ids.invoice, "mx_UNKNOWN"], { json: true, session: "s-later" });
    expect(JSON.parse(out.join("\n")).data).toMatchObject({ confirmed: [project.ids.invoice], unknown: ["mx_UNKNOWN"] });
    expect(loadConfirmed(project.fx.context.localDir, "s-later")[project.ids.invoice]).toBeDefined();

    const cli = fakeCli();
    await settleOnce(project.fx.context, { sessionId: "s-other", runCli: cli.run });
    expect(cli.calls[1]!.filter((a) => a.startsWith("mx_"))).toEqual([project.ids.invoice]);
  });
});

describe("a complete-list claim stays flagged (the Hono CORS renewal)", () => {
  async function createCorsProject() {
    const project = await createHookProject();
    const fx = project.fx;
    fx.writeSource("src/cors.ts", ["export function corsHeaders(): string[] {", '  return ["Access-Control-Allow-Origin", "Access-Control-Allow-Methods"];', "}", ""].join("\n"));
    await buildGraph(fx);
    const cors = graphSymbol(fx, "corsHeaders");
    const [id] = writeEntities(fx, "context/cors.md", [
      {
        title: "The CORS middleware sets exactly two headers",
        body: "The middleware sets exactly Access-Control-Allow-Origin and Access-Control-Allow-Methods and no other CORS header, whatever the options say.",
        groundings: [{ node: cors.id, file: cors.file, bodyHash: cors.bodyHash }],
      },
    ]);
    await ensureContextIndex(fx.context, "force");
    git(fx.root, "add", "-A");
    git(fx.root, "commit", "-q", "-m", "cors");
    return { project, id: id! };
  }

  it("adding a header touches the claim; without edit or confirmation it is flagged, not re-recorded", async () => {
    const { project, id } = await createCorsProject();
    await startSession(project, "s-cors");
    project.fx.writeSource("src/cors.ts", ["export function corsHeaders(): string[] {", '  return ["Access-Control-Allow-Origin", "Access-Control-Allow-Methods", "Access-Control-Allow-Headers"];', "}", ""].join("\n"));

    const cli = fakeCli();
    const pass = await settleOnce(project.fx.context, { sessionId: "s-cors", runCli: cli.run });
    expect(pass).toMatchObject({ touched: 1, eligible: 0, flagged: 1 });
    expect(cli.calls.some((c) => c[0] === "wiki")).toBe(false);
    expect(loadFlags(project.fx.context.localDir).entities[id]).toMatchObject({ status: "flagged" });
    expect(readFileSync(join(project.fx.context.scaffoldRoot, "context", "cors.md"), "utf8")).toContain("bodyHash");

    // The Stop hook asks about it by id, with the exact command that settles it.
    const stop = await handleStop({ root: project.fx.context, sessionId: "s-cors", stopHookActive: false, start: { entry: stubWorker(project, 0) } });
    const reason = (JSON.parse(stop.stdout) as { reason: string }).reason;
    expect(reason).toContain(id);
    expect(reason).toContain(`mex context confirm ${id} --session s-cors`);
  });
});

describe("the Stop hook", () => {
  it("by default never blocks or injects, yet flags, logs and settles", async () => {
    vi.stubEnv("MEX_HOOK_STOP_REVIEW", "");
    const project = await createHookProject();
    await startSession(project, "s-quiet-stop");
    project.fx.writeSource("src/billing.ts", BILLING_V2);
    const stop = await handleStop({ root: project.fx.context, sessionId: "s-quiet-stop", stopHookActive: false, start: { entry: stubWorker(project, 0) } });
    expect(stop.stdout).toBe("");
    expect(stop.log).toMatchObject({ settle: "started", blocked: false, unvouched: expect.arrayContaining(Object.values(project.ids)) });
    expect(loadStopAsked(project.fx.context.localDir, "s-quiet-stop")).toBe(false);
    // `mex context status` and the packets read these.
    expect(Object.values(loadFlags(project.fx.context.localDir).entities).map((e) => e.status)).toEqual(["flagged", "flagged", "flagged"]);
  });

  it("blocks once with a compact list, then never again in the session", async () => {
    const project = await createHookProject();
    await startSession(project, "s-block");
    project.fx.writeSource("src/billing.ts", BILLING_V2);

    const blocked = await handleStop({ root: project.fx.context, sessionId: "s-block", stopHookActive: false, start: { entry: stubWorker(project, 0) } });
    // The block starts the worker as well: a host may end the session without delivering it.
    expect(blocked.log).toMatchObject({ blocked: true, settle: "started" });
    const first = JSON.parse(blocked.stdout) as { decision: string; reason: string };
    expect(first.decision).toBe("block");
    expect(first.reason.length).toBeLessThanOrEqual(STOP_REASON_LIMIT);
    for (const id of Object.values(project.ids)) expect(first.reason).toContain(id);
    expect(first.reason).toContain("mex context confirm");
    expect(loadStopAsked(project.fx.context.localDir, "s-block")).toBe(true);
    expect(Object.keys(loadFlags(project.fx.context.localDir).entities)).toHaveLength(3);

    // Asked once: the same session is not asked again, and the unchanged review needs no second run.
    const again = await handleStop({ root: project.fx.context, sessionId: "s-block", stopHookActive: false, start: { entry: stubWorker(project, 0) } });
    expect(again.stdout).toBe("");
    expect(again.log).toMatchObject({ settle: "unchanged" });

    // A confirmation after the block changes the review, so the next Stop runs the worker again.
    recordConfirmation(project.fx.context.localDir, "s-block", [project.ids.discount]);
    const answered = await handleStop({ root: project.fx.context, sessionId: "s-block", stopHookActive: true, start: { entry: stubWorker(project, 0) } });
    expect(answered.stdout).toBe("");
    expect(answered.log).toMatchObject({ settle: "started", eligible: [project.ids.discount] });
  });

  it("does not block when the hook is already continuing from a block", async () => {
    const project = await createHookProject();
    await startSession(project, "s-active");
    project.fx.writeSource("src/billing.ts", BILLING_V2);
    const stop = await handleStop({ root: project.fx.context, sessionId: "s-active", stopHookActive: true, start: { entry: stubWorker(project, 0) } });
    expect(stop.stdout).toBe("");
    expect(loadStopAsked(project.fx.context.localDir, "s-active")).toBe(false);
  });

  it("context.stopReview off never asks, yet still flags and settles", async () => {
    const project = await createHookProject();
    writeFileSync(join(project.fx.context.scaffoldRoot, "config.json"), JSON.stringify({ context: { stopReview: "off" } }));
    await startSession(project, "s-off");
    project.fx.writeSource("src/billing.ts", BILLING_V2);
    const stop = await handleStop({ root: project.fx.context, sessionId: "s-off", stopHookActive: false, start: { entry: stubWorker(project, 0) } });
    expect(stop.stdout).toBe("");
    expect(stop.log).toMatchObject({ settle: "started", flagged: expect.any(Array) });
    expect(Object.keys(loadFlags(project.fx.context.localDir).entities)).toHaveLength(3);
  });

  it("asks nothing when the entities were edited or confirmed, and skips the worker for an unchanged diff", async () => {
    const project = await createHookProject();
    await startSession(project, "s-done");
    project.fx.writeSource("src/billing.ts", BILLING_V2);
    editProse(project, TOTALS_PROSE, `${TOTALS_PROSE} Now it also counts one extra.`);
    recordConfirmation(project.fx.context.localDir, "s-done", [project.ids.discount, project.ids.invoice]);
    const start = { entry: stubWorker(project, 0) };
    const first = await handleStop({ root: project.fx.context, sessionId: "s-done", stopHookActive: false, start });
    expect(first.stdout).toBe("");
    expect(first.log).toMatchObject({ settle: "started", eligible: expect.arrayContaining([project.ids.total, project.ids.discount, project.ids.invoice]) });
    const second = await handleStop({ root: project.fx.context, sessionId: "s-done", stopHookActive: false, start });
    expect(second.log).toMatchObject({ settle: "unchanged" });
  });

  it("is silent and starts nothing when no linked code changed", async () => {
    const project = await createHookProject();
    await startSession(project, "s-clean");
    const stop = await handleStop({ root: project.fx.context, sessionId: "s-clean", stopHookActive: false, start: { entry: stubWorker(project, 0) } });
    expect(stop).toMatchObject({ stdout: "", log: { touched: 0 } });
    expect(existsSync(join(project.fx.context.localDir, SETTLE_LOCK_NAME))).toBe(false);
  });

  it("keeps the question under the limit however many entities are touched", async () => {
    const project = await createHookProject({ extraFacts: 40 });
    await startSession(project, "s-many");
    project.fx.writeSource("src/billing.ts", BILLING_V2);
    const { index } = await ensureContextIndex(project.fx.context, "if-stale");
    const { reader } = openGraphReader(project.fx.context.scaffoldRoot);
    const review = reviewSession({ root: project.fx.context, index, reader, sessionId: "s-many" })!;
    reader?.close();
    expect(review.flagged.length).toBeGreaterThan(30);
    const reason = composeStopReason(review.flagged, "s-many");
    expect(reason.length).toBeLessThanOrEqual(STOP_REASON_LIMIT);
    expect(reason).toMatch(/\(\+\d+ more: mex context status\)/);
    expect(reason).toContain("mex context confirm mx_");
  });
});

/** A worker that stays alive for `seconds` (0: exits at once), standing in for `mex-hook settle`. */
function stubWorker(project: HookProject, seconds: number): string {
  const file = join(project.fx.root, `stub-worker-${seconds}.mjs`);
  writeFileSync(file, `await new Promise((resolve) => setTimeout(resolve, ${seconds * 1000}));\n`);
  return file;
}

describe("the settle lock and again-marker", () => {
  it("a second start while one runs leaves the again-marker; a dead lock is taken over", async () => {
    const project = await createHookProject();
    const local = project.fx.context.localDir;
    mkdirSync(local, { recursive: true });
    const entry = stubWorker(project, 5);

    expect(await startSettle(project.fx.context, "s-lock", { entry })).toBe("started");
    expect(settleRunning(local)).toBe(true);
    const pid = Number(readFileSync(join(local, SETTLE_LOCK_NAME), "utf8"));
    try {
      expect(await startSettle(project.fx.context, "s-lock", { entry })).toBe("queued");
      expect(existsSync(join(local, SETTLE_AGAIN_NAME))).toBe(true);
    } finally {
      process.kill(pid);
    }

    writeFileSync(join(local, SETTLE_LOCK_NAME), "2147483646\n");
    expect(settleRunning(local)).toBe(false);
    const quick = stubWorker(project, 0);
    expect(await startSettle(project.fx.context, "s-lock", { entry: quick })).toBe("started");
  });

  it("the worker goes round again when another Stop asked, and releases the lock when done", async () => {
    const project = await createHookProject();
    await startSession(project, "s-again");
    project.fx.writeSource("src/billing.ts", BILLING_V2);
    const local = project.fx.context.localDir;
    let asked = false;
    const cli = fakeCli({
      onRefresh: () => {
        if (asked) return;
        asked = true;
        writeFileSync(join(local, SETTLE_AGAIN_NAME), "again\n");
      },
    });
    await runSettleWorker(project.fx.root, { sessionId: "s-again", runCli: cli.run });
    expect(cli.calls.filter((c) => c[0] === "graph")).toHaveLength(2);
    expect(existsSync(join(local, SETTLE_LOCK_NAME))).toBe(false);
    expect(existsSync(join(local, SETTLE_AGAIN_NAME))).toBe(false);
    const events = readFileSync(join(local, HOOK_LOG_NAME), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { event: string; loop?: number });
    expect(events.filter((e) => e.event === "settle").map((e) => e.loop)).toEqual([0, 1]);
  });
});

describe("the settle worker's refresh log", () => {
  it("logs how the graph refresh worked, and why when it had to extract in full", async () => {
    const project = await createHookProject();
    await startSession(project, "s-mode");
    project.fx.writeSource("src/billing.ts", BILLING_V2);
    const stdout = JSON.stringify({
      state: "succeeded",
      refresh: { mode: "full", fallbackReason: "a non-corpus compiler input changed", filesChanged: 1, filesReextracted: 12, publication: "full", filesRewritten: 12 },
    });
    const cli = fakeCli({ refresh: ok(stdout) });
    await runSettleWorker(project.fx.root, { sessionId: "s-mode", runCli: cli.run });

    expect(cli.calls[0]).toEqual(["graph", "refresh", "--json"]);
    const log = readFileSync(join(project.fx.context.localDir, HOOK_LOG_NAME), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(log.find((e) => e.event === "settle")).toMatchObject({
      refresh: { code: 0, mode: "full", reason: "a non-corpus compiler input changed", changed: 1, reextracted: 12 },
    });
  });

  it("still settles when the refresh output carries no mode", async () => {
    const project = await createHookProject();
    await startSession(project, "s-nomode");
    project.fx.writeSource("src/billing.ts", BILLING_V2);
    const pass = await settleOnce(project.fx.context, { sessionId: "s-nomode", runCli: fakeCli().run });
    expect(pass.refresh).toEqual({ code: 0, ms: 5 });
  });
});

describe("the settle worker's failures", () => {
  it("logs the refresh failure with its stderr and does not re-record anything", async () => {
    const project = await createHookProject();
    await startSession(project, "s-fail");
    project.fx.writeSource("src/billing.ts", BILLING_V2);
    recordConfirmation(project.fx.context.localDir, "s-fail", [project.ids.total]);
    const cli = fakeCli({ refresh: { code: 1, stdout: "", stderr: "graph refresh: out of memory in parser", ms: 1234 } });
    await runSettleWorker(project.fx.root, { sessionId: "s-fail", runCli: cli.run });

    expect(cli.calls.map((c) => c[0])).toEqual(["graph"]);
    const log = readFileSync(join(project.fx.context.localDir, HOOK_LOG_NAME), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(log.find((e) => e.event === "settle-refresh-failed")).toMatchObject({ code: 1, ms: 1234, stderr: "graph refresh: out of memory in parser" });
    expect(log.find((e) => e.event === "settle")).toMatchObject({ skipped: "refresh-failed", refresh: { code: 1, ms: 1234 } });
    // The entities stay flagged or eligible for the next run; nothing was reconciled.
    const flags = loadFlags(project.fx.context.localDir);
    expect(Object.keys(flags.entities)).toHaveLength(3);
    expect(flags.reconciled).toEqual({});
  });

  it("keeps the failing entity flagged with the reason and clears the others", async () => {
    const project = await createHookProject();
    await startSession(project, "s-partial");
    project.fx.writeSource("src/billing.ts", BILLING_V2);
    recordConfirmation(project.fx.context.localDir, "s-partial", [project.ids.total, project.ids.discount]);
    const cli = fakeCli({ failing: [project.ids.discount] });
    const pass = await settleOnce(project.fx.context, { sessionId: "s-partial", runCli: cli.run });
    // The log names the refused id and why, so a failed reground can be read from the log alone.
    expect(pass.reground).toMatchObject({ ids: 2, ok: 1, failed: 1, refused: [{ id: project.ids.discount, error: "refused: fake" }] });
    const flags = loadFlags(project.fx.context.localDir);
    expect(flags.entities[project.ids.total]).toBeUndefined();
    expect(flags.entities[project.ids.discount]).toMatchObject({ status: "eligible", error: "refused: fake" });
  });
});

describe("parsing and running", () => {
  it("reads the per-id outcome of a batch and of a single id", () => {
    const batch = JSON.stringify({ data: { entities: [{ entityId: "a", ok: true }, { entityId: "b", ok: false, diagnostics: [{ message: "nope" }] }] } });
    expect(parseRegroundOutput(batch, ["a", "b"])).toEqual([{ id: "a", ok: true }, { id: "b", ok: false, error: "nope" }]);
    const single = JSON.stringify({ data: { entityId: "a", links: [], apply: { applied: true } }, diagnostics: [] });
    expect(parseRegroundOutput(single, ["a"])).toEqual([{ id: "a", ok: true }]);
    expect(parseRegroundOutput("not json", ["a", "b"]).map((o) => o.ok)).toEqual([false, false]);
  });
});

describe("hook events around the Stop", () => {
  it("a Stop in a project nobody changed is silent", async () => {
    const project = await createHookProject();
    expect(await project.run({ hook_event_name: "Stop", session_id: "s-quiet" })).toBe("");
  });
});

describe("the prose baseline", () => {
  it("an older base record without prose hashes learns them at the next prompt, so a later edit counts", async () => {
    const project = await createHookProject();
    await startSession(project, "s-old");
    const basePath = join(project.fx.context.localDir, "context-base.json");
    const old = JSON.parse(readFileSync(basePath, "utf8")) as Record<string, unknown>;
    delete old["prose"];
    writeFileSync(basePath, JSON.stringify(old));

    await startSession(project, "s-new");
    expect(Object.keys((JSON.parse(readFileSync(basePath, "utf8")) as { prose: Record<string, string> }).prose)).toHaveLength(3);

    project.fx.writeSource("src/billing.ts", BILLING_V2);
    editProse(project, TOTALS_PROSE, `${TOTALS_PROSE} Now it also counts one extra.`);
    const pass = await settleOnce(project.fx.context, { sessionId: "s-new", runCli: fakeCli().run });
    expect(pass).toMatchObject({ touched: 3, eligible: 1, flagged: 2 });
  });
});

describe("check keeps session-touched entities in view", () => {
  it("reports re-recorded and flagged entities as GROUNDING_REVIEW until the prose is revised or confirmed", async () => {
    const { checkSessionReview } = await import("../../../drift/checkers/session-review.js");
    const { clearSessionReviews } = await import("../../review.js");
    const { runContextConfirm } = await import("../../cli.js");
    const project = await createHookProject();
    await startSession(project, "s-review");
    project.fx.writeSource("src/billing.ts", BILLING_V2);
    // total and discount are confirmed inside the session; invoice is left alone.
    recordConfirmation(project.fx.context.localDir, "s-review", [project.ids.total, project.ids.discount]);
    const pass = await settleOnce(project.fx.context, { sessionId: "s-review", runCli: fakeCli().run });
    expect(pass.reground).toMatchObject({ ok: 2, failed: 0 });

    // The re-record made their links current, so drift checks fall silent: the review mark keeps them in check.
    const review = () => checkSessionReview(project.fx.root, project.fx.context.scaffoldRoot);
    expect(review().map((issue) => [issue.code, issue.severity, issue.entity?.id]).sort()).toEqual(
      [project.ids.total, project.ids.discount, project.ids.invoice].map((id) => ["GROUNDING_REVIEW", "warning", id]).sort());
    expect(review().every((issue) => issue.file === ".mex/context/billing.md")).toBe(true);

    // A revised prose clears its mark (what `mex sync` does each cycle)...
    editProse(project, TOTALS_PROSE, `${TOTALS_PROSE} Now it also counts one extra.`);
    const { index } = await ensureContextIndex(project.fx.context, "if-stale");
    expect(clearSessionReviews(project.fx.context.localDir, index)).toEqual([project.ids.total]);
    // ...and so does a confirmation after the re-record.
    await runContextConfirm({ write: () => undefined, writeError: () => undefined, setExitCode: () => undefined, cwd: project.fx.root }, [project.ids.discount], { json: true });
    expect(review().map((issue) => issue.entity?.id)).toEqual([project.ids.invoice]);
  });
});
