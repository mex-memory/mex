import crossSpawn from "cross-spawn";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildAgentCommand, HEADLESS_CLAUDE_ALLOWED_TOOLS } from "../../agent-command.js";
import {
  HeadlessPopulationError,
  launchHeadlessSetupPopulation,
  type HeadlessPopulationOptions,
  type HeadlessPopulationActivity,
  type HeadlessPopulationTranscript,
} from "../headless-population.js";

const roots: string[] = [];
const children: number[] = [];

afterEach(() => {
  for (const pid of children.splice(0)) {
    try { process.kill(pid, "SIGKILL"); } catch { /* already closed */ }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("headless population process", () => {
  it.each(["claude", "codex"] as const)("runs %s without a terminal and retains its complete private prompt until close", async (tool) => {
    const fixture = agentFixture(`
      setTimeout(() => {
        fs.writeFileSync('still-readable.txt', fs.readFileSync(pointer, 'utf8'));
      }, 80);
      setTimeout(emitSuccess, 180);
    `);
    const prompt = `private prompt: ${"x".repeat(32 * 1024)}`;
    let heartbeat = 0;
    const timer = setInterval(() => { heartbeat++; }, 10);
    const run = launchHeadlessSetupPopulation({ ...fixture.options, selectedTools: [tool], prompt });
    void run.catch(() => {});
    try {
      const observed = await fixture.observation();
      expect(observed.cwd).toBe(fixture.root);
      expect(observed.prompt).toBe(prompt);
      expect(existsSync(join(fixture.root, observed.pointer))).toBe(true);
      expect(observed.args.join(" ")).not.toContain(prompt);
      expect(observed.args).toContainEqual(expect.stringMatching(/^Read the full setup population prompt from/));
      if (tool === "codex") expect(observed.args.slice(0, -1)).toEqual(["exec", "--json", "--sandbox", "workspace-write"]);
      else expect(observed.args).toEqual([
        "-p", expect.any(String), "--permission-mode", "acceptEdits",
        "--allowedTools", HEADLESS_CLAUDE_ALLOWED_TOOLS.join(","),
        "--output-format", "stream-json", "--verbose", "--include-partial-messages",
      ]);
      await expect(run).resolves.toEqual({ tool, unavailable: [], completed: true });
      expect(heartbeat).toBeGreaterThan(0);
      expect(readFileSync(join(fixture.root, "still-readable.txt"), "utf8")).toBe(prompt);
      expect(fixture.spawn).toHaveBeenCalledWith(tool, expect.any(Array), expect.objectContaining({
        cwd: fixture.root, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
        detached: process.platform !== "win32",
      }));
      expect(fixture.remainingPrompts()).toEqual([]);
    } finally { clearInterval(timer); await run.catch(() => {}); }
  });

  it("retains interactive commands and conditionally supports Codex outside Git", () => {
    expect(buildAgentCommand("codex", "prompt", "interactive")).toEqual({ command: "codex", args: ["prompt"] });
    expect(buildAgentCommand("claude", "prompt", "interactive")).toEqual({ command: "claude", args: ["prompt"] });
    expect(buildAgentCommand("opencode", "prompt", "interactive")).toEqual({ command: "opencode", args: ["run", "prompt"] });
    expect(buildAgentCommand("cursor", "prompt", "headless")).toBeNull();
    expect(buildAgentCommand("codex", "prompt", "headless", { allowNonGit: true })?.args)
      .toEqual(["exec", "--json", "--sandbox", "workspace-write", "--skip-git-repo-check", "prompt"]);
  });

  it("pre-approves only the read-only mex commands headless Claude population needs", () => {
    for (const shell of ["Bash", "PowerShell"]) {
      for (const command of ["mex graph scope", "mex graph get", "mex graph query", "mex impact", "mex logging", "mex log"]) {
        expect(HEADLESS_CLAUDE_ALLOWED_TOOLS).toContain(`${shell}(${command}:*)`);
      }
    }
    for (const rule of HEADLESS_CLAUDE_ALLOWED_TOOLS) {
      expect(rule).toMatch(/^(Bash|PowerShell)\(mex [a-z]+( [a-z]+)?:\*\)$/);
      expect(rule).not.toMatch(/refresh|rebuild|setup|sync|member|relay|inbox|git/);
    }
  });

  it.each(["claude", "codex"] as const)("streams split %s activity before the child exits and flushes its final record", async (tool) => {
    const privateContent = "PRIVATE_PROMPT_SOURCE_PATH_AND_OUTPUT";
    const started = tool === "codex"
      ? { type: "item.started", item: { id: "cmd_1", type: "command_execution", command: `node --version # ${privateContent}`, status: "in_progress" } }
      : { type: "stream_event", event: { type: "content_block_start", index: 0,
        content_block: { type: "tool_use", id: "read_1", name: "Read", input: { file_path: `/private/${privateContent}` } } } };
    const completed = tool === "codex"
      ? { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }
      : { type: "result", subtype: "success", is_error: false, result: privateContent };
    const encoded = JSON.stringify(started);
    const middle = Math.floor(encoded.length / 2);
    const fixture = agentFixture(`
      process.stdout.write(${JSON.stringify(encoded.slice(0, middle))});
      setTimeout(() => process.stdout.write(${JSON.stringify(`${encoded.slice(middle)}\n`)}), 30);
      const waiting = setInterval(() => {
        if (!fs.existsSync('release.txt')) return;
        clearInterval(waiting);
        process.stdout.write(${JSON.stringify(JSON.stringify(completed))});
      }, 20);
    `);
    const activities: HeadlessPopulationActivity[] = [];
    let settled = false;
    const run = launchHeadlessSetupPopulation({ ...fixture.options, selectedTools: [tool],
      onActivity: (activity) => activities.push(activity) });
    void run.then(() => { settled = true; }, () => { settled = true; });
    try {
      const kind = tool === "codex" ? "running_command" : "reading";
      await waitFor(() => activities.some((activity) => activity.kind === kind));
      expect(settled).toBe(false);
      expect(activities.filter((activity) => activity.kind === "starting")).toEqual([
        { tool, kind: "starting", state: "running" },
      ]);
      expect(activities).toContainEqual({ tool, kind, state: "running" });
      writeFileSync(join(fixture.root, "release.txt"), "continue");
      await expect(run).resolves.toEqual({ tool, unavailable: [], completed: true });
      expect(activities).toContainEqual({ tool, kind: "completed", state: "completed" });
      expect(JSON.stringify(activities)).not.toContain(privateContent);
      expect(JSON.stringify(activities)).not.toContain(fixture.root);
      const count = activities.length;
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(activities).toHaveLength(count);
      expect(fixture.remainingPrompts()).toEqual([]);
    } finally {
      writeFileSync(join(fixture.root, "release.txt"), "continue");
      await run.catch(() => {});
    }
  });

  it.each(["claude", "codex"] as const)("streams %s prose and generic markers without commands, paths, or results", async (tool) => {
    const visible = "I am reading the source files.";
    const message = tool === "claude"
      ? { type: "assistant", message: { id: "a1", content: [{ type: "text", text: visible }] } }
      : { type: "item.completed", item: { id: "a1", type: "agent_message", text: visible } };
    const privateContent = "PRIVATE_COMMAND_PATH_AND_OUTPUT";
    const command = tool === "claude"
      ? { type: "stream_event", event: { type: "content_block_start", content_block: { type: "tool_use", id: "t1", name: "Bash", input: { command: privateContent } } } }
      : { type: "item.started", item: { type: "command_execution", id: "t1", command: privateContent } };
    const output = tool === "claude"
      ? { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: privateContent }] } }
      : { type: "item.completed", item: { type: "command_execution", id: "t1", command: privateContent, aggregated_output: privateContent } };
    const file = tool === "claude"
      ? { type: "assistant", message: { content: [{ type: "tool_use", id: "f1", name: "Write", input: { file_path: privateContent, content: privateContent } }] } }
      : { type: "item.completed", item: { type: "file_change", id: "f1", changes: [{ path: privateContent, kind: "update" }] } };
    const fixture = agentFixture(`
      process.stdout.write(${JSON.stringify(JSON.stringify(message) + "\n")});
      process.stdout.write(${JSON.stringify(JSON.stringify(command) + "\n")});
      const wait = setInterval(() => {
        if (!fs.existsSync('release-transcript.txt')) return;
        clearInterval(wait);
        process.stdout.write(${JSON.stringify(JSON.stringify(output) + "\n" + JSON.stringify(file) + "\n")});
        emitSuccess();
      }, 20);
    `);
    const entries: HeadlessPopulationTranscript[] = [];
    let settled = false;
    const run = launchHeadlessSetupPopulation({ ...fixture.options, selectedTools: [tool],
      onTranscript: entry => entries.push(entry) });
    void run.then(() => { settled = true; }, () => { settled = true; });
    try {
      await waitFor(() => entries.some(entry => entry.kind === "command"));
      expect(settled).toBe(false);
      expect(entries).toEqual([{ tool, kind: "assistant", text: visible }, { tool, kind: "command", text: "Ran a command" }]);
      writeFileSync(join(fixture.root, "release-transcript.txt"), "release");
      await expect(run).resolves.toEqual({ tool, unavailable: [], completed: true });
      expect(entries).toEqual([
        { tool, kind: "assistant", text: visible }, { tool, kind: "command", text: "Ran a command" },
        { tool, kind: "file", text: "Updated a file" },
      ]);
      expect(JSON.stringify(entries)).not.toContain(privateContent);
      const count = entries.length;
      await new Promise(resolve => setTimeout(resolve, 250));
      expect(entries).toHaveLength(count);
      expect(fixture.remainingPrompts()).toEqual([]);
    } finally {
      writeFileSync(join(fixture.root, "release-transcript.txt"), "release");
      await run.catch(() => {});
    }
  });

  it("stops transcript callbacks when cancellation is requested from the observer", async () => {
    const event = { type: "item.completed", item: { type: "agent_message", id: "a1", text: "Reading the repository." } };
    const fixture = agentFixture(`
      process.stdout.write(${JSON.stringify(JSON.stringify(event) + "\n")});
      setInterval(() => process.stdout.write(${JSON.stringify(JSON.stringify({ ...event, item: { ...event.item, id: "a2", text: "Later text" } }) + "\n")}), 500);
    `);
    const controller = new AbortController();
    const entries: HeadlessPopulationTranscript[] = [];
    const run = launchHeadlessSetupPopulation({ ...fixture.options, signal: controller.signal,
      onTranscript: entry => { entries.push(entry); controller.abort(); } });
    await expect(run).rejects.toMatchObject({ category: "cancelled" });
    expect(entries).toEqual([{ tool: "codex", kind: "assistant", text: "Reading the repository." }]);
    await new Promise(resolve => setTimeout(resolve, 250));
    expect(entries).toHaveLength(1);
    expect(fixture.remainingPrompts()).toEqual([]);
  });

  it("isolates transcript observer exceptions from agent completion and cleanup", async () => {
    const event = { type: "item.completed", item: { type: "agent_message", id: "a1", text: "Done" } };
    const fixture = agentFixture(`process.stdout.write(${JSON.stringify(JSON.stringify(event) + "\n")}); emitSuccess();`);
    await expect(launchHeadlessSetupPopulation({ ...fixture.options, onTranscript: () => { throw new Error("observer failed"); } }))
      .resolves.toEqual({ tool: "codex", unavailable: [], completed: true });
    expect(fixture.remainingPrompts()).toEqual([]);
  });

  it.each(["claude", "codex"] as const)("treats a %s provider failure as failure even when the process exits zero", async (tool) => {
    const privateContent = "PRIVATE_PROVIDER_ERROR_PATH_AND_PROMPT";
    const failed = tool === "codex"
      ? { type: "turn.failed", error: { message: privateContent } }
      : { type: "result", subtype: "error_during_execution", is_error: true, errors: [privateContent] };
    const fixture = agentFixture(`process.stdout.write(${JSON.stringify(JSON.stringify(failed))});`);
    const activities: HeadlessPopulationActivity[] = [];
    const error = await launchHeadlessSetupPopulation({ ...fixture.options, selectedTools: [tool],
      onActivity: (activity) => activities.push(activity) }).catch((error: unknown) => error);
    expect(error).toMatchObject({ category: "failed" });
    expect(activities).toContainEqual({ tool, kind: "failed", state: "failed" });
    expect(JSON.stringify(activities)).not.toContain(privateContent);
    expect(String(error)).not.toContain(privateContent);
    expect(fixture.remainingPrompts()).toEqual([]);
  });

  describe.each(["claude", "codex"] as const)("%s completion evidence", (tool) => {
    it.each(["missing", "truncated", "malformed", "oversized"] as const)("rejects an exit-zero process with a %s final record", async (variant) => {
      const privateContent = "PRIVATE_FINAL_RECORD_PATH_AND_PROMPT";
      const completed = tool === "codex"
        ? { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }
        : { type: "result", subtype: "success", is_error: false };
      const record = JSON.stringify(completed);
      const output = variant === "missing" ? ""
        : variant === "truncated" ? record.slice(0, -3)
        : variant === "malformed" ? `${record.slice(0, -1)},"result":${privateContent}}`
        : JSON.stringify({ ...completed, result: privateContent.repeat(3_000) });
      const fixture = agentFixture(`process.stdout.write(${JSON.stringify(output)});`);
      const activities: HeadlessPopulationActivity[] = [];
      const error = await launchHeadlessSetupPopulation({ ...fixture.options, selectedTools: [tool],
        onActivity: (activity) => activities.push(activity) }).catch((error: unknown) => error);
      expect(error).toMatchObject({ category: "protocol", message: expect.stringContaining("without confirming completion") });
      expect(activities.some((activity) => activity.kind === "completed")).toBe(false);
      expect(JSON.stringify(activities)).not.toContain(privateContent);
      expect(String(error)).not.toContain(privateContent);
      expect(fixture.remainingPrompts()).toEqual([]);
    });
  });

  it("stops reporting activity as soon as cancellation begins", async () => {
    const active = JSON.stringify({ type: "item.started", item: {
      id: "cmd_1", type: "command_execution", command: "node --version", status: "in_progress",
    } });
    const complete = JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });
    const fixture = agentFixture(`
      process.stdout.write(${JSON.stringify(`${active}\n`)});
      process.on('SIGTERM', () => process.stdout.write(${JSON.stringify(`${complete}\n`)}));
      setInterval(() => process.stdout.write(${JSON.stringify(`${active}\n`)}), 20);
    `);
    const controller = new AbortController();
    const activities: HeadlessPopulationActivity[] = [];
    const run = launchHeadlessSetupPopulation({ ...fixture.options, signal: controller.signal,
      onActivity: (activity) => activities.push(activity) });
    const outcome = run.catch((error: unknown) => error);
    await waitFor(() => activities.some((activity) => activity.kind === "running_command"));
    controller.abort();
    const count = activities.length;
    expect(await outcome).toMatchObject({ category: "cancelled" });
    expect(activities).toHaveLength(count);
    expect(fixture.remainingPrompts()).toEqual([]);
  });

  it("keeps the child owned when an activity observer throws", async () => {
    const fixture = agentFixture("emitSuccess();");
    await expect(launchHeadlessSetupPopulation({ ...fixture.options,
      onActivity: () => { throw new Error("observer failed"); } }))
      .resolves.toEqual({ tool: "codex", unavailable: [], completed: true });
    expect(fixture.remainingPrompts()).toEqual([]);
  });

  it("launches only the first selected available supported tool", async () => {
    const fixture = agentFixture("emitSuccess();");
    const available = vi.fn(async (command: string) => command === "codex");
    await expect(launchHeadlessSetupPopulation({
      ...fixture.options,
      selectedTools: ["cursor", "claude", "codex", "opencode"],
      __internal: { ...fixture.options.__internal, isAvailable: available },
    })).resolves.toEqual({ tool: "codex", unavailable: ["claude"], completed: true });
    expect(available.mock.calls).toEqual([["claude"], ["codex"]]);
    expect(fixture.spawn).toHaveBeenCalledTimes(1);
  });

  it("returns the manual fallback only when no selected supported CLI is available", async () => {
    const fixture = agentFixture("");
    await expect(launchHeadlessSetupPopulation({
      ...fixture.options,
      __internal: { ...fixture.options.__internal, isAvailable: async () => false },
    })).resolves.toEqual({ tool: null, unavailable: ["codex"], completed: false });
    expect(fixture.spawn).not.toHaveBeenCalled();
    expect(existsSync(join(fixture.root, ".mex/local"))).toBe(false);
  });

  it.each([
    ["unexpected argument '--full-auto' found", "arguments", "rejected the background command"],
    ["authentication required; please log in", "authentication", "could not authenticate"],
    ["something private failed", "failed", "exited before population completed"],
  ])("reports a safe failure for %s and removes the prompt", async (diagnostic, category, message) => {
    const secret = "PRIVATE_TOKEN_PATH_AND_PROMPT";
    const fixture = agentFixture(`
      process.stderr.write(${JSON.stringify(`${diagnostic}\n${secret}`)});
      process.stdout.write('private model output '.repeat(100000));
      process.exitCode = 2;
    `);
    const error = await launchHeadlessSetupPopulation(fixture.options).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(HeadlessPopulationError);
    expect(error).toMatchObject({ category, message: expect.stringContaining(message) });
    expect(String(error)).not.toContain(secret);
    expect(String(error)).not.toContain(fixture.root);
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(fixture.remainingPrompts()).toEqual([]);
  });

  it("reports a launch failure instead of manual population", async () => {
    const fixture = agentFixture("");
    const onActivity = vi.fn();
    const missingSpawn = ((_command: string, args: string[], options: object) =>
      crossSpawn(join(fixture.root, "does-not-exist"), args, options)) as unknown as typeof crossSpawn;
    await expect(launchHeadlessSetupPopulation({
      ...fixture.options,
      onActivity,
      __internal: { isAvailable: async () => true, spawn: missingSpawn },
    })).rejects.toMatchObject({ category: "launch" });
    expect(onActivity).not.toHaveBeenCalled();
    expect(fixture.remainingPrompts()).toEqual([]);
  });

  it("cancels a running child and its descendants before removing the prompt", async () => {
    const fixture = agentFixture(`
      const descendant = spawn(process.execPath, ['-e', \
        "process.on('SIGTERM', () => {}); setInterval(() => require('fs').writeFileSync('heartbeat.txt', String(Date.now())), 10)"],
        { stdio: ['ignore', 'inherit', 'inherit'] });
      publishJson('descendant.json', { pid: descendant.pid });
      setInterval(() => {}, 1000);
    `);
    const controller = new AbortController();
    const run = launchHeadlessSetupPopulation({ ...fixture.options, signal: controller.signal });
    const outcome = run.catch((error: unknown) => error);
    await waitFor(() => existsSync(join(fixture.root, "heartbeat.txt")));
    const descendant = JSON.parse(readFileSync(join(fixture.root, "descendant.json"), "utf8")) as { pid: number };
    children.push(descendant.pid);
    controller.abort();
    expect(await outcome).toMatchObject({ category: "cancelled" });
    const lastHeartbeat = readFileSync(join(fixture.root, "heartbeat.txt"), "utf8");
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(readFileSync(join(fixture.root, "heartbeat.txt"), "utf8")).toBe(lastHeartbeat);
    expect(fixture.remainingPrompts()).toEqual([]);
  });

  it("applies a bounded deadline and cleans up a child that ignores graceful termination", async () => {
    const fixture = agentFixture("process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);");
    await expect(launchHeadlessSetupPopulation({ ...fixture.options, timeoutMs: 300 }))
      .rejects.toMatchObject({ category: "timeout" });
    expect(fixture.remainingPrompts()).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("cleans up POSIX helpers left behind by a successful agent", async () => {
    const fixture = agentFixture(`
      const descendant = spawn(process.execPath, ['-e',
        "process.on('SIGTERM', () => {}); setInterval(() => require('fs').writeFileSync('heartbeat.txt', String(Date.now())), 10)"],
        { stdio: ['ignore', 'inherit', 'inherit'] });
      descendant.unref();
      publishJson('descendant.json', { pid: descendant.pid });
      setTimeout(emitSuccess, 120);
    `);
    const run = launchHeadlessSetupPopulation(fixture.options);
    await waitFor(() => existsSync(join(fixture.root, "heartbeat.txt")));
    const descendant = JSON.parse(readFileSync(join(fixture.root, "descendant.json"), "utf8")) as { pid: number };
    children.push(descendant.pid);
    await expect(run).resolves.toEqual({ tool: "codex", unavailable: [], completed: true });
    const lastHeartbeat = readFileSync(join(fixture.root, "heartbeat.txt"), "utf8");
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(readFileSync(join(fixture.root, "heartbeat.txt"), "utf8")).toBe(lastHeartbeat);
    expect(fixture.remainingPrompts()).toEqual([]);
  });

  it("cancels during CLI discovery without preparing or running a prompt", async () => {
    const fixture = agentFixture("");
    const controller = new AbortController();
    const run = launchHeadlessSetupPopulation({
      ...fixture.options,
      signal: controller.signal,
      __internal: {
        ...fixture.options.__internal,
        isAvailable: async () => { controller.abort(); return true; },
      },
    });
    await expect(run).rejects.toMatchObject({ category: "cancelled" });
    expect(fixture.spawn).not.toHaveBeenCalled();
    expect(existsSync(join(fixture.root, ".mex/local"))).toBe(false);
  });

  it("does not create a prompt or spawn when already cancelled", async () => {
    const fixture = agentFixture("");
    const controller = new AbortController();
    controller.abort();
    await expect(launchHeadlessSetupPopulation({ ...fixture.options, signal: controller.signal }))
      .rejects.toMatchObject({ category: "cancelled" });
    expect(fixture.spawn).not.toHaveBeenCalled();
    expect(existsSync(join(fixture.root, ".mex/local"))).toBe(false);
  });

  it("does not expose local paths from prompt preparation failures", async () => {
    const fixture = agentFixture("");
    writeFileSync(join(fixture.root, ".mex/local"), "unsafe destination");
    const error = await launchHeadlessSetupPopulation(fixture.options).catch((error: unknown) => error);
    expect(error).toMatchObject({ category: "prompt" });
    expect(String(error)).not.toContain(fixture.root);
    expect(fixture.spawn).not.toHaveBeenCalled();
  });
});

function agentFixture(body: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mex-headless-population-")));
  roots.push(root);
  mkdirSync(join(root, ".mex"));
  const script = join(root, "agent.cjs");
  writeFileSync(script, `
    const fs = require('node:fs');
    const { spawn } = require('node:child_process');
    function publishJson(path, value) {
      fs.writeFileSync(path + '.tmp', JSON.stringify(value));
      fs.renameSync(path + '.tmp', path);
    }
    const args = process.argv.slice(2);
    function emitSuccess() {
      const result = args.includes('-p')
        ? { type: 'result', subtype: 'success', is_error: false }
        : { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } };
      process.stdout.write(JSON.stringify(result) + String.fromCharCode(10));
    }
    const instruction = args.find(arg => arg.startsWith('Read the full setup population prompt'));
    const pointer = instruction.split(String.fromCharCode(96))[1];
    publishJson('observation.json', {
      args, cwd: process.cwd(), pointer, prompt: fs.readFileSync(pointer, 'utf8'),
    });
    ${body}
  `);
  const spawn = vi.fn((_command: string, args: string[], options: object) => crossSpawn(process.execPath, [script, ...args], options));
  const options: HeadlessPopulationOptions = {
    selectedTools: ["codex"], prompt: "private prompt", projectRoot: root,
    __internal: {
      isAvailable: async () => true,
      spawn: spawn as unknown as typeof crossSpawn,
      onSpawn: (pid) => { children.push(pid); },
    },
  };
  return {
    root, options, spawn,
    observation: async (): Promise<{ args: string[]; cwd: string; prompt: string; pointer: string }> => {
      await waitFor(() => existsSync(join(root, "observation.json")));
      return JSON.parse(readFileSync(join(root, "observation.json"), "utf8"));
    },
    remainingPrompts: () => readdirSync(join(root, ".mex/local")),
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Subprocess fixture did not become ready");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
