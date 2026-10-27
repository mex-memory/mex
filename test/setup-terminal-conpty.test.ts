/**
 * Terminal setup acceptance on Windows (#311): the built CLI in a real
 * Windows console (ConPTY, through node-pty), with a fake native agent behind
 * `codex` and `claude` shims.
 *
 * The POSIX suite (setup-terminal-pty.test.ts) drives a PTY through Python's
 * pty/termios modules, which Windows does not have. This suite covers the
 * same terminal surface there: the tool picker, cancelling, handing the real
 * console to a native agent and getting it back, recovery after a failed
 * agent, and finishing a populated setup through the Hub link.
 *
 * node-pty is not a project dependency, so ordinary installs stay free of a
 * native module; the Windows CI job installs it for this run. Without it the
 * suite is skipped locally and fails in CI, so it cannot vanish silently.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createConnection } from "node:net";
import { release, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

interface PtyProcess {
  on(event: "error", listener: (error: Error) => void): void;
  onData(listener: (data: string) => void): void;
  onExit(listener: (event: { exitCode: number }) => void): void;
  write(data: string): void;
  kill(): void;
}
interface PtyModule {
  spawn(file: string, args: string[], options: { name: string; cols: number; rows: number; cwd: string; env: NodeJS.ProcessEnv; useConpty: true }): PtyProcess;
}

const repo = fileURLToPath(new URL("..", import.meta.url));
const cli = join(repo, "dist", "cli.js");
const { pty, skipReason } = await loadPty();
const requireCoverage = process.platform === "win32" && Boolean(process.env.CI);
const fixtures: Fixture[] = [];

interface Fixture { root: string; project: string; record: string; env: NodeJS.ProcessEnv }
interface Action { expect: string; regex?: boolean; missing?: string[]; input?: string; probe?: boolean; timeout?: number }
interface Result { exitCode: number; output: string; events: Array<{ match: string; connected?: boolean }> }
interface AgentRecord { pid: number; agent: string; argv: string[]; stdinTTY: boolean; stdoutTTY: boolean; promptExists: boolean; input?: string }

beforeAll(() => {
  if (requireCoverage && skipReason) {
    throw new Error(`Windows CI requires ConPTY coverage: ${skipReason}. Install node-pty@1.1.0 and use Windows 10 build 17763 or newer.`);
  }
  if (!skipReason && !existsSync(cli)) throw new Error("Build dist/cli.js with npm run build before running the ConPTY acceptance tests.");
});

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    try {
      if (existsSync(fixture.record)) {
        const { pid } = agentRecord(fixture);
        try { await expect.poll(() => isAlive(pid), { timeout: 3000 }).toBe(false); }
        finally { if (isAlive(pid)) process.kill(pid); }
      }
    } finally {
      rmSync(fixture.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }
});

describe.skipIf(Boolean(skipReason) && !requireCoverage)(`built terminal setup in a Windows console${skipReason ? ` (${skipReason})` : ""}`, { timeout: 60_000 }, () => {
  it("shows the banner and tool picker before any setup writes, then cancels with Ctrl+C", async () => {
    const f = fixture("incomplete");
    const result = await terminal(f, ["setup", "--mode", "agent-memory", "--no-open"], [
      { expect: "Choose your AI tools", missing: [".mex", ".agents", "AGENTS.md", ".gitignore"], input: "\u0003" },
    ], { columns: 80, rows: 24 });
    expect(result.exitCode, result.output).toBe(130);
    expect(result.output).toContain("88888b.d88b.");
    expect(result.output).toContain("Codex");
    expect(result.output).toContain("Setup cancelled.");
    expect(readdirSync(f.project)).toEqual([]);
    expect(existsSync(f.record)).toBe(false);
  });

  it("hands the real console to the native agent, takes keyboard input, and returns to the menu", async () => {
    const f = fixture("incomplete");
    const result = await terminal(f, setupArgs(), [
      { expect: "Choose your AI tools", input: "\r" },
      { expect: "MEX_PTY_CHILD_READY", input: "hello native agent\r" },
      { expect: "required scaffold placeholders remain", input: "\u001b[A" },
      { expect: "> Finish later", input: "\r" },
    ]);
    expect(result.exitCode, result.output).toBe(2);
    expect(result.output).toContain("Opening Codex");
    expect(result.output).toContain("Setup paused at population");
    expect(agentRecord(f)).toMatchObject({ agent: "codex", stdinTTY: true, stdoutTTY: true, promptExists: true, input: "hello native agent" });
    expect(agentRecord(f).argv.join(" ")).toContain("Read the full setup population prompt");
    expect(JSON.parse(readFileSync(join(f.project, ".mex", "config.json"), "utf8")).aiTools).toEqual(["codex"]);
    expectPromptCleaned(f);
  });

  it("Space toggles multiple tools and Continue launches the checked native agent", async () => {
    const f = fixture("incomplete");
    const result = await terminal(f, setupArgs(), [
      { expect: "> [x] Codex", input: " " },
      { expect: "> [ ] Codex", input: "\u001b[A" },
      { expect: "> [ ] OpenCode", input: "\u001b[A" },
      { expect: "> [ ] Copilot", input: "\u001b[A" },
      { expect: "> [ ] Windsurf", input: "\u001b[A" },
      { expect: "> [ ] Cursor", input: "\u001b[A" },
      { expect: "> [ ] Claude Code", input: " " },
      { expect: "> [x] Claude Code", input: "\u001b[B" },
      { expect: "> [ ] Cursor", input: " " },
      { expect: "> [x] Cursor", input: "\u001b[A" },
      { expect: "> [x] Claude Code", input: "\u001b[A" },
      { expect: "> Continue with selected tools", input: "\r" },
      { expect: "MEX_PTY_CHILD_READY", input: "space selection\r" },
      { expect: "required scaffold placeholders remain", input: "\u001b[A" },
      { expect: "> Finish later", input: "\r" },
    ]);
    expect(result.exitCode, result.output).toBe(2);
    expect(agentRecord(f)).toMatchObject({ agent: "claude", input: "space selection", stdinTTY: true, stdoutTTY: true });
    expect(JSON.parse(readFileSync(join(f.project, ".mex", "config.json"), "utf8")).aiTools).toEqual(["claude", "cursor"]);
    expectPromptCleaned(f);
  });

  it("Continue without an agent writes no tool selection and pauses without launching one", async () => {
    const f = fixture("incomplete");
    const result = await terminal(f, ["setup", "--mode", "agent-memory", "--tool", "none", "--no-open"], [
      { expect: "> Continue without an agent", missing: [".mex"], input: "\r" },
      { expect: "> Show setup prompt", input: "\u001b[A" },
      { expect: "> Finish later", input: "\r" },
    ]);
    expect(result.exitCode, result.output).toBe(2);
    expect(result.output).toContain("Setup paused at population");
    expect(JSON.parse(readFileSync(join(f.project, ".mex", "config.json"), "utf8")).aiTools).toEqual([]);
    expect(existsSync(f.record)).toBe(false);
  });

  it("cleans the console and active fake agent after a driver timeout", async () => {
    const f = fixture("incomplete");
    await expect(terminal(f, setupArgs(), [
      { expect: "Choose your AI tools", input: "\r" },
      { expect: "MEX_PTY_CHILD_READY" },
      { expect: "THIS_SCREEN_MUST_NEVER_APPEAR", timeout: 1000 },
    ])).rejects.toThrow("timed out waiting for");
    expect(existsSync(f.record)).toBe(true);
    await expect.poll(() => isAlive(agentRecord(f).pid), { timeout: 3000 }).toBe(false);
  });

  it("returns to recovery after a failed native agent and pauses on Finish later", async () => {
    const f = fixture("failed");
    const result = await terminal(f, setupArgs(), [
      { expect: "Choose your AI tools", input: "\r" },
      { expect: "MEX_PTY_CHILD_READY", input: "finish\r" },
      { expect: "Codex stopped before a clean exit", input: "\u001b[A" },
      { expect: "> Finish later", input: "\r" },
    ]);
    expect(result.exitCode, result.output).toBe(2);
    expect(result.output).toContain("Setup paused at population");
    expect(result.output).toContain("Run `mex setup` to continue");
    expectPromptCleaned(f);
  });

  it.each(["agent-memory", "code-repo"])("finishes a populated %s setup and serves the Hub link until q", async (mode) => {
    const f = fixture("complete");
    if (mode === "code-repo") {
      execFileSync("git", ["-c", "init.templateDir=", "init", "--quiet"], { cwd: f.project, env: f.env });
      writeFileSync(join(f.project, "sample.ts"), "export function increment(value: number): number { return value + 1; }\n");
    }
    const args = setupArgs();
    args[2] = mode;
    const result = await terminal(f, args, [
      { expect: "Choose your AI tools", input: "\r" },
      { expect: "MEX_PTY_CHILD_READY", input: "populate\r" },
      { expect: "http://127\\.0\\.0\\.1:[0-9]+/#token=[A-Za-z0-9_-]+", regex: true, probe: true, input: "q" },
    ]);
    expect(result.exitCode, result.output).toBe(0);
    expect(result.output).toContain("Continue in your browser");
    expect(result.events[2]!.connected).toBe(true);
    expect(result.output).toContain("Hub stopped");
    const address = new URL(result.events[2]!.match);
    expect(await canConnect(Number(address.port))).toBe(false);
    expect(readFileSync(join(f.project, ".mex", "AGENTS.md"), "utf8")).not.toContain("[YYYY-MM-DD]");
    expect(existsSync(join(f.project, ".mex", "graph.db"))).toBe(mode === "code-repo");
    expect(existsSync(join(f.project, ".mex", "wiki.db"))).toBe(mode === "code-repo");
    expectPromptCleaned(f);
  });

  it("keeps --yes plain in a real console: scaffold written, no agent started", async () => {
    const f = fixture("incomplete");
    const result = await terminal(f, ["setup", "--mode", "agent-memory", "--tool", "codex", "--yes", "--no-open"], []);
    expect(result.exitCode, result.output).toBe(2);
    expect(result.output).not.toContain("Choose your AI tools");
    expect(existsSync(join(f.project, ".mex", "AGENTS.md"))).toBe(true);
    expect(existsSync(f.record)).toBe(false);
  });
});

function setupArgs(): string[] {
  return ["setup", "--mode", "agent-memory", "--tool", "codex", "--no-open"];
}

function fixture(mode: "incomplete" | "failed" | "complete"): Fixture {
  const root = mkdtempSync(join(tmpdir(), "mex-setup-conpty-"));
  const project = join(root, "project");
  const bin = join(root, "bin");
  const record = join(root, "agent.json");
  mkdirSync(project);
  mkdirSync(bin);
  const agent = join(root, "agent.cjs");
  writeFileSync(agent, FAKE_AGENT, "utf8");
  // Both launchable agents are fake, including when a selection regression
  // would choose Claude instead of the highlighted Codex integration.
  for (const command of ["codex", "claude"]) {
    writeFileSync(join(bin, `${command}.cmd`), `@"${process.execPath}" "${agent}" ${command} %*\r\n`, "utf8");
  }
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Windows environment names are case-insensitive: replace every PATH spelling.
  for (const key of Object.keys(env)) if (key.toLowerCase() === "path") delete env[key];
  env.PATH = [bin, dirname(process.execPath), process.env.PATH ?? ""].join(delimiter);
  Object.assign(env, { TERM: "xterm-256color", MEX_TELEMETRY: "0", DO_NOT_TRACK: "1", MEX_PTY_FAKE_MODE: mode, MEX_PTY_RECORD: record, MEX_HOME: join(root, "home") });
  delete env.CI;
  delete env.NO_COLOR;
  delete env.FORCE_COLOR;
  const f = { root, project, record, env };
  fixtures.push(f);
  return f;
}

/** Run the CLI in a ConPTY, answering each expected screen with its input. */
async function terminal(f: Fixture, args: string[], actions: Action[], options: { columns?: number; rows?: number } = {}): Promise<Result> {
  const child = pty!.spawn(process.execPath, [cli, ...args], {
    name: "xterm-256color", cols: options.columns ?? 140, rows: options.rows ?? 40, cwd: f.project, env: f.env, useConpty: true,
  });
  let exited = false;
  const closed = new Promise<void>(resolve => child.onExit(() => { exited = true; resolve(); }));
  try {
    return await new Promise((resolve, reject) => {
      let raw = "";
      let searchFrom = 0;
      let step = 0;
      let busy = false;
      let settled = false;
      let exitCode: number | null = null;
      const events: Result["events"] = [];
      const timedOut = (): void => {
        fail(new Error(`ConPTY step ${step} timed out waiting for ${JSON.stringify(actions[step]?.expect ?? "exit")}\n${plain(raw).slice(-4000)}`));
      };
      let deadline = setTimeout(timedOut, 50_000);
      const fail = (error: unknown): void => {
        settled = true;
        clearTimeout(deadline);
        reject(error);
      };
      const finish = (): void => {
        settled = true;
        clearTimeout(deadline);
        resolve({ exitCode: exitCode!, output: plain(raw), events });
      };
      const advance = async (): Promise<void> => {
        if (busy || settled) return;
        busy = true;
        try {
          while (step < actions.length) {
            const action = actions[step]!;
            const text = plain(raw).slice(searchFrom);
            const match = action.regex ? new RegExp(action.expect, "u").exec(text)?.[0] : text.includes(action.expect) ? action.expect : undefined;
            if (match === undefined) return;
            searchFrom += text.indexOf(match) + match.length;
            for (const path of action.missing ?? []) {
              if (existsSync(join(f.project, path))) throw new Error(`${path} exists before the screen that should precede any write`);
            }
            const event: Result["events"][number] = { match };
            if (action.probe) event.connected = await canConnect(Number(new URL(match).port));
            events.push(event);
            step += 1;
            if (actions[step]?.timeout !== undefined) {
              clearTimeout(deadline);
              deadline = setTimeout(timedOut, actions[step]!.timeout);
            }
            if (action.input !== undefined) child.write(action.input);
          }
        } catch (error) {
          fail(error);
        } finally {
          busy = false;
          if (exitCode !== null && !settled) {
            if (step >= actions.length) finish();
            else fail(new Error(`CLI exited ${exitCode} before ${JSON.stringify(actions[step]!.expect)}\n${plain(raw).slice(-4000)}`));
          }
        }
      };
      child.onData((data) => {
        if (settled) return;
        raw += data;
        if (raw.length > 2 * 1024 * 1024) {
          fail(new Error("ConPTY output exceeded the 2 MiB acceptance limit"));
          return;
        }
        void advance();
      });
      child.onExit(({ exitCode: code }) => {
        exitCode = code;
        // A pending async Hub probe finishes before the final exit decision.
        void advance();
      });
    });
  } finally {
    // Also release ConPTY's handles after normal exit. On timeout/assertion
    // failure kill the whole console before the fixture is removed.
    child.kill();
    if (!exited) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([closed, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("ConPTY did not exit after cleanup")), 5000);
        })]);
      } finally { clearTimeout(timer); }
    }
  }
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Console output as text: VT sequences removed, line endings normalized. */
function plain(raw: string): string {
  return raw
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/gu, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/\u001b[@-Z\\-_]/gu, "")
    .replace(/\r\n?/gu, "\n");
}

async function loadPty(): Promise<{ pty: PtyModule | null; skipReason?: string }> {
  if (process.platform !== "win32") return { pty: null, skipReason: "Windows only; POSIX uses setup-terminal-pty" };
  const [major, , build] = release().split(".").map(Number);
  if (major! < 10 || (major === 10 && build! < 17763)) return { pty: null, skipReason: `ConPTY requires Windows 10 build 17763 or newer (found ${release()})` };
  try {
    const pty = createRequire(import.meta.url)("node-pty") as PtyModule;
    // Loading the JS package alone does not prove the native backend works.
    // ConPTY repaints output (a space can become a cursor move) and can report
    // exit before delivering it, so the probe prints one plain token, stays
    // alive, and the verdict comes from its output, not its exit.
    const child = pty.spawn(process.execPath, ["-e", "process.stdout.write(process.stdin.isTTY && process.stdout.isTTY ? 'CONPTY_TTY_YES\\n' : 'CONPTY_TTY_NO\\n'); setTimeout(() => {}, 10000)"], {
      name: "xterm-256color", cols: 80, rows: 24, cwd: repo, env: process.env, useConpty: true,
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        let output = "";
        timer = setTimeout(() => reject(new Error("ConPTY startup probe timed out")), 5000);
        child.on("error", reject);
        child.onData(data => {
          output = (output + plain(data)).slice(-1000);
          if (output.includes("CONPTY_TTY_YES")) resolve();
          else if (output.includes("CONPTY_TTY_NO")) reject(new Error("ConPTY startup probe ran without a real TTY"));
        });
        child.onExit(({ exitCode }) => reject(new Error(`ConPTY startup probe exited ${exitCode} before reporting a TTY`)));
      });
    } finally {
      clearTimeout(timer);
      child.kill();
    }
    return { pty };
  } catch (error) {
    return { pty: null, skipReason: `node-pty unavailable: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function agentRecord(f: Fixture): AgentRecord {
  return JSON.parse(readFileSync(f.record, "utf8")) as AgentRecord;
}

function expectPromptCleaned(f: Fixture): void {
  const local = join(f.project, ".mex", "local");
  expect(existsSync(local) ? readdirSync(local).filter((name) => name.startsWith("setup-population-")) : []).toEqual([]);
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const done = (connected: boolean): void => { socket.destroy(); resolve(connected); };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(1000, () => done(false));
  });
}


/** The fake native agent: plain Node, so it runs wherever the CLI does. */
const FAKE_AGENT = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const target = process.env.MEX_PTY_RECORD;
const mode = process.env.MEX_PTY_FAKE_MODE;
const args = process.argv.slice(3);
const pointer = /\x60([^\x60]+prompt\.md)\x60/u.exec(args.join(" "));
const record = {
  pid: process.pid, agent: process.argv[2], argv: args,
  stdinTTY: Boolean(process.stdin.isTTY), stdoutTTY: Boolean(process.stdout.isTTY),
  promptExists: Boolean(pointer && fs.existsSync(pointer[1])),
};
fs.writeFileSync(target, JSON.stringify(record));
process.stdout.write("MEX_PTY_CHILD_READY\n");
let line = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  line += chunk;
  const end = line.search(/\r|\n/u);
  if (end < 0) return;
  record.input = line.slice(0, end);
  fs.writeFileSync(target, JSON.stringify(record));
  if (mode === "complete") {
    const walk = (directory) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) walk(file);
        else if (entry.name.endsWith(".md")) {
          const text = fs.readFileSync(file, "utf8");
          const next = text.replaceAll("[Project Name]", "PTY fixture").replaceAll("[Agent / Workspace Name]", "PTY fixture").replaceAll("[YYYY-MM-DD]", "2026-01-01");
          if (next !== text) {
            const slot = /^## (?:What This Is|Current (?:Project|Operational) State)[^\n]*\r?\n/m.exec(next);
            const at = slot ? slot.index + slot[0].length : next.length;
            fs.writeFileSync(file, next.slice(0, at) + "\nAuthored project guidance from source inspection.\n" + next.slice(at));
          }
        }
      }
    };
    walk(".mex");
  }
  process.stdout.write("MEX_PTY_CHILD_DONE\n");
  process.exit(mode === "failed" ? 7 : 0);
});
`;
