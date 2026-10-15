import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildGraph, cleanupProjects, createProject, graphSymbol, writeEntities } from "../../__tests__/fixture.js";
import { loadFlags } from "../../flags.js";
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
  it("blocks once with a compact list, then never again in the session", async () => {
    const project = await createHookProject();
    await startSession(project, "s-block");
    project.fx.writeSource("src/billing.ts", BILLING_V2);

    const first = JSON.parse(await project.run({ hook_event_name: "Stop", session_id: "s-block" })) as { decision: string; reason: string };
    expect(first.decision).toBe("block");
    expect(first.reason.length).toBeLessThanOrEqual(STOP_REASON_LIMIT);
    for (const id of Object.values(project.ids)) expect(first.reason).toContain(id);
    expect(first.reason).toContain("mex context confirm");
    expect(loadStopAsked(project.fx.context.localDir, "s-block")).toBe(true);
    expect(Object.keys(loadFlags(project.fx.context.localDir).entities)).toHaveLength(3);
    const log = readFileSync(join(project.fx.context.localDir, HOOK_LOG_NAME), "utf8");
    expect(log).toContain('"event":"stop-block"');

    // Asked once: the same session is not asked again.
    const again = await handleStop({ root: project.fx.context, sessionId: "s-block", stopHookActive: false, start: { entry: stubWorker(project, 0) } });
    expect(again.stdout).toBe("");
    expect(again.log).toMatchObject({ settle: "started" });
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
    expect(pass.reground).toMatchObject({ ids: 2, ok: 1, failed: 1 });
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
