import { execFile, execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

const repo = fileURLToPath(new URL("..", import.meta.url));
const cli = join(repo, "dist/cli.js");
const harness = join(repo, "test/helpers/setup-pty.py");
const python = process.platform === "win32" ? undefined : spawnSync("python3", ["-c", "import pty, termios, sys; print(sys.executable)"], { encoding: "utf8", timeout: 3000 });
const pythonPath = python?.status === 0 ? python.stdout.trim() : undefined;
const skipReason = process.platform === "win32" ? "requires a POSIX PTY" : !pythonPath ? "requires Python 3 with pty/termios" : undefined;
const fixtures: Fixture[] = [];

interface Fixture { root: string; project: string; record: string; env: NodeJS.ProcessEnv; cli?: string; workerRecord?: string }
interface Action { expect?: string; regex?: boolean; missing?: string[]; quietMs?: number; input?: string; signal?: string; probe?: boolean }
interface Result { exitCode: number; output: string; raw: string; error: string | null; events: { match?: string; quietOutput?: string; connected?: boolean }[] }
interface AgentRecord { pid: number; agent: string; stdinTTY: boolean; stdoutTTY: boolean; stderrTTY: boolean; canonical: boolean; echo: boolean; input?: string; argv: string[]; promptExists: boolean }

beforeAll(() => {
  if (!skipReason && !existsSync(cli)) throw new Error("Build dist/cli.js with npm run build before running the terminal PTY acceptance tests.");
});
afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    if (existsSync(fixture.record)) {
      const record = agentRecord(fixture);
      // Only a failed acceptance can leave its fake agent behind.
      if (isAlive(record.pid)) { try { process.kill(record.pid, "SIGKILL"); } catch {} }
    }
    if (fixture.workerRecord && existsSync(fixture.workerRecord)) {
      const record = JSON.parse(readFileSync(fixture.workerRecord, "utf8")) as { pid: number };
      if (isAlive(record.pid)) { try { process.kill(record.pid, "SIGKILL"); } catch {} }
    }
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

describe.skipIf(Boolean(skipReason))(`built terminal setup acceptance${skipReason ? ` (${skipReason})` : ""}`, { timeout: 35_000 }, () => {
  it.each([
    { entry: "mex setup", command: ["setup"] },
    { entry: "bare mex", command: [] },
  ])("$entry shows the ASCII banner and choices at 80x24 before any setup writes, then cancels cleanly", async ({ command }) => {
    const f = fixture("incomplete");
    const result = await terminal(f, [], [{ expect: "Choose your AI tools", missing: [".mex", ".agents", "AGENTS.md", ".gitignore"], input: "\u0003" }], { columns: 80, rows: 24, command });
    expect(result.exitCode, result.output).toBe(130);
    expect(result.output).toContain("88888b.d88b.   .d88b.  888  888");
    expect(result.output).toContain("Codex");
    expect(result.output).toContain("Space multi-select");
    expect(result.output).toContain("Setup cancelled.");
    expect(readdirSync(f.project)).toEqual([]);
    expect(existsSync(f.record)).toBe(false);
  });

  it("Ctrl+D on the configuration screen cancels without creating files", async () => {
    const f = fixture("incomplete");
    const result = await terminal(f, [], [{ expect: "Choose your AI tools", missing: [".mex"], input: "\u0004" }]);
    expect(result.exitCode, result.output).toBe(130);
    expect(result.output).toContain("Setup cancelled.");
    expect(readdirSync(f.project)).toEqual([]);
    expect(existsSync(f.record)).toBe(false);
  });

  it("Ctrl+D at the manual prompt cancels instead of returning to a stranded recovery menu", async () => {
    const f = fixture("incomplete");
    const result = await terminal(f, ["--tool", "none"], [
      { expect: "Choose your AI tools", input: "\r" },
      { expect: "> Show setup prompt", input: "\r" },
      { expect: "Press Enter to return to MEX", input: "\u0004" },
    ]);
    expect(result.exitCode, result.output).toBe(130);
    expect(result.output).toContain("Copy this prompt into your AI tool");
    expect(result.output).toContain("Setup cancelled.");
    expect(existsSync(f.record)).toBe(false);
  });

  it("accepts the first HUD key after returning from the manual prompt", async () => {
    const f = fixture("incomplete");
    const result = await terminal(f, ["--tool", "none"], [
      { expect: "Choose your AI tools", input: "\r" },
      { expect: "> Show setup prompt", input: "\r" },
      { expect: "Press Enter to return to MEX", input: "\r" },
      { expect: "> Show setup prompt", input: "\u001b[A" },
      { expect: "> Finish later", input: "\r" },
    ]);
    expect(result.exitCode, result.output).toBe(2);
    expect(result.output).toContain("Setup paused at population");
    expect(existsSync(f.record)).toBe(false);
  });

  it.each([
    { description: "a fresh project", savedTools: [] },
    { description: "a project with Claude already selected", savedTools: ["claude"] },
  ])("Enter selects and starts highlighted Codex in $description without pressing Space", async ({ savedTools }) => {
    const f = fixture("incomplete");
    if (savedTools.length) {
      mkdirSync(join(f.project, ".mex"));
      writeFileSync(join(f.project, ".mex/config.json"), JSON.stringify({ aiTools: savedTools, setupMode: "agent-memory" }));
    }
    const result = await terminal(f, [], [
      { expect: `> [${savedTools.length ? "x" : " "}] Claude Code`, input: "\u001b[B" },
      { expect: "> [ ] Cursor", input: "\u001b[B" },
      { expect: "> [ ] Windsurf", input: "\u001b[B" },
      { expect: "> [ ] Copilot", input: "\u001b[B" },
      { expect: "> [ ] OpenCode", input: "\u001b[B" },
      { expect: "> [ ] Codex", input: "\r" },
      { expect: "MEX_PTY_CHILD_READY", input: "selected with Enter\n" },
      { expect: "required scaffold placeholders remain", input: "\u001b[A" },
      { expect: "> Finish later", input: "\r" },
    ], { defaultTool: false });
    expect(result.exitCode, result.output).toBe(2);
    expect(result.output).toContain("Opening Codex");
    expect(result.output).not.toContain("Opening Claude Code");
    expect(agentRecord(f)).toMatchObject({ agent: "codex", stdinTTY: true, canonical: true, input: "selected with Enter" });
    expect(JSON.parse(readFileSync(join(f.project, ".mex/config.json"), "utf8")).aiTools).toEqual(["codex", ...savedTools]);
    expectPromptCleaned(f);
  });

  it("hands a cooked real terminal to Codex, accepts keyboard input, and recovers from incomplete exit zero", async () => {
    const f = fixture("incomplete");
    const result = await terminal(f, [], [
      { expect: "Choose your AI tools", input: "\r" },
      { expect: "MEX_PTY_CHILD_READY", quietMs: 1250, input: "hello native agent\n" },
      { expect: "required scaffold placeholders remain", input: "\u001b[B" },
      { expect: "> Show setup prompt", input: "\u001b[B" },
      { expect: "> Check populated files", input: "\r" },
      { expect: "Required scaffold placeholders remain", input: "\u001b[B" },
      { expect: "> Finish later", input: "\r" },
    ]);
    expect(result.exitCode, result.output).toBe(2);
    expect(result.events[1].quietOutput).toBe("");
    expect(agentRecord(f)).toMatchObject({ stdinTTY: true, stdoutTTY: true, stderrTTY: true, canonical: true, echo: true, input: "hello native agent", promptExists: true });
    expect(agentRecord(f).argv.join(" ")).toContain("Read the full setup population prompt");
    const nativeOutput = result.raw.split("MEX_PTY_CHILD_READY")[1]?.split("MEX_PTY_CHILD_DONE")[0];
    expect(nativeOutput).toContain("hello native agent");
    expect(nativeOutput).not.toContain("PROJECT MEMORY / SETUP");
    expect(nativeOutput).not.toContain("\u001b[?1049h");
    expect(result.output).toContain("Run `mex setup` to continue");
    expect(JSON.parse(readFileSync(join(f.project, ".mex/config.json"), "utf8")).aiTools).toEqual(["codex"]);
    expectPromptCleaned(f);
  });

  it("returns to recovery after a nonzero native agent exit and pauses on Finish later", async () => {
    const f = fixture("failed");
    const result = await terminal(f, [], [
      { expect: "Choose your AI tools", input: "\r" },
      { expect: "MEX_PTY_CHILD_READY", input: "finish\n" },
      { expect: "Codex stopped before a clean exit", input: "\u001b[A" },
      { expect: "> Finish later", input: "\r" },
    ]);
    expect(result.exitCode, result.output).toBe(2);
    expect(result.output).toContain("Setup paused at population");
    expect(result.output).toContain("Show setup prompt");
    expect(result.output).toContain("Run `mex setup` to continue");
    expectPromptCleaned(f);
  });

  it("validates populated files, exposes the finishing Hub URL, and closes its listener with q", async () => {
    const f = fixture("complete");
    const result = await terminal(f, [], [
      { expect: "Choose your AI tools", input: "\r" },
      { expect: "MEX_PTY_CHILD_READY", input: "populate\n" },
      { expect: "http://127\\.0\\.0\\.1:[0-9]+/#token=[A-Za-z0-9_-]+", regex: true, probe: true, input: "q" },
    ]);
    expect(result.exitCode, result.output).toBe(0);
    expect(result.output).toContain("Continue in your browser");
    expect(result.events[2].connected).toBe(true);
    expect(result.output).toContain("Hub stopped");
    expect(existsSync(join(f.root, "browser-open"))).toBe(false);
    const address = new URL(result.events[2].match!);
    expect(await canConnect(Number(address.port))).toBe(false);
    expect(readFileSync(join(f.project, ".mex/AGENTS.md"), "utf8")).not.toContain("[YYYY-MM-DD]");
    expect(existsSync(join(f.project, ".mex/graph.db"))).toBe(false);
    expect(existsSync(join(f.project, ".mex/wiki.db"))).toBe(false);
    expectPromptCleaned(f);
  });

  it("shows a clean copyable Hub link at 60x16 and exits after returning to the HUD", async () => {
    const f = fixture("complete");
    const result = await terminal(f, [], [
      { expect: "Choose your AI tools", input: "\r" },
      { expect: "MEX_PTY_CHILD_READY", input: "populate\n" },
      { expect: "Continue in your browser", input: "l" },
      { expect: "Hub link \\(keep it private\\):\\n(http://127\\.0\\.0\\.1:[0-9]+/#token=[A-Za-z0-9_-]{43})\\n", regex: true },
      { expect: "Press Enter to return to MEX", input: "\r" },
      { expect: "Continue in your browser", input: "q" },
    ], { columns: 60, rows: 16 });
    expect(result.exitCode, result.output).toBe(0);
    const link = result.events[3].match!.split("\n")[1];
    expect(result.raw).toContain(`Hub link (keep it private):\r\n${link}\r\n`);
    expect(result.output).toContain("Setup complete. Hub stopped.");
    const address = new URL(link);
    expect(await canConnect(Number(address.port))).toBe(false);
    expectPromptCleaned(f);
  });

  it("SIGTERM stops the CLI and its active native child before removing the private prompt", async () => {
    const f = fixture("hold");
    const result = await terminal(f, [], [
      { expect: "Choose your AI tools", input: "\r" },
      { expect: "MEX_PTY_CHILD_READY", signal: "SIGTERM" },
    ]);
    expect(result.exitCode, result.output).toBe(143);
    expect(result.output).toContain("Setup cancelled.");
    expect(isAlive(agentRecord(f).pid)).toBe(false);
    expectPromptCleaned(f);
  });

  it("--yes remains plain in a real terminal, writes scaffold files, and never starts an agent", async () => {
    const f = fixture("complete");
    const result = await terminal(f, ["--yes"]);
    expect(result.exitCode, result.output).toBe(2);
    expect(result.output).toContain("Setup paused");
    expect(result.output).toContain("Population prompt:");
    expect(result.output).not.toContain("Choose your AI tools");
    expect(result.raw).not.toContain("\u001b[?1049h");
    expect(existsSync(join(f.project, ".mex/config.json"))).toBe(true);
    expect(existsSync(f.record)).toBe(false);
  });

  it("shows real code graph parsing progress before pausing for manual population", async () => {
    const f = fixture("incomplete");
    codeRepository(f);
    const result = await terminal(f, ["--mode", "code-repo", "--tool", "none"], [
      { expect: "Choose your AI tools", input: "\r" },
      { expect: "Parsing source files" },
      { expect: "files parsed" },
      { expect: "> Show setup prompt", input: "\u001b[A" },
      { expect: "> Finish later", input: "\r" },
    ]);
    expect(result.exitCode, result.output).toBe(2);
    expect(result.output).toContain("Code graph");
    expect(result.output).toMatch(/\d+\s*\/\s*20\s+files parsed/);
    expect(result.output).not.toContain("Setup needs attention");
    expect(existsSync(join(f.project, ".mex/graph.db"))).toBe(true);
    expect(existsSync(join(f.project, ".mex/wiki.db"))).toBe(false);
    expect(existsSync(f.record)).toBe(false);
    expect(() => execFileSync("git", ["rev-parse", "HEAD"], { cwd: f.project, stdio: "ignore" })).toThrow();
  });

  it("prints real graph phases and final file counts in plain code-repository setup", async () => {
    const f = fixture("incomplete");
    codeRepository(f);
    const result = await terminal(f, ["--mode", "code-repo", "--tool", "none", "--yes"]);
    expect(result.exitCode, result.output).toBe(2);
    expect(result.output).toContain("Parsing source files: 0 / 20 files parsed");
    expect(result.output).toContain("Parsing source files: 20 / 20 files parsed");
    expect(result.output).toContain("Resolving code references");
    expect(result.output).toContain("Validating the rebuilt graph");
    expect(result.output).toContain("Saving the verified graph");
    expect(result.output).toContain("Population prompt:");
    expect(result.output).not.toContain("Choose your AI tools");
    expect(existsSync(join(f.project, ".mex/graph.db"))).toBe(true);
    expect(existsSync(f.record)).toBe(false);
  });

  it("shows a graph worker heap-limit failure and retains its diagnostics after leaving the HUD", async () => {
    const f = fixture("incomplete");
    codeRepository(f, 3);
    // Keep this copied runtime outside the indexed project. Only its worker is
    // replaced; the actual built CLI, supervisor, setup engine, and HUD run.
    const runtime = join(f.root, "runtime");
    mkdirSync(runtime);
    cpSync(join(repo, "dist"), join(runtime, "dist"), { recursive: true });
    symlinkSync(join(repo, "node_modules"), join(runtime, "node_modules"), "dir");
    symlinkSync(join(repo, "templates"), join(runtime, "templates"), "dir");
    cpSync(join(repo, "package.json"), join(runtime, "package.json"));
    f.cli = join(runtime, "dist/cli.js");
    f.workerRecord = join(f.root, "graph-worker.json");
    f.env.MEX_PTY_GRAPH_RECORD = f.workerRecord;
    writeFileSync(join(runtime, "dist/graph-candidate.js"), String.raw`
import { writeFileSync, writeSync } from "node:fs";
process.once("message", request => {
  writeFileSync(process.env.MEX_PTY_GRAPH_RECORD, JSON.stringify({ pid: process.pid, workspace: request.workspace, candidatePath: request.candidatePath }));
  writeFileSync(request.candidatePath, "unpublished partial candidate\n");
  process.send({ type: "progress", progress: { phase: "parse", completed: 1, total: 3 } }, () => {
    writeSync(2, "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\nMEX_PTY_HEAP_SENTINEL\n");
    process.exit(17);
  });
});
process.send({ type: "ready" });
`);

    const result = await terminal(f, ["--mode", "code-repo", "--tool", "none"], [
      { expect: "Choose your AI tools", input: "\r" },
      { expect: "heap limit" },
      { expect: "d diagnostics", input: "d" },
      { expect: "Details" },
      { expect: "MEX_PTY_HEAP_SENTINEL", input: "d" },
      { expect: "> Retry setup", input: "\u001b[B" },
      { expect: "> Exit setup", input: "\r" },
    ], { columns: 80, rows: 24 });

    expect(result.exitCode, result.output).toBe(1);
    expect(result.output).toContain("Setup needs attention");
    expect(result.output).toContain("d diagnostics");
    expect(result.output).toContain("NODE_OPTIONS=--max-old-space-size");
    // Assertions after the final alternate-screen exit prove these details
    // survive teardown, rather than existing only in a discarded HUD frame.
    const exitScreen = "\u001b[?1049l";
    expect(result.raw).toContain(exitScreen);
    const restoredAt = result.raw.lastIndexOf(exitScreen);
    expect(result.raw.slice(0, restoredAt)).toContain("JavaScript heap limit");
    expect(result.raw.slice(0, restoredAt)).toContain("d diagnostics");
    const summary = result.raw.slice(restoredAt + exitScreen.length);
    expect(summary).toContain("JavaScript heap limit");
    expect(summary).toContain("last progress: parse 1/3 files");
    expect(summary).toContain("MEX_PTY_HEAP_SENTINEL");
    expect(summary).toContain("FATAL ERROR: Reached heap limit");
    expect(existsSync(f.record)).toBe(false);
    expect(existsSync(join(f.project, ".mex/graph.db"))).toBe(false);
    const worker = JSON.parse(readFileSync(f.workerRecord, "utf8")) as { pid: number; workspace: string; candidatePath: string };
    expect(isAlive(worker.pid)).toBe(false);
    expect(existsSync(worker.workspace)).toBe(false);
    expect(existsSync(worker.candidatePath)).toBe(false);
    expect(readdirSync(join(f.project, ".mex")).filter(name => name.startsWith("graph.db"))).toEqual([]);
  });

  it("piped terminal setup uses the plain path without waiting or launching an agent", () => {
    const f = fixture("complete");
    const result = spawnSync(process.execPath, [cli, ...args()], { cwd: f.project, env: f.env, encoding: "utf8", timeout: 20_000, maxBuffer: 1024 * 1024 });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(2);
    expect(result.stdout).toContain("Setup paused");
    expect(result.stdout).not.toContain("Choose your AI tools");
    expect(existsSync(join(f.project, ".mex/config.json"))).toBe(true);
    expect(existsSync(f.record)).toBe(false);
  });

  it("--dry-run remains read-only in a real terminal and never starts an agent", async () => {
    const f = fixture("complete");
    const result = await terminal(f, ["--dry-run"]);
    expect(result.exitCode, result.output).toBe(0);
    expect(result.output).toContain("DRY RUN");
    expect(result.output).toContain("Dry run complete");
    expect(result.output).not.toContain("Choose your AI tools");
    expect(result.raw).not.toContain("\u001b[?1049h");
    expect(readdirSync(f.project)).toEqual([]);
    expect(existsSync(f.record)).toBe(false);
  });
});

function args(extra: string[] = [], defaultTool = true): string[] {
  return ["setup", ...(extra.includes("--mode") ? [] : ["--mode", "agent-memory"]), ...(!defaultTool || extra.includes("--tool") ? [] : ["--tool", "codex"]), "--no-open", ...extra];
}

function codeRepository(f: Fixture, files = 20): void {
  execFileSync("git", ["-c", "init.templateDir=", "init", "--quiet"], { cwd: f.project, stdio: "pipe", env: f.env });
  mkdirSync(join(f.project, "src"));
  for (let index = 0; index < files; index++) {
    writeFileSync(join(f.project, "src", `module-${index}.ts`), `export function calculate${index}(value: number): number { return value + ${index}; }\n`);
  }
}

function fixture(mode: "incomplete" | "failed" | "complete" | "hold"): Fixture {
  const root = mkdtempSync(join(tmpdir(), "mex-setup-pty-"));
  const project = join(root, "project");
  const bin = join(root, "bin");
  const record = join(root, "agent.json");
  mkdirSync(project); mkdirSync(bin);
  // Both launchable agents are fake, including when a selection regression
  // chooses Claude instead of the highlighted Codex integration.
  for (const command of ["codex", "claude"]) {
    const executable = join(bin, command);
    writeFileSync(executable, `#!${pythonPath}\n${FAKE_AGENT}`);
    chmodSync(executable, 0o755);
  }
  // A --no-open regression must never launch the developer's actual browser.
  for (const command of ["open", "xdg-open"]) {
    const launcher = join(bin, command);
    writeFileSync(launcher, `#!${pythonPath}\nimport os, pathlib\npathlib.Path(os.environ["MEX_PTY_BROWSER_RECORD"]).write_text("unexpected browser launch")\n`);
    chmodSync(launcher, 0o755);
  }
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: [bin, dirname(process.execPath), process.env.PATH].join(":"), TERM: "xterm-256color", MEX_TELEMETRY: "0", DO_NOT_TRACK: "1", MEX_PTY_FAKE_MODE: mode, MEX_PTY_RECORD: record, MEX_PTY_BROWSER_RECORD: join(root, "browser-open") };
  delete env.CI; delete env.NO_COLOR; delete env.FORCE_COLOR;
  const f = { root, project, record, env };
  fixtures.push(f);
  return f;
}

function terminal(f: Fixture, extra: string[] = [], actions: Action[] = [], options: { columns?: number; rows?: number; defaultTool?: boolean; command?: string[] } = {}): Promise<Result> {
  return new Promise((resolve, reject) => {
    const child = execFile(pythonPath!, [harness], { encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) { reject(new Error(`PTY harness failed: ${error.message}\n${stderr}\n${stdout.slice(-4000)}`)); return; }
      try {
        const result = JSON.parse(stdout) as Result;
        if (result.error) throw new Error(`${result.error} (CLI exit ${result.exitCode})\nCompleted actions: ${JSON.stringify(result.events)}\n${result.output.slice(-4000)}`);
        resolve(result);
      } catch (error) { reject(error); }
    });
    child.stdin!.end(JSON.stringify({ command: [process.execPath, f.cli ?? cli, ...(options.command ?? args(extra, options.defaultTool !== false))], cwd: f.project, env: f.env, unsetEnv: ["CI", "NO_COLOR", "FORCE_COLOR"], columns: options.columns ?? 140, rows: options.rows ?? 40, actions, timeoutMs: 25_000 }));
  });
}

function agentRecord(f: Fixture): AgentRecord { return JSON.parse(readFileSync(f.record, "utf8")); }
function expectPromptCleaned(f: Fixture): void {
  const local = join(f.project, ".mex/local");
  expect(existsSync(local) ? readdirSync(local).filter(name => name.startsWith("setup-population-")) : []).toEqual([]);
}
function isAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }
function canConnect(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const finish = (connected: boolean) => { socket.destroy(); resolve(connected); };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(1000, () => finish(false));
  });
}

const FAKE_AGENT = String.raw`
import json, os, pathlib, re, signal, sys, termios

target = pathlib.Path(os.environ["MEX_PTY_RECORD"])
mode = os.environ["MEX_PTY_FAKE_MODE"]
flags = termios.tcgetattr(0)[3]
pointer = re.search(r"\x60([^\x60]+prompt\.md)\x60", " ".join(sys.argv[1:]))
record = {
    "pid": os.getpid(), "agent": pathlib.Path(sys.argv[0]).name, "argv": sys.argv[1:],
    "stdinTTY": os.isatty(0), "stdoutTTY": os.isatty(1), "stderrTTY": os.isatty(2),
    "canonical": bool(flags & termios.ICANON), "echo": bool(flags & termios.ECHO),
    "promptExists": bool(pointer and pathlib.Path(pointer.group(1)).is_file()),
}
target.write_text(json.dumps(record))
print("MEX_PTY_CHILD_READY", flush=True)
if mode == "hold":
    signal.pause()
else:
    record["input"] = sys.stdin.readline().rstrip("\r\n")
    target.write_text(json.dumps(record))
    if mode == "complete":
        for path in pathlib.Path(".mex").rglob("*.md"):
            content = path.read_text().replace("[Project Name]", "PTY fixture").replace("[Agent / Workspace Name]", "PTY fixture").replace("[YYYY-MM-DD]", "2026-01-01")
            path.write_text(content)
    print("MEX_PTY_CHILD_DONE", flush=True)
    sys.exit(7 if mode == "failed" else 0)
`;
