import crossSpawn from "cross-spawn";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openRecordReadOnly } from "../index.js";
import { USAGE_WARNING, usageWarningPending } from "../usage.js";
import { launchHeadlessSetupPopulation } from "../../setup/headless-population.js";
import { launchInteractiveSetupPopulation } from "../../setup/interactive-population.js";
import { launchSetupPopulation } from "../../setup/population.js";
import { runToolInteractive } from "../../sync/index.js";
import type { BackgroundAgentTool } from "../../agent-command.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mex-call-sites-"));
  mkdirSync(join(root, ".mex"));
  vi.stubEnv("MEX_HOME", join(root, "user-home"));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
function rows() {
  const reader = openRecordReadOnly()!;
  try { return reader.all<{ purpose: string; agent: string; model: string; input: number; cache_write: number; cache_read: number; output: number; estimated: number; project_id: string; kind: string; session_id: string | null }>("SELECT * FROM model_calls ORDER BY id"); }
  finally { reader.close(); }
}
function spawnEvents(events: unknown[], code = 0): typeof crossSpawn {
  return (() => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true });
    queueMicrotask(() => {
      child.emit("spawn");
      for (const event of events) child.stdout.write(JSON.stringify(event) + "\n");
      child.stdout.end(); child.stderr.end(); child.emit("exit", code, null); child.emit("close", code, null);
    });
    return child as unknown as ChildProcess;
  }) as unknown as typeof crossSpawn;
}
function headless(tool: BackgroundAgentTool, events: unknown[], purpose?: string, code = 0) {
  return launchHeadlessSetupPopulation({ projectRoot: root, prompt: "Synthetic prompt", selectedTools: [tool], usagePurpose: purpose,
    __internal: { isAvailable: async () => true, spawn: spawnEvents(events, code) } });
}

describe("kept agent launches account without changing outcomes", () => {
  it("accounts from a real child process' final JSON output, including pipe drains", async () => {
    const source = `process.stdout.write(JSON.stringify({type:'turn.completed',usage:{input_tokens:120,cached_input_tokens:80,output_tokens:9}}));`;
    const spawn = ((_command: string, _args: string[], options: object) => crossSpawn(process.execPath, ["-e", source], options)) as unknown as typeof crossSpawn;
    await expect(launchHeadlessSetupPopulation({ projectRoot: root, prompt: "Synthetic prompt", selectedTools: ["codex"], __internal: { isAvailable: async () => true, spawn } })).resolves.toMatchObject({ completed: true });
    expect(rows()[0]).toMatchObject({ agent: "codex", input: 40, cache_read: 80, output: 9, estimated: 0 });
  });
  it.each(["claude", "codex", "cursor", "copilot", "opencode"] as const)("records one %s headless invocation using reported classes where available", async (tool) => {
    const events = tool === "codex" ? [{ type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 10 } }]
      : tool === "opencode" ? [{ type: "step_finish", part: { id: "part-a", tokens: { input: 60, output: 8, reasoning: 2, cache: { read: 40, write: 5 } } } }]
      : [{ type: "result", subtype: "success", usage: { input_tokens: 60, cache_creation_input_tokens: 5, cache_read_input_tokens: 40, output_tokens: 10 } }];
    await expect(headless(tool, events)).resolves.toMatchObject({ completed: true });
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ purpose: "setup.population", agent: tool, input: 60, cache_write: tool === "codex" ? 0 : 5, cache_read: 40, output: 10, estimated: 0, project_id: expect.stringMatching(/^f-/) });
  });
  it.each(["setup.shared.write", "setup.subsystem.write", "setup.subsystem.fix", "setup.shared.fix", "setup.finalize-repair"])("records %s at the shared launcher", async (purpose) => {
    await headless("claude", [{ type: "result", subtype: "success", result: "synthetic response" }], purpose);
    expect(rows()[0]).toMatchObject({ purpose, estimated: 1, input: 4 });
  });
  it("keeps the agent's own session id for a headless run so a later reader can tell it apart", async () => {
    await headless("claude", [{ type: "system", subtype: "init", session_id: "claude-session-1" },
      { type: "result", subtype: "success", session_id: "claude-session-1", usage: { input_tokens: 1, output_tokens: 1 } }]);
    await headless("codex", [{ type: "thread.started", thread_id: "codex-thread-1" }, { type: "turn.completed", usage: { input_tokens: 2, output_tokens: 1 } }]);
    expect(rows().map((r) => [r.agent, r.kind, r.session_id])).toEqual([["claude", "headless", "claude-session-1"], ["codex", "headless", "codex-thread-1"]]);
  });
  it("records an unsuccessful attempt, and a broken record never changes success or warnings' privacy", async () => {
    await expect(headless("codex", [{ type: "turn.failed", error: { message: "synthetic failure" } }], undefined, 1)).rejects.toMatchObject({ category: "failed" });
    expect(rows()).toHaveLength(1);
    const broken = join(root, "broken"); writeFileSync(broken, "not a folder"); vi.stubEnv("MEX_HOME", broken);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await expect(headless("codex", [{ type: "turn.completed", usage: { input_tokens: 2, output_tokens: 3 } }])).resolves.toMatchObject({ completed: true });
    // Nothing is printed while the command runs (setup may be drawing a full screen); one line waits for exit.
    expect(warning).not.toHaveBeenCalled();
    expect(stderr.mock.calls.some(([text]) => String(text).includes(USAGE_WARNING))).toBe(false);
    expect(usageWarningPending()).toBe(true);
  });
  it("records native interactive setup while preserving inherited terminal output", async () => {
    const child = Object.assign(new EventEmitter(), { pid: 912345, kill: () => true }) as unknown as ChildProcess;
    const result = await launchInteractiveSetupPopulation({ projectRoot: root, prompt: "Synthetic prompt", selectedTools: ["claude"],
      __internal: { isAvailable: async () => true, snapshot: async () => [], spawn: (() => {
        queueMicrotask(() => { child.emit("exit", 0, null); child.emit("close", 0, null); }); return child;
      }) as unknown as typeof crossSpawn } });
    expect(result).toMatchObject({ status: "exited" });
    // The person drives an interactive session; its tokens are in their own usage, so no numbers here.
    expect(rows()[0]).toMatchObject({ purpose: "setup.interactive", kind: "interactive", estimated: 0, input: 0, output: 0 });
  });
  it("records synchronous sync and legacy setup launches while preserving inherited stdio", () => {
    const stub = vi.spyOn(crossSpawn, "sync").mockReturnValue({ status: 0 } as ReturnType<typeof crossSpawn.sync>);
    expect(runToolInteractive("claude", "Synthetic prompt", root)).toBe(true);
    expect(launchSetupPopulation(["codex"], "Synthetic prompt", root, { isAvailable: () => true })).toMatchObject({ completed: true });
    expect(rows().map((r) => [r.purpose, r.agent, r.kind, r.input, r.estimated])).toEqual([
      ["sync.interactive", "claude", "interactive", 0, 0], ["setup.interactive", "codex", "interactive", 0, 0],
    ]);
    expect(stub.mock.calls.every((call) => call[2]?.stdio === "inherit")).toBe(true);
  });
});
