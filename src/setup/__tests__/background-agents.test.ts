import crossSpawn from "cross-spawn";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BACKGROUND_AGENT_CLIS,
  COMMAND_CAPABLE_AGENTS,
  CURSOR_PERMISSIONS_FILE,
  OPENCODE_SETUP_AGENT,
  buildAgentCommand,
  cursorSessionPermissionsText,
  opencodeSessionConfig,
  type BackgroundAgentTool,
} from "../../agent-command.js";
import {
  HeadlessPopulationError,
  acquireCursorPermissions,
  describeSetupAgentChoice,
  findAvailableSetupAgent,
  launchHeadlessSetupPopulation,
  type HeadlessPopulationActivity,
  type HeadlessPopulationOptions,
  type HeadlessPopulationTranscript,
} from "../headless-population.js";

/**
 * Fake agent CLIs for the background adapters added beyond Claude Code and
 * Codex. Each fake prints what the vendor documents:
 * - Cursor CLI `--output-format stream-json`: system/init, assistant, tool_call
 *   started/completed (readToolCall, writeToolCall, function), a final result of
 *   subtype success; a failure exits non-zero with an error on stderr and no result.
 * - Copilot CLI `--output-format=json` and OpenCode `run --format json`: one JSON
 *   object per line; their events are not documented, so the fakes print
 *   arbitrary records and MEX may rely on nothing but the line framing and the
 *   exit status.
 */
const NEW_AGENTS = ["cursor", "copilot", "opencode"] as const satisfies readonly BackgroundAgentTool[];

const roots: string[] = [];
const children: number[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const pid of children.splice(0)) {
    try { process.kill(pid, "SIGKILL"); } catch { /* already closed */ }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const SUCCESS: Record<(typeof NEW_AGENTS)[number], string> = {
  cursor: `
    emit({ type: 'system', subtype: 'init', apiKeySource: 'login', cwd: process.cwd(), session_id: 's1', model: 'm', permissionMode: 'default' });
    emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Reading the architecture file.' }] }, session_id: 's1' });
    emit({ type: 'tool_call', subtype: 'started', call_id: 'c1', tool_call: { readToolCall: { args: { path: '.mex/context/architecture.md' } } }, session_id: 's1' });
    emit({ type: 'tool_call', subtype: 'completed', call_id: 'c1', tool_call: { readToolCall: { args: { path: '.mex/context/architecture.md' }, result: { success: { content: 'x', isEmpty: false, exceededLimit: false, totalLines: 1, totalChars: 1 } } } }, session_id: 's1' });
    emit({ type: 'tool_call', subtype: 'started', call_id: 'c2', tool_call: { writeToolCall: { args: { path: '.mex/local/setup-ops/a.json', fileText: '[]', toolCallId: 'c2' } } }, session_id: 's1' });
    emit({ type: 'tool_call', subtype: 'completed', call_id: 'c2', tool_call: { writeToolCall: { args: { path: '.mex/local/setup-ops/a.json' }, result: { success: { path: '.mex/local/setup-ops/a.json', linesCreated: 1, fileSize: 2 } } } }, session_id: 's1' });
    emit({ type: 'result', subtype: 'success', duration_ms: 10, duration_api_ms: 10, is_error: false, result: 'Batch written.', session_id: 's1' });
  `,
  copilot: `
    emit({ kind: 'anything', note: 'undocumented record 1' });
    emit({ kind: 'anything', note: 'undocumented record 2' });
  `,
  opencode: `
    emit({ kind: 'anything', note: 'undocumented record 1' });
    emit({ kind: 'anything', note: 'undocumented record 2' });
  `,
};

describe("background agent commands (documented flags only)", () => {
  it("restricts Cursor through its project permission file and never passes --force", () => {
    const command = buildAgentCommand("cursor", "INSTRUCTION", "headless")!;
    expect(command).toEqual({ command: "agent", args: ["-p", "--output-format", "stream-json", "--trust", "INSTRUCTION"] });
    expect(command.args).not.toContain("--force");
    expect(command.args).not.toContain("--yolo");
    expect(JSON.parse(cursorSessionPermissionsText())).toEqual({
      permissions: { allow: ["Write(.mex/**)"], deny: ["Shell(*)", "WebFetch(*)", "Mcp(*:*)"] },
    });
  });

  it("denies Copilot every shell, URL and memory tool and allows only writes", () => {
    const command = buildAgentCommand("copilot", "INSTRUCTION", "headless")!;
    expect(command.command).toBe("copilot");
    expect(command.args).toEqual(["-p", "INSTRUCTION", "--allow-tool=write", "--deny-tool=shell,url,memory", "--no-ask-user", "--output-format=json"]);
    expect(command.args.join(" ")).not.toMatch(/allow-all|yolo|allow-all-paths|add-dir/);
  });

  it("runs OpenCode as a MEX-defined agent whose permissions deny everything but reading and editing", () => {
    const command = buildAgentCommand("opencode", "INSTRUCTION", "headless", { opencodeConfig: opencodeSessionConfig(undefined) })!;
    expect(command.command).toBe("opencode");
    expect(command.args).toEqual(["run", "--format", "json", "--agent", OPENCODE_SETUP_AGENT, "INSTRUCTION"]);
    expect(command.args).not.toContain("--auto");
    const config = JSON.parse(command.env!.OPENCODE_CONFIG_CONTENT!);
    const permission = config.agent[OPENCODE_SETUP_AGENT].permission;
    // "*" first: the last matching rule wins, so only the named tools are allowed.
    expect(Object.keys(permission)[0]).toBe("*");
    expect(permission).toEqual({ "*": "deny", read: "allow", glob: "allow", grep: "allow", edit: "allow", todowrite: "allow" });
    expect(permission.bash).toBeUndefined();
    expect(config.agent[OPENCODE_SETUP_AGENT].mode).toBe("primary");
  });

  it("keeps a user's own inline OpenCode config and refuses one it cannot extend", () => {
    const merged = JSON.parse(opencodeSessionConfig(JSON.stringify({ model: "x/y", agent: { mine: { description: "mine" } } }))!);
    expect(merged.model).toBe("x/y");
    expect(Object.keys(merged.agent).sort()).toEqual(["mex-setup", "mine"]);
    expect(opencodeSessionConfig("not json")).toBeNull();
    expect(opencodeSessionConfig("[1]")).toBeNull();
    expect(opencodeSessionConfig(JSON.stringify({ agent: "x" }))).toBeNull();
    expect(buildAgentCommand("opencode", "p", "headless", { opencodeConfig: null })).toBeNull();
  });

  it("gives only Claude Code and Codex the units that run mex commands", () => {
    expect([...COMMAND_CAPABLE_AGENTS].sort()).toEqual(["claude", "codex"]);
    expect(BACKGROUND_AGENT_CLIS).toEqual({ claude: "claude", codex: "codex", cursor: "agent", copilot: "copilot", opencode: "opencode" });
    expect(buildAgentCommand("windsurf", "p", "headless")).toBeNull();
  });
});

describe("choosing the background agent", () => {
  const onPath = (...commands: string[]) => vi.fn(async (command: string) => commands.includes(command));

  it("uses the first selected agent whose CLI is installed, in the user's order", async () => {
    const available = onPath("copilot", "codex");
    await expect(findAvailableSetupAgent(["windsurf", "copilot", "codex"], { isAvailable: available }))
      .resolves.toEqual({ tool: "copilot", selected: true });
    expect(available.mock.calls).toEqual([["copilot"]]);
  });

  it("falls back to any installed supported CLI and says which one runs", async () => {
    const choice = await findAvailableSetupAgent(["windsurf", "cursor"], { isAvailable: onPath("opencode") });
    expect(choice).toEqual({ tool: "opencode", selected: false });
    expect(describeSetupAgentChoice(choice!, ["windsurf", "cursor"]))
      .toBe("Windsurf, Cursor have no CLI MEX can run in the background here, so MEX runs OpenCode (`opencode`) for the setup sessions. To choose another agent, rerun `mex setup` and select it.");
    expect(describeSetupAgentChoice({ tool: "copilot", selected: true }, ["copilot"])).toBeNull();
    expect(describeSetupAgentChoice({ tool: "copilot", selected: true }, ["cursor", "copilot"])).toContain("Cursor has no CLI");
  });

  it("launches nothing when the user chose to continue without an agent", async () => {
    const available = onPath("claude", "codex", "copilot", "opencode", "agent");
    await expect(findAvailableSetupAgent([], { isAvailable: available })).resolves.toBeNull();
    expect(available).not.toHaveBeenCalled();
  });

  it("never picks Cursor's generic `agent` command unless Cursor was selected", async () => {
    await expect(findAvailableSetupAgent(["windsurf"], { isAvailable: onPath("agent") })).resolves.toBeNull();
    await expect(findAvailableSetupAgent(["cursor"], { isAvailable: onPath("agent") })).resolves.toEqual({ tool: "cursor", selected: true });
  });

  it("offers only Claude Code or Codex when the session must run mex commands", async () => {
    await expect(findAvailableSetupAgent(["copilot"], { isAvailable: onPath("copilot"), requireCommands: true })).resolves.toBeNull();
    await expect(findAvailableSetupAgent(["copilot"], { isAvailable: onPath("copilot", "codex"), requireCommands: true }))
      .resolves.toEqual({ tool: "codex", selected: false });
  });

  it("skips Cursor when the project has its own Cursor permission file", async () => {
    const root = tempRoot();
    mkdirSync(join(root, ".cursor"));
    writeFileSync(join(root, CURSOR_PERMISSIONS_FILE), "{\"permissions\":{\"allow\":[\"Shell(npm)\"]}}\n");
    await expect(findAvailableSetupAgent(["cursor", "copilot"], { projectRoot: root, isAvailable: onPath("agent", "copilot") }))
      .resolves.toEqual({ tool: "copilot", selected: true });
  });

  it("skips OpenCode when the user's inline config cannot be extended", async () => {
    vi.stubEnv("OPENCODE_CONFIG_CONTENT", "{broken");
    await expect(findAvailableSetupAgent(["opencode"], { isAvailable: onPath("opencode") })).resolves.toBeNull();
  });

  it("finds no CLI on PATH while MEX_SETUP_BACKGROUND_AGENTS=0 (the test suite's guard)", async () => {
    expect(process.env.MEX_SETUP_BACKGROUND_AGENTS).toBe("0");
    await expect(findAvailableSetupAgent(["claude", "codex", "copilot"])).resolves.toBeNull();
  });
});

describe("the Cursor session permission file", () => {
  it("exists only while sessions run, is shared by parallel sessions, and is removed with the folder MEX made", () => {
    const root = tempRoot();
    const path = join(root, CURSOR_PERMISSIONS_FILE);
    const first = acquireCursorPermissions(root)!;
    const second = acquireCursorPermissions(root)!;
    expect(readFileSync(path, "utf8")).toBe(cursorSessionPermissionsText());
    first();
    first();
    expect(existsSync(path)).toBe(true);
    second();
    expect(existsSync(path)).toBe(false);
    expect(existsSync(join(root, ".cursor"))).toBe(false);
  });

  it("keeps a .cursor folder the user already had, and reuses a file MEX left behind", () => {
    const root = tempRoot();
    mkdirSync(join(root, ".cursor"));
    writeFileSync(join(root, ".cursor", "rules.md"), "mine");
    writeFileSync(join(root, CURSOR_PERMISSIONS_FILE), cursorSessionPermissionsText());
    const release = acquireCursorPermissions(root)!;
    release();
    expect(existsSync(join(root, CURSOR_PERMISSIONS_FILE))).toBe(false);
    expect(readFileSync(join(root, ".cursor", "rules.md"), "utf8")).toBe("mine");
  });

  it("never replaces or removes the user's own file", () => {
    const root = tempRoot();
    mkdirSync(join(root, ".cursor"));
    writeFileSync(join(root, CURSOR_PERMISSIONS_FILE), "{}\n");
    expect(acquireCursorPermissions(root)).toBeNull();
    expect(readFileSync(join(root, CURSOR_PERMISSIONS_FILE), "utf8")).toBe("{}\n");
  });
});

describe.each(NEW_AGENTS)("the %s adapter with a fake CLI", (tool) => {
  it("runs the documented command, reports activity, and completes", async () => {
    const fixture = fakeAgent(tool, `${SUCCESS[tool]} process.exit(0);`);
    const activity: HeadlessPopulationActivity[] = [];
    const transcript: HeadlessPopulationTranscript[] = [];
    const result = await launchHeadlessSetupPopulation({
      ...fixture.options, onActivity: (entry) => activity.push(entry), onTranscript: (entry) => transcript.push(entry),
    });
    expect(result).toEqual({ tool, completed: true });
    const observed = fixture.observed();
    expect(fixture.spawn).toHaveBeenCalledWith(BACKGROUND_AGENT_CLIS[tool], expect.any(Array), expect.objectContaining({ cwd: fixture.root }));
    expect(observed.args).toEqual(buildAgentCommand(tool, observed.instruction, "headless")!.args);
    expect(activity.every((entry) => entry.tool === tool)).toBe(true);
    expect(activity.map((entry) => entry.kind)).toContain("started");
    if (tool === "cursor") {
      // The permission file was in place for the session, and is gone after it.
      expect(observed.cursorPermissions).toBe(cursorSessionPermissionsText());
      expect(existsSync(join(fixture.root, CURSOR_PERMISSIONS_FILE))).toBe(false);
      expect(activity).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "reading", state: "running", target: "architecture" }),
        expect.objectContaining({ kind: "reading", state: "completed", target: "architecture" }),
        expect.objectContaining({ kind: "writing", state: "completed" }),
        expect.objectContaining({ kind: "completed", state: "completed" }),
      ]));
      expect(transcript.map((entry) => entry.text)).toEqual(expect.arrayContaining([
        expect.stringContaining("Reading the architecture file."), "Read a file", "Updated a file", expect.stringContaining("Batch written."),
      ]));
    } else {
      // Undocumented events: activity only, no record content, one fixed notice.
      expect(activity.map((entry) => entry.kind)).toEqual(["starting", "started", "working"]);
      expect(transcript.map((entry) => entry.kind)).toEqual(["notice"]);
      expect(JSON.stringify(transcript)).not.toContain("undocumented record");
    }
    if (tool === "opencode") {
      const config = JSON.parse(observed.opencodeConfig!);
      expect(config.agent[OPENCODE_SETUP_AGENT].permission["*"]).toBe("deny");
    } else {
      expect(observed.opencodeConfig).toBeNull();
    }
  });

  it("reports an authentication failure in its own category", async () => {
    const fixture = fakeAgent(tool, "process.stderr.write('Error: not authenticated. Please log in and try again.\\n'); process.exit(1);");
    await expectCategory(launchHeadlessSetupPopulation(fixture.options), "authentication");
  });

  it("reports a usage limit, not a failed run", async () => {
    const fixture = fakeAgent(tool, "process.stderr.write('Error: you have reached your usage limit for this period.\\n'); process.exit(1);");
    await expectCategory(launchHeadlessSetupPopulation(fixture.options), "usage_limit");
  });

  it("returns no agent when its CLI is not installed, and a launch failure when it vanishes", async () => {
    const fixture = fakeAgent(tool, "");
    await expect(launchHeadlessSetupPopulation({
      ...fixture.options, __internal: { ...fixture.options.__internal, isAvailable: async () => false },
    })).resolves.toEqual({ tool: null, completed: false });
    expect(fixture.spawn).not.toHaveBeenCalled();
    const missing = vi.fn((_command: string, _args: string[], options: object) =>
      crossSpawn(join(fixture.root, "no-such-agent-binary"), [], options));
    await expectCategory(launchHeadlessSetupPopulation({
      ...fixture.options, __internal: { ...fixture.options.__internal, spawn: missing as unknown as typeof crossSpawn },
    }), "launch");
    expect(existsSync(join(fixture.root, CURSOR_PERMISSIONS_FILE))).toBe(false);
  });

  it("treats a crash as a failed session", async () => {
    const fixture = fakeAgent(tool, `${tool === "cursor" ? "emit({ type: 'system', subtype: 'init' });" : "emit({ a: 1 });"} process.exit(3);`);
    await expectCategory(launchHeadlessSetupPopulation(fixture.options), "failed");
  });

  it("does not count an exit without completion evidence as success", async () => {
    // Cursor documents a terminal result record; the others need at least one record.
    const fixture = fakeAgent(tool, tool === "cursor" ? "emit({ type: 'system', subtype: 'init' }); process.exit(0);" : "process.exit(0);");
    await expectCategory(launchHeadlessSetupPopulation(fixture.options), "protocol");
  });

  it("stops the whole process tree on cancel and leaves no permission file behind", async () => {
    const fixture = fakeAgent(tool, "emit({ type: 'system', subtype: 'init' }); setInterval(() => {}, 1000);");
    const controller = new AbortController();
    const run = launchHeadlessSetupPopulation({
      ...fixture.options, signal: controller.signal,
      onActivity: (entry) => { if (entry.kind === "started") controller.abort(); },
    });
    await expectCategory(run, "cancelled");
    expect(existsSync(join(fixture.root, CURSOR_PERMISSIONS_FILE))).toBe(false);
  });
});

async function expectCategory(run: Promise<unknown>, category: string): Promise<void> {
  const error = await run.then(() => null, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(HeadlessPopulationError);
  expect((error as HeadlessPopulationError).category).toBe(category);
}

function tempRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mex-background-agents-")));
  roots.push(root);
  return root;
}

/** A fake CLI: records what it was given, then runs `body` (which may call emit). */
function fakeAgent(tool: BackgroundAgentTool, body: string) {
  const root = tempRoot();
  mkdirSync(join(root, ".mex"));
  const script = join(root, "fake-agent.cjs");
  writeFileSync(script, `
    const fs = require('node:fs');
    const path = require('node:path');
    const args = process.argv.slice(2);
    const instruction = args.find(arg => arg.startsWith('Read the full setup population prompt'));
    const permissions = path.join(process.cwd(), ${JSON.stringify(CURSOR_PERMISSIONS_FILE)});
    fs.writeFileSync('observed.json', JSON.stringify({
      args, instruction,
      cursorPermissions: fs.existsSync(permissions) ? fs.readFileSync(permissions, 'utf8') : null,
      opencodeConfig: process.env.OPENCODE_CONFIG_CONTENT ?? null,
    }));
    function emit(value) { process.stdout.write(JSON.stringify(value) + String.fromCharCode(10)); }
    ${body}
  `);
  const spawn = vi.fn((_command: string, args: string[], options: object) => crossSpawn(process.execPath, [script, ...args], options));
  const options: HeadlessPopulationOptions = {
    selectedTools: [tool], prompt: "private prompt", projectRoot: root,
    __internal: {
      isAvailable: async (command) => command === BACKGROUND_AGENT_CLIS[tool],
      spawn: spawn as unknown as typeof crossSpawn,
      onSpawn: (pid) => { children.push(pid); },
    },
  };
  return {
    root, options, spawn,
    observed: (): { args: string[]; instruction: string; cursorPermissions: string | null; opencodeConfig: string | null } =>
      JSON.parse(readFileSync(join(root, "observed.json"), "utf8")),
  };
}
