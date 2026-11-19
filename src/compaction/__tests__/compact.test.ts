import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { additionalUninstallPaths, uninstallAgents } from "../../install/index.js";
import { openRecord, openRecordReadOnly } from "../../record/index.js";
import { projectIdentity, shortHash } from "../../record/project.js";
import { HOOKS_SCHEMA_VERSION } from "../../record/schema.js";
import { LEDGER_PRICE_PROFILE } from "../../ledger/pricing.js";
import { withContainedArtifactLock } from "../../team/artifacts/filesystem.js";
import { acceptCompact, compactStates, prepareCompact, reviewManagedCompaction, undoManagedCompaction, type CompactSelection } from "../control.js";
import { compactEvidence, findWindowOffer, measureSession, minimumCapacity } from "../evidence.js";
import { publishCompactOffers } from "../notices.js";
import type { CompactAgent } from "../settings.js";
import { pauseReason, windowOffer, type SessionEvidence } from "../policy.js";

const paths: string[] = [];
const disposers: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) dispose();
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mex-compact-")));
  paths.push(root);
  const checkout = join(root, "repo"), home = join(root, ".mex"), claude = join(root, "claude"), codex = join(root, "codex");
  mkdirSync(checkout);
  mkdirSync(claude);
  vi.stubEnv("CLAUDE_CONFIG_DIR", claude);
  vi.stubEnv("CODEX_HOME", codex);
  const writer = openRecord({ home, projectPath: checkout, isNetwork: () => false });
  disposers.push(() => writer.close());
  const selection: CompactSelection = { agent: "claude-code", checkout, model: "claude-opus-4-6", scope: "user", choice: "window", value: 240_000 };
  const off = () => withContainedArtifactLock(home, "install", ".install.lock", () => undoManagedCompaction(writer));
  return { checkout, home, claude, codex, writer, selection, off };
}

function hookStore(f: ReturnType<typeof fixture>) {
  const hooks = new DatabaseSync(f.writer.location.hooks);
  disposers.push(() => hooks.close());
  const schema = join(import.meta.dirname, "../../../native/record/schema/hooks");
  for (const file of readdirSync(schema).filter(s => s.endsWith(".sql")).sort()) hooks.exec(readFileSync(join(schema, file), "utf8"));
  hooks.exec(`PRAGMA user_version=${HOOKS_SCHEMA_VERSION}`);
  return hooks;
}

function observedSession(f: ReturnType<typeof fixture>, hooks: DatabaseSync, id: string, agent: CompactAgent,
  at: number, body: string, checkout = f.checkout) {
  const project = f.writer.checkout(checkout)!.project_id, stamp = new Date(at).toISOString();
  hooks.prepare("INSERT INTO sessions VALUES(?,?,?,?,?,?,0)").run(id, agent, project, checkout, stamp, stamp);
  const hostDir = agent === "claude-code" ? join(f.claude, "projects", "test") : join(f.codex, "sessions");
  const metaDir = join(f.writer.location.directory, "filter-sessions");
  mkdirSync(hostDir, { recursive: true });
  mkdirSync(metaDir, { recursive: true });
  const transcript = join(hostDir, agent === "claude-code" ? id + ".jsonl" : "rollout-fixture-" + id + ".jsonl");
  writeFileSync(transcript, body);
  writeFileSync(join(metaDir, shortHash(project + "\0" + id) + ".json"), JSON.stringify({
    version: 1, project_id: project, checkout, agent, session_id: id, seen_at: stamp, finished: true, transcript,
  }));
  return transcript;
}

const line = (at: number, event: object) => JSON.stringify({ timestamp: new Date(at).toISOString(), ...event }) + "\n";
const boundary = (at: number) => line(at, { type: "system", subtype: "compact_boundary" });
function claudeCall(at: number, size: number, extra = {}, model = "claude-opus-4-6-20260401[1m]") {
  return line(at, { type: "assistant", message: { model, usage: { input_tokens: 11, cache_creation_input_tokens: 19,
    cache_read_input_tokens: size - 30, output_tokens: 40 }, ...extra } });
}
const session = (id: string, after = 80_000, peak = 360_000, capacity = 1_000_000): SessionEvidence =>
  ({ session: id, model: "claude-opus-4-6", capacity, peak, compactions: [{ at: 1, tokensAfter: after }] });
const model = "claude-opus-4-6";

describe("measured compaction eligibility", () => {
  it("needs three distinct long sessions on the model and uses a median session", () => {
    expect(windowOffer([session("a"), session("b"), session("b"), session("c", 80_000, 300_000),
      session("d", 80_000, 350_000, 500_000)], model)).toBeUndefined();
    expect(windowOffer([session("a", 60_000), session("b", 82_000), session("c", 455_000)], model)).toMatchObject({
      sessions: 3, samples: 3, postCompaction: 82_000, window: 246_000,
    });
    expect(windowOffer(["a", "b", "c"].map(id => session(id, 30_000)), model)?.window).toBe(200_000);
    expect(windowOffer(["a", "b", "c"].map(id => session(id, 200_000)), model)?.window).toBe(500_000);
    expect(windowOffer(["a", "b", "c"].map(id => ({ ...session(id), compactions: [] })), model)).toBeUndefined();
    expect(minimumCapacity("codex")).toBe(950_000);
  });

  it("counts cache in Claude context and drops a post-compaction sample after a model switch", () => {
    const at = Date.now();
    const data = claudeCall(at, 360_000) + boundary(at + 1) + claudeCall(at + 2, 80_000)
      + boundary(at + 3) + claudeCall(at + 4, 50_000, {}, "claude-sonnet-4-6");
    expect(measureSession(data, "a", "claude-code")).toEqual([
      { session: "a", model, capacity: 1_000_000, peak: 360_000, compactions: [{ at: at + 1, tokensAfter: 80_000 }, { at: at + 3 }] },
      { session: "a", model: "claude-sonnet-4-6", capacity: 1_000_000, peak: 50_000, compactions: [] },
    ]);
  });

  it("resolves the dated 1M variant to the canonical settings key", () => {
    const dated = "claude-opus-4-6-20260401[1m]";
    const eligible = ["a", "b", "c"].map(id => session(id));
    expect(findWindowOffer(eligible, "claude-code", dated)?.model).toBe("claude-opus-4-6");
  });

  it("uses Codex's last request and usable window, skips reset and ignores a truncated record", () => {
    const at = Date.now();
    const usage = (input: number) => line(at, { type: "event_msg", payload: { type: "token_count", info: { model_context_window: 950_000,
      last_token_usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: 40 },
      total_token_usage: { input_tokens: 2_000_000, output_tokens: 420 } } } });
    const data = line(at, { type: "turn_context", payload: { model: "gpt-fixture" } }) + usage(310_000)
      + line(at + 1, { type: "compacted", payload: {} }) + usage(0) + usage(78_000) + usage(999_000).trimEnd();
    expect(measureSession(data, "b", "codex")).toEqual([{ session: "b", model: "gpt-fixture", capacity: 950_000, peak: 310_000,
      compactions: [{ at: at + 1, tokensAfter: 78_000 }] }]);
  });
});

describe("restore local host settings", () => {
  it("binds consent to the current settings and restores Claude bytes and permissions", async () => {
    const f = fixture(), path = join(f.claude, "settings.json");
    const original = Buffer.from('\uFEFF{ "modelSettings": { "claude-opus-4-6": { "autoCompactWindow": "auto", "effortLevel": "high" }}, "other": 1 }\r\n');
    writeFileSync(path, original, { mode: 0o640 });
    const stale = prepareCompact(f.selection);
    writeFileSync(path, "{ \"other\": 2 }\n");
    await expect(acceptCompact(f.writer, f.selection, stale.offer)).rejects.toThrow("offer changed");
    writeFileSync(path, original);
    expect(await acceptCompact(f.writer, f.selection, prepareCompact(f.selection).offer)).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ modelSettings: { [model]: { effortLevel: "high", autoCompactWindow: 240_000 } }, other: 1 });
    expect(additionalUninstallPaths({ home: f.home })).toContain(path);
    expect((await f.off()).restored).toEqual([path]);
    expect(readFileSync(path)).toEqual(original);
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o640);
    expect(existsSync(join(f.home, "compaction-watch"))).toBe(false);
  });

  it("keeps separate later settings and refuses to undo a manually changed value", async () => {
    const f = fixture(), path = join(f.claude, "settings.json");
    const selected: CompactSelection = { ...f.selection, choice: "idle", value: 150_000 };
    await acceptCompact(f.writer, selected, prepareCompact(selected).offer);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ env: { CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS: "150000" } });
    writeFileSync(path, JSON.stringify({ env: { CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS: "160000" }, theme: "dark" }));
    expect((await f.off()).conflicts).toEqual([path]);
    writeFileSync(path, JSON.stringify({ env: { CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS: "150000" }, theme: "dark" }));
    expect((await f.off()).restored).toEqual([path]);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ theme: "dark" });
  });

  it("applies Codex post-turn config without rewriting unrelated TOML and uninstalls created files", async () => {
    const f = fixture();
    execFileSync("git", ["init", "-q", f.checkout]);
    const selected: CompactSelection = { ...f.selection, agent: "codex", model: "gpt-fixture", scope: "repo", choice: "post-turn", value: 25 };
    const path = join(f.checkout, ".codex", "config.toml");
    expect(() => prepareCompact(selected)).toThrow("Git-ignored");
    writeFileSync(join(f.checkout, ".git", "info", "exclude"), "/.codex/config.toml\n");
    mkdirSync(dirname(path));
    const original = "# sample\r\nmodel_post_turn_compact_threshold_percent = 0 # saved\r\n[project]\r\nname = \"demo\"\r\n";
    writeFileSync(path, original);
    await acceptCompact(f.writer, selected, prepareCompact(selected).offer);
    expect(readFileSync(path, "utf8")).toBe(original.replace("= 0", "= 25"));
    await f.off();
    expect(readFileSync(path, "utf8")).toBe(original);
    rmSync(path);
    const window: CompactSelection = { ...selected, choice: "window", value: 300_000 };
    await acceptCompact(f.writer, window, prepareCompact(window).offer);
    expect(readFileSync(path, "utf8")).toBe("model_auto_compact_token_limit = 300000\n");
    expect((await uninstallAgents({ home: f.home })).restored).toContain(path);
    expect(existsSync(path)).toBe(false);
  });
});

describe("pause based on observed outcomes", () => {
  const check = (at: number, kept: number, checked = 10) => ({ at, kept, checked, estimated: true });
  it("ignores incomplete checks, exactly 90% kept and unpriced evidence", () => {
    expect(pauseReason({ checks: [check(1, 8), check(2, 9), { ...check(3, 8), partial: true }],
      rereads: { before: 3, after: 8 }, net: 0 })).toBeUndefined();
    expect(pauseReason({ checks: [check(1, 0, 0), check(2, 2, 3), check(3, 2, 3)], net: Number.NaN })).toBeUndefined();
  });

  it("requires two low estimates among the three most recent sufficiently sized checks", () => {
    const checks = [check(1, 8), check(4, 10), check(2, 8), check(3, 9)];
    expect(pauseReason({ checks })).toBeUndefined();
    expect(pauseReason({ checks: [...checks, check(5, 4, 5), check(6, 8)] })).toBe("kept-rate");
  });

  it.each(["kept-rate", "rereads", "ledger"] as const)("restores the stored settings when %s triggers and keeps the pause visible", async reason => {
    const f = fixture();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const original = '{ "theme": "light" }\n', path = join(f.claude, "settings.json");
    writeFileSync(path, original);
    await acceptCompact(f.writer, f.selection, prepareCompact(f.selection).offer);
    const t = Date.now() + 2000;
    const hooks = hookStore(f);
    const reads = (pass: string) => ({ content: Array.from({ length: 5 }, (_, i) => ({
      type: "tool_use", name: "Read", id: pass + i, input: { file_path: join(f.checkout, "file" + i) },
    })) });
    const body = claudeCall(t, 380_000, reads("before")) + boundary(t + 1) +
      claudeCall(t + 2, 82_000, reason === "rereads" ? reads("after") : {});
    const transcript = observedSession(f, hooks, "s", "claude-code", t, body);
    expect(compactEvidence(f.writer.location, "claude-code", f.checkout)).toHaveLength(1);
    expect(compactEvidence(f.writer.location, "claude-code", f.checkout + "-other")).toEqual([]);
    if (reason === "kept-rate") {
      function recordCheck(epoch: number, at: number, kept: number, checked: number) {
        const stamp = new Date(at).toISOString();
        hooks.prepare("INSERT INTO epochs(session_id,epoch,started_at,reason) VALUES('s',?,?,'compact')").run(epoch, stamp);
        hooks.prepare("INSERT INTO deliveries(id,session_id,epoch,ts,moment,entry_id,form,tokens,action,checkout,detail) VALUES(?,'s',?,?,'compaction-check','mex:compaction-check','one-line',0,'control',?,?)")
          .run("check" + epoch, epoch, stamp, f.checkout, JSON.stringify({ kept, checked, estimated: true }));
      }
      recordCheck(1, t + 1, 2, 3);
      writeFileSync(transcript, body + boundary(t + 3) + claudeCall(t + 4, 80_000));
      recordCheck(2, t + 3, 8, 10);
      await reviewManagedCompaction(f.writer);
      expect(JSON.parse(readFileSync(path, "utf8")).modelSettings[model].autoCompactWindow).toBe(240_000);
      writeFileSync(transcript, body + boundary(t + 3) + claudeCall(t + 4, 80_000) + boundary(t + 5));
      recordCheck(3, t + 5, 8, 10);
    }
    if (reason === "ledger") {
      hooks.exec("INSERT INTO ledger(session_id,lever,tokens_removed,turns_carried,cost_tokens,refetches) VALUES('s','compaction',100,3,500,1)");
      hooks.prepare("INSERT INTO ledger_settlements(session_id,ended_at) VALUES('s',?)").run(new Date(t + 3).toISOString());
      await reviewManagedCompaction(f.writer, "enforce");
      expect(JSON.parse(readFileSync(path, "utf8")).modelSettings[model].autoCompactWindow).toBe(240_000);
      hooks.prepare("UPDATE ledger_settlements SET price_profile=? WHERE session_id='s'").run(LEDGER_PRICE_PROFILE);
      hooks.exec("UPDATE ledger SET saved_input_millitokens=30_000,cost_input_millitokens=500_000 WHERE session_id='s'");
    }
    await reviewManagedCompaction(f.writer, reason === "ledger" ? "enforce" : undefined);
    expect(readFileSync(path, "utf8")).toBe(original);
    const reader = openRecordReadOnly({ home: f.home })!;
    try { expect(compactStates(reader, f.checkout)).toMatchObject([{ state: "paused", reason }]); }
    finally { reader.close(); }
    expect(existsSync(join(f.home, "compaction-watch"))).toBe(false);
  });
});

describe("qualifying window notices", () => {
  it("publishes the first Claude offer and skips offers already shown for the host", () => {
    const f = fixture(), hooks = hookStore(f), at = Date.now();
    const body = claudeCall(at - 2, 380_000) + boundary(at - 1) + claudeCall(at, 80_000);
    const request = join(f.home, "compaction-offer-pending.claude-code"), notice = join(f.home, "compaction-offers", "claude-code");
    for (const id of ["one", "two"]) observedSession(f, hooks, id, "claude-code", at, body);
    writeFileSync(request, "");
    publishCompactOffers(f.writer);
    expect(existsSync(notice)).toBe(false);
    observedSession(f, hooks, "three", "claude-code", at, body);
    writeFileSync(request, "");
    publishCompactOffers(f.writer);
    expect(readFileSync(notice, "utf8")).toBe("1\n");
    expect(existsSync(request)).toBe(false);
    rmSync(notice);
    hooks.prepare("INSERT INTO notices_shown VALUES('compaction.offer.claude-code','three',?)").run(new Date(at).toISOString());
    writeFileSync(request, "");
    publishCompactOffers(f.writer);
    expect(existsSync(notice)).toBe(false);
  });

  it("qualifies Codex within the same checkout", () => {
    const f = fixture(), hooks = hookStore(f), at = Date.now();
    const other = join(dirname(f.checkout), "other");
    mkdirSync(other); f.writer.register(projectIdentity(other));
    const usage = (input: number) => line(at, { type: "event_msg", payload: { type: "token_count",
      info: { model_context_window: 950_000, last_token_usage: { input_tokens: input, output_tokens: 10 } } } });
    const body = line(at, { type: "turn_context", payload: { model: "gpt-fixture" } }) + usage(360_000)
      + line(at, { type: "compacted" }) + usage(80_000);
    observedSession(f, hooks, "one", "codex", at, body);
    observedSession(f, hooks, "two", "codex", at, body);
    observedSession(f, hooks, "outside", "codex", at, body, other);
    const request = join(f.home, "compaction-offer-pending.codex"), directory = join(f.home, "compaction-offers");
    writeFileSync(request, "");
    publishCompactOffers(f.writer);
    expect(existsSync(directory)).toBe(false);
    observedSession(f, hooks, "three", "codex", at, body);
    writeFileSync(request, "");
    publishCompactOffers(f.writer);
    expect(readdirSync(directory)).toEqual(["codex." + shortHash(f.checkout)]);
  });
});
