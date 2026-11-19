import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { acceptCompact, prepareCompact, reviewManagedCompaction, type CompactSelection } from "../../compaction/control.js";
import { runCheckoutSwitch } from "../../controls/cli.js";
import { binaryFileName } from "../../hooks/shim/binary.js";
import { openHooksReadOnly, openRecord } from "../../record/index.js";
import { absolutePath } from "../../record/project.js";
import { readLedgerTrace, settleSessionLedger, type Observation, type SessionTrace } from "../accounting.js";
import { settlePendingLedger } from "../background.js";
import { INPUT_MILLITOKENS, ledgerRates } from "../pricing.js";
import { ledgerShouldTurnOff, publishLeverGates, sessionLeverNet } from "../view.js";

const actions = (kind: Observation["kind"], at: number, removed = 0): Observation => ({
  lever: "outline", kind, at, tokens_removed: removed, tokens_added: 0, hook_ms: 20,
});
const record = (at: number, data: object) => JSON.stringify({ timestamp: new Date(at).toISOString(), ...data }) + "\n";
function claudeCall(at: number, id: string, input: number, output: number, content: object[] = [], extra: object = {}) {
  return record(at, { type: "assistant", requestId: id, entrypoint: "cli", message: {
    id: "message-" + id, model: "claude-opus-4-6", usage: { input_tokens: input, output_tokens: output }, content, ...extra,
  } });
}

it("accounts for distinct carry lengths and charges a shared refetch and denial as one observed request", () => {
  const request = (at: number, input: number, output: number) => ({ at, rates: ledgerRates(),
    usage: { input, output, write5m: 0, write1h: 0, read: 0, hasCacheBreakdown: false } });
  const trace: SessionTrace = {
    agent: "claude-code",
    requests: [
      request(100, 1000, 10), request(200, 1300, 20), request(250, 1400, 24),
      request(350, 1600, 30), request(440, 800, 16),
    ],
    boundaries: [{ at: 400 }], reads: [], edits: [], timings: [],
  };
  const effects = [actions("saving", 150, 100), actions("saving", 225, 55), actions("refetch", 260),
    actions("denial", 290), actions("saving", 430, 10)];
  expect(settleSessionLedger(trace, effects)).toMatchObject([
    { lever: "outline", tokens_removed: 10, turns_carried: 1, cost_tokens: 1635, refetches: 1 },
    { lever: "outline#2", tokens_removed: 55, turns_carried: 2, cost_tokens: 0, refetches: 0 },
    { lever: "outline#3", tokens_removed: 100, turns_carried: 3, cost_tokens: 0, refetches: 0 },
  ]);
  const wrapper: Observation = { ...actions("saving", 150), lever: "codex-wrapper", tokens_added: 10 };
  expect(settleSessionLedger({ ...trace, agent: "codex", timings: [{ at: 440, ms: 440 }] }, [wrapper])).toMatchObject([
    { lever: "codex-wrapper", tokens_removed: 0, turns_carried: 3, cost_tokens: 35, refetches: 0 },
  ]);
});

it("charges only a confirmed unchanged reread to compaction", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mex-ledger-rereads-")));
  temporary.push(root);
  const files = ["unchanged.ts", "agent-edit.ts", "disk-edit.ts"];
  for (const file of files) writeFileSync(join(root, file), "original");
  const start = Date.now() + 1000;
  const at = (delta: number) => start + delta;
  const stamp = new Date(at(160));
  utimesSync(join(root, "disk-edit.ts"), stamp, stamp);
  const results = (time: number, IDs: string[]) => record(time, { type: "user", message: { content:
    IDs.map(tool_use_id => ({ type: "tool_result", tool_use_id })) } });
  const reads = (pass: string, paths: string[]) => paths.map((file_path, index) =>
    ({ type: "tool_use", name: "Read", id: pass + index, input: { file_path } }));
  const before = files.map((_, i) => "before" + i), after = files.map((_, i) => "after" + i);
  const body = claudeCall(at(100), "pre", 310_000, 100, reads("before", files.map(file => join(root, file)))) +
    results(at(120), before) +
    claudeCall(at(130), "edit", 310_000, 100, [{ type: "tool_use", name: "Edit", id: "edit",
      input: { file_path: join(root, "agent-edit.ts") } }]) + results(at(140), ["edit"]) +
    record(at(150), { type: "system", subtype: "compact_boundary", compactMetadata: { preTokens: 310_000,
      usage: { input_tokens: 310_000, output_tokens: 5000 } } }) +
    claudeCall(at(180), "post", 85_000, 100, reads("after", files)) + results(at(190), after) +
    claudeCall(at(240), "consume", 88_000, 400) +
    record(at(300), { type: "system", subtype: "compact_boundary", compactMetadata: { preTokens: 93_000,
      usage: { input_tokens: 9000, output_tokens: 1000 } } }) + claudeCall(at(320), "next", 30_000, 25);
  const trace = readLedgerTrace(body, "claude-code", "s", at(400), root)!;
  expect(settleSessionLedger(trace, [])).toMatchObject([
    { lever: "compaction", tokens_removed: 63_000, turns_carried: 1, cost_tokens: 413_400, refetches: 1 },
    { lever: "compaction#2", tokens_removed: 225_000, turns_carried: 2, cost_tokens: 0, refetches: 0 },
  ]);
});

it("prices a compaction as net-negative even though its raw token net is positive", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mex-ledger-priced-")));
  temporary.push(root);
  const path = join(root, "once.ts");
  writeFileSync(path, "unchanged");
  const start = Date.now() + 1000;
  const read = (id: string) => [{ type: "tool_use", name: "Read", id, input: { file_path: path } }];
  const result = (offset: number, id: string) => record(start + offset, { type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: id }] } });
  const body = claudeCall(start + 100, "pre", 0, 10, read("before"),
      { usage: { input_tokens: 0, cache_read_input_tokens: 20_000, output_tokens: 10 } }) + result(120, "before") +
    record(start + 150, { type: "system", subtype: "compact_boundary", compactMetadata: { preTokens: 20_000,
      usage: { input_tokens: 100, output_tokens: 30 } } }) +
    claudeCall(start + 180, "post", 0, 10, read("after"),
      { usage: { input_tokens: 0, cache_read_input_tokens: 10_000, output_tokens: 10 } }) + result(190, "after") +
    claudeCall(start + 240, "consume", 2000, 250, [],
      { usage: { input_tokens: 2000, cache_read_input_tokens: 8000, output_tokens: 250 } });
  const trace = readLedgerTrace(body, "claude-code", "s", start + 300, root)!;
  const [term] = settleSessionLedger(trace, [])!;
  expect(term).toEqual({
    lever: "compaction", tokens_removed: 10_000, turns_carried: 2, cost_tokens: 10_380, refetches: 1,
    saved_input_millitokens: 3_800_000, cost_input_millitokens: 4_300_000,
  });
  expect(term!.tokens_removed * term!.turns_carried - term!.cost_tokens).toBeGreaterThan(0);
  expect(term!.saved_input_millitokens - term!.cost_input_millitokens).toBeLessThan(0);
});

it.each([
  ["claude-sonnet-5-5-20261116[1m]", 335_000, 60_000],
  ["unknown-model", 172_500, 30_000],
] as const)("values first-resend writes, later cache reads, and hook delay for %s", (model, saved, delay) => {
  const body = claudeCall(100, "write", 0, 20, [], { model, usage: { input_tokens: 0,
    cache_creation_input_tokens: 200, cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 100 },
    output_tokens: 20 } }) +
    claudeCall(200, "read", 0, 40, [], { model,
      usage: { input_tokens: 0, cache_read_input_tokens: 2000, output_tokens: 40 } }) +
    record(200, { type: "system", subtype: "turn_duration", durationMs: 200 });
  const trace = readLedgerTrace(body, "claude-code", "s", 300, process.cwd())!;
  expect(settleSessionLedger(trace, [actions("saving", 50, 100)])).toEqual([
    { lever: "outline", tokens_removed: 100, turns_carried: 2, cost_tokens: 6, refetches: 0,
      saved_input_millitokens: saved, cost_input_millitokens: delay },
  ]);
});

it("deduplicates provider requests and only attributes a matched Codex summary call", () => {
  const checkout = absolutePath(process.cwd());
  const host = claudeCall(100, "a", 10_000, 10) + claudeCall(101, "a", 10_000, 30) + claudeCall(200, "b", 20_000, 20);
  expect(readLedgerTrace(host, "claude-code", "s", 300, checkout)?.requests).toMatchObject([
    { at: 100, usage: { input: 10_000, output: 30 } }, { at: 200, usage: { input: 20_000, output: 20 } },
  ]);
  expect(readLedgerTrace(host + "partial", "claude-code", "s", 300, checkout)).toBeUndefined();
  const tokens = (at: number, input: number, output: number, totalIn: number, totalOut: number) => record(at, {
    type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: input, output_tokens: output },
      total_token_usage: { input_tokens: totalIn, output_tokens: totalOut } } },
  });
  const body = record(90, { type: "session_meta", payload: { id: "s", source: "cli" } }) +
    tokens(100, 1000, 80, 1000, 80) + tokens(101, 1000, 80, 1000, 80) +
    record(130, { type: "turn_context", payload: { model: "claude-opus-5-5" } }) +
    record(150, { type: "event_msg", payload: { type: "patch_apply_end", success: true,
      changes: { "src/old.ts": { type: "update", move_path: "src/new.ts" } } } }) +
    record(200, { type: "compacted", payload: { compaction_response_id: "summary",
      latest_token_usage_record: { response_id: "summary", usage: { input_tokens: 800, output_tokens: 25 } } } }) +
    tokens(201, 0, 0, 1000, 80) + tokens(230, 600, 40, 1600, 120);
  const trace = readLedgerTrace(body, "codex", "s", 300, checkout)!;
  expect(trace.requests).toHaveLength(2);
  expect(trace.edits).toEqual([{ at: 150, path: join(checkout, "src", "old.ts") }, { at: 150, path: join(checkout, "src", "new.ts") }]);
  expect(settleSessionLedger(trace, [])).toEqual([
    { lever: "compaction", tokens_removed: 480, turns_carried: 1, cost_tokens: 825, refetches: 0,
      saved_input_millitokens: 480_000, cost_input_millitokens: 925_000 },
  ]);
  expect(readLedgerTrace(body.replace('"cli"', '"exec"'), "codex", "s", 300, checkout)).toBeUndefined();
});

it("needs ten evaluated sessions and turns off at zero or below", () => {
  expect(ledgerShouldTurnOff(Array(9).fill(-5))).toBe(false);
  expect(ledgerShouldTurnOff(Array(10).fill(0))).toBe(true);
  expect(ledgerShouldTurnOff([-9, ...Array(9).fill(1)])).toBe(true);
  expect(ledgerShouldTurnOff([-8, ...Array(9).fill(1)])).toBe(false);
});

const temporary: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

it("reports priced losses and preserves gates and settings by default, with enforcement available for both", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mex-ledger-")));
  temporary.push(root);
  const checkout = join(root, "repo"), home = join(root, ".mex"), claude = join(root, "claude");
  const transcripts = join(claude, "projects", "fixture"), binary = join(root, binaryFileName());
  mkdirSync(checkout);
  mkdirSync(transcripts, { recursive: true });
  execFileSync("go", ["build", "-buildvcs=false", "-o", binary, "./cmd/mex-hook"],
    { cwd: resolve(import.meta.dirname, "../../../native"), timeout: 45_000, stdio: "pipe" });
  vi.stubEnv("MEX_HOME", root);
  vi.stubEnv("CLAUDE_CONFIG_DIR", claude);
  vi.stubEnv("MEX_HOOK_BINARY", binary);
  vi.stubEnv("MEX_TELEMETRY", "0");
  vi.stubEnv("MEX_OFF", "");
  const hookEnv = { ...process.env, MEX_BACKGROUND: "", MEX_RAW: "", MEX_HOOK_RECORD: "", CLAUDE_CODE_ENTRYPOINT: "cli" };
  for (const key of ["CI", "GITHUB_ACTIONS", "GITLAB_CI", "BUILDKITE", "JENKINS_URL", "TF_BUILD"]) delete (hookEnv as NodeJS.ProcessEnv)[key];
  const writer = openRecord({ home, projectPath: checkout, isNetwork: () => false });
  let reader: ReturnType<typeof openHooksReadOnly>;
  try {
    function hook(event: string, session: string, fields: object = {}) {
      const out = execFileSync(binary, ["claude-code", event], { cwd: checkout, encoding: "utf8", env: hookEnv,
        input: JSON.stringify({ cwd: checkout, session_id: session, hook_event_name: event,
          transcript_path: join(transcripts, session + ".jsonl"), ...fields }), timeout: 5_000 });
      return JSON.parse(out);
    }
    function shell(session: string, command: string, stdout: string, id: string) {
      return hook("PostToolUse", session, { tool_name: "Bash", tool_use_id: id,
        tool_input: { command }, tool_response: { stdout, stderr: "", interrupted: false, isImage: false } });
    }
    const gate = join(home, "ledger-off.shell-trim");
    const stopped = () => {
      try { return JSON.parse(readFileSync(gate, "utf8")).off; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
    };
    const longOutput = readFileSync(resolve(import.meta.dirname, "../../../native/output/testdata/outputs/jest-pass.txt"), "utf8");
    async function settleLosingSession(session: string) {
      hook("SessionStart", session, { source: "startup" });
      const trimmed = shell(session, "npm test", longOutput, "trim").hookSpecificOutput?.updatedToolOutput?.stdout as string;
      expect(trimmed.length).toBeLessThan(longOutput.length);
      const first = Date.now();
      const number = /mex out (\d+)/u.exec(trimmed)![1];
      shell(session, "mex out " + number, longOutput, "refetch");
      const second = Date.now();
      writeFileSync(join(transcripts, session + ".jsonl"), claudeCall(first, "first", 10_000, 40) + claudeCall(second, "second", 45_000, 70));
      hook("SessionEnd", session);
      await settlePendingLedger(writer, Date.now() + 3000);
      reader ??= openHooksReadOnly({ home });
      expect(sessionLeverNet(reader!, session, "shell-trim")?.net_millitokens).toBeLessThan(0);
    }
    for (let i = 1; i <= 10; i++) {
      await settleLosingSession("s-" + i);
      expect(existsSync(gate)).toBe(false);
      expect(existsSync(join(home, "ledger-report.shell-trim"))).toBe(i === 10);
    }
    expect(hook("SessionStart", "after-report", { source: "startup" }).systemMessage).toContain("Ledger auto-off is in report-only mode.");
    expect(shell("after-report", "npm test", longOutput, "still-active").hookSpecificOutput?.updatedToolOutput?.stdout.length).toBeLessThan(longOutput.length);
    expect(hook("SessionStart", "report-seen", { source: "startup" }).systemMessage).toBeUndefined();

    publishLeverGates(writer, reader!, "enforce");
    expect(stopped()).toBe(true);
    const notice = hook("SessionStart", "after-off", { source: "startup" });
    expect(notice.systemMessage).toContain("turned off shell output trimming after the last 10 measured sessions");
    expect(notice.systemMessage).toContain("mex on --lever shell-trim");
    expect(shell("after-off", "npm test", longOutput, "later").hookSpecificOutput?.updatedToolOutput).toBeUndefined();
    expect(hook("SessionStart", "later", { source: "startup" }).systemMessage).toBeUndefined();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      runCheckoutSwitch(true, { lever: "shell-trim", json: true });
      expect(JSON.parse(log.mock.calls[0]![0])).toEqual({ scope: "user", lever: "shell-trim", state: "on" });
    } finally { log.mockRestore(); }
    expect(stopped()).toBe(false);
    const rearmedGate = readFileSync(gate, "utf8");
    // A pre-reset session can settle after the reset. It belongs to the old trial.
    await settleLosingSession("later");
    expect(stopped()).toBe(false);
    for (let i = 1; i <= 10; i++) {
      await settleLosingSession("retry-" + i);
      expect(readFileSync(gate, "utf8")).toBe(rearmedGate);
      if (i === 10) expect(hook("SessionStart", "fresh-report", { source: "startup" }).systemMessage).toContain("Ledger auto-off is in report-only mode.");
      publishLeverGates(writer, reader!, "enforce");
      expect(stopped()).toBe(i === 10);
    }
    expect(hook("SessionStart", "second-off", { source: "startup" }).systemMessage).toContain("mex on --lever shell-trim");
    expect(hook("SessionStart", "seen-twice", { source: "startup" }).systemMessage).toBeUndefined();

    const path = join(claude, "settings.json"), original = '{ "theme": "light" }\r\n';
    writeFileSync(path, original);
    const selection: CompactSelection = { agent: "claude-code", checkout, model: "claude-opus-4-6", scope: "user", choice: "window", value: 240_000 };
    await acceptCompact(writer, selection, prepareCompact(selection).offer);
    const applied = readFileSync(path, "utf8");
    const managed = writer.db.prepare("SELECT value FROM settings WHERE scope='compaction'").get();
    hook("SessionStart", "window", { source: "startup" });
    const at = Date.now();
    const body = claudeCall(at - 2, "pre", 340_000, 50) +
      record(at - 1, { type: "system", subtype: "compact_boundary", compactMetadata: { preTokens: 340_050, postTokens: 60_000 } }) +
      claudeCall(at, "after", 61_000, 100);
    writeFileSync(join(transcripts, "window.jsonl"), body);
    hook("SessionEnd", "window");
    await settlePendingLedger(writer, Date.now() + 3000);
    expect(sessionLeverNet(reader!, "window", "compaction")?.net_millitokens).toBe(-296_237.5 * INPUT_MILLITOKENS);
    await reviewManagedCompaction(writer);
    expect(readFileSync(path, "utf8")).toBe(applied);
    expect(writer.db.prepare("SELECT value FROM settings WHERE scope='compaction'").get()).toEqual(managed);
    expect(hook("SessionStart", "after-window-report", { source: "startup" }).systemMessage).toContain("Ledger rollback is in report-only mode.");
    expect(hook("SessionStart", "window-report-seen", { source: "startup" }).systemMessage).toBeUndefined();
    await reviewManagedCompaction(writer, "enforce");
    expect(readFileSync(path, "utf8")).toBe(original);
    expect(hook("SessionStart", "after-window", { source: "startup" }).systemMessage).toContain("restored the previous compaction setting");
  } finally {
    reader?.close();
    writer.close();
  }
}, 60_000);
