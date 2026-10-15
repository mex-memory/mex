import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HOOK_INSTRUCTIONS_END, HOOK_INSTRUCTIONS_START } from "../instructions.js";
import { HOOK_SPECS, isManagedCommand, MEX_HOOK_MARKER } from "../claude-settings.js";
import { findBinOnPath, resolveHookCommand } from "../command.js";
import { runHooksInstall, runHooksRemove, runHooksStatus, type HooksIo } from "../cli.js";

let root: string;
let bin: string;
let entry: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mex-hooks-"));
  mkdirSync(join(root, ".mex"));
  writeFileSync(join(root, ".mex", "ROUTER.md"), "# Router\n");
  bin = mkdtempSync(join(tmpdir(), "mex-hooks-bin-"));
  entry = join(bin, "dist", "hook.js");
  mkdirSync(join(bin, "dist"));
  writeFileSync(entry, "// hook\n");
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(bin, { recursive: true, force: true });
});

const settingsPath = (): string => join(root, ".claude", "settings.json");
const claudeMd = (): string => join(root, "CLAUDE.md");
const readJson = (): any => JSON.parse(readFileSync(settingsPath(), "utf8"));

interface Run {
  io: HooksIo;
  out: string[];
  err: string[];
  exit: () => number;
}

/** Command resolution pinned to the built bundle (an empty PATH), or to a `mex-hook` shim on PATH. */
function run(options: { shim?: boolean } = {}): Run {
  const out: string[] = [];
  const err: string[] = [];
  let code = 0;
  const shimDir = mkdtempSync(join(tmpdir(), "mex-hooks-shim-"));
  if (options.shim) writeFileSync(join(shimDir, process.platform === "win32" ? "mex-hook.cmd" : "mex-hook"), "shim\n");
  return {
    io: {
      cwd: root,
      write: (line) => out.push(line),
      writeError: (line) => err.push(line),
      setExitCode: (value) => {
        code = value;
      },
      resolve: { env: { PATH: shimDir }, entryCandidates: [entry] },
    },
    out,
    err,
    exit: () => code,
  };
}

const USER_SETTINGS = {
  permissions: { allow: ["Bash(npm test)"] },
  hooks: {
    UserPromptSubmit: [{ hooks: [{ type: "command", command: "echo user-prompt", timeout: 5 }] }],
    PostToolUse: [
      { matcher: "Bash", hooks: [{ type: "command", command: "echo user-bash" }] },
      { matcher: "Write", hooks: [{ type: "command", command: "prettier --write" }] },
    ],
    Stop: [{ hooks: [{ type: "command", command: "echo user-stop" }] }],
  },
  model: "sonnet",
};

describe("mex hooks install", () => {
  it("creates the settings entries and the CLAUDE.md block", () => {
    const r = run();
    runHooksInstall(r.io, { tool: "claude" });
    expect(r.exit()).toBe(0);
    const settings = readJson();
    expect(settings.hooks.UserPromptSubmit).toHaveLength(1);
    expect(settings.hooks.PostToolUse.map((g: any) => g.matcher)).toEqual(["Read", "Edit|Write|MultiEdit", "Grep", "Bash"]);
    expect(settings.hooks.Stop).toHaveLength(1);
    const commands = [...settings.hooks.UserPromptSubmit, ...settings.hooks.PostToolUse, ...settings.hooks.Stop].flatMap((g: any) => g.hooks.map((h: any) => h.command));
    expect(commands).toHaveLength(HOOK_SPECS.length);
    for (const command of commands) {
      expect(isManagedCommand(command)).toBe(true);
      expect(command).toBe(`node "${entry.replace(/\\/g, "/")}" ${MEX_HOOK_MARKER}`);
    }
    const md = readFileSync(claudeMd(), "utf8");
    expect(md).toContain(HOOK_INSTRUCTIONS_START);
    expect(md).toContain("Never edit the `mex:entity` comment blocks");
    expect(md).toContain(HOOK_INSTRUCTIONS_END);
  });

  it("prefers the mex-hook bin when it resolves on PATH", () => {
    const r = run({ shim: true });
    runHooksInstall(r.io, { tool: "claude" });
    expect(readJson().hooks.UserPromptSubmit[0].hooks[0].command).toBe(`mex-hook ${MEX_HOOK_MARKER}`);
    const s = run({ shim: true });
    runHooksStatus(s.io, { tool: "claude" });
    expect(s.out.join("\n")).toContain("mex-hook bin on PATH");
  });

  it("is idempotent: a second install changes no byte", () => {
    runHooksInstall(run().io, { tool: "claude" });
    const settings = readFileSync(settingsPath(), "utf8");
    const md = readFileSync(claudeMd(), "utf8");
    const r = run();
    runHooksInstall(r.io, { tool: "claude" });
    expect(readFileSync(settingsPath(), "utf8")).toBe(settings);
    expect(readFileSync(claudeMd(), "utf8")).toBe(md);
    expect(r.out.join("\n")).toContain("already installed");
  });

  it("keeps every user entry, key and the file's indentation", () => {
    mkdirSync(join(root, ".claude"));
    writeFileSync(settingsPath(), `${JSON.stringify(USER_SETTINGS, null, "\t")}\n`);
    runHooksInstall(run().io, { tool: "claude" });
    const text = readFileSync(settingsPath(), "utf8");
    expect(text).toContain('\n\t"permissions"');
    const settings = readJson();
    expect(settings.model).toBe("sonnet");
    expect(settings.permissions).toEqual(USER_SETTINGS.permissions);
    // The user's Stop group is first and unmixed; MEX's own Stop group follows it.
    expect(settings.hooks.Stop).toHaveLength(2);
    expect(settings.hooks.Stop[0]).toEqual(USER_SETTINGS.hooks.Stop[0]);
    expect(isManagedCommand(settings.hooks.Stop[1].hooks[0].command)).toBe(true);
    // The user's groups are still first and unmixed; MEX's own Bash group sits beside the user's.
    expect(settings.hooks.UserPromptSubmit[0]).toEqual(USER_SETTINGS.hooks.UserPromptSubmit[0]);
    expect(settings.hooks.PostToolUse.slice(0, 2)).toEqual(USER_SETTINGS.hooks.PostToolUse);
    const userBash = settings.hooks.PostToolUse.filter((g: any) => g.matcher === "Bash");
    expect(userBash).toHaveLength(2);
    expect(userBash[0].hooks).toEqual([{ type: "command", command: "echo user-bash" }]);
  });

  it("keeps CRLF line endings", () => {
    mkdirSync(join(root, ".claude"));
    writeFileSync(settingsPath(), `{\r\n  "model": "opus"\r\n}\r\n`);
    runHooksInstall(run().io, { tool: "claude" });
    const text = readFileSync(settingsPath(), "utf8");
    expect(text).toContain("\r\n");
    expect(text.replace(/\r\n/g, "")).not.toContain("\n");
  });

  it("updates an older MEX install in place, without duplicates", () => {
    const r = run();
    runHooksInstall(r.io, { tool: "claude" });
    const settings = readJson();
    settings.hooks.PostToolUse[0].hooks[0].command = `node "/old/place/hook.js" ${MEX_HOOK_MARKER}`;
    settings.hooks.PostToolUse.push({ matcher: "Glob", hooks: [{ type: "command", command: `node "/old/place/hook.js" ${MEX_HOOK_MARKER}` }] });
    writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
    runHooksInstall(run().io, { tool: "claude" });
    const after = readJson();
    expect(after.hooks.PostToolUse.map((g: any) => g.matcher)).toEqual(["Read", "Edit|Write|MultiEdit", "Grep", "Bash"]);
    expect(JSON.stringify(after)).not.toContain("/old/place");
  });

  it("--dry-run prints the diff and writes nothing", () => {
    const r = run();
    runHooksInstall(r.io, { tool: "claude", dryRun: true });
    expect(r.exit()).toBe(0);
    expect(existsSync(settingsPath())).toBe(false);
    expect(existsSync(claudeMd())).toBe(false);
    const output = r.out.join("\n");
    expect(output).toContain("Would install");
    expect(output).toContain("+++ b/.claude/settings.json");
    expect(output).toContain(`+            "command": "node`);
    expect(output).toContain("+++ b/CLAUDE.md");
    expect(output).toContain(`+${HOOK_INSTRUCTIONS_START}`);
  });

  it("refuses a settings file that is not JSON and leaves it alone", () => {
    mkdirSync(join(root, ".claude"));
    writeFileSync(settingsPath(), "{ // comments are not JSON\n}");
    const r = run();
    runHooksInstall(r.io, { tool: "claude" });
    expect(r.exit()).toBe(1);
    expect(r.err.join("\n")).toContain("not valid JSON");
    expect(readFileSync(settingsPath(), "utf8")).toBe("{ // comments are not JSON\n}");
    expect(existsSync(claudeMd())).toBe(false);
  });

  it("fails with a reason outside a MEX project, for an unsupported tool and without any hook command", () => {
    const elsewhere = mkdtempSync(join(tmpdir(), "mex-hooks-none-"));
    try {
      const outside = run();
      outside.io.cwd = elsewhere;
      runHooksInstall(outside.io, { tool: "claude", json: true });
      expect(outside.exit()).toBe(1);
      expect(JSON.parse(outside.out[0]!).diagnostics[0].code).toBe("HOOKS_NO_SCAFFOLD");
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
    const cursor = run();
    runHooksInstall(cursor.io, { tool: "cursor" });
    expect(cursor.exit()).toBe(1);
    expect(cursor.err.join("\n")).toContain("not supported");
    const none = run();
    none.io.resolve = { env: { PATH: "" }, entryCandidates: [join(bin, "missing.js")] };
    runHooksInstall(none.io, { tool: "claude", json: true });
    expect(JSON.parse(none.out[0]!).diagnostics[0].code).toBe("HOOKS_NO_COMMAND");
  });

  it("appends its block to an existing CLAUDE.md and refuses malformed markers", () => {
    writeFileSync(claudeMd(), "# Mine\n\nHand written.\n");
    runHooksInstall(run().io, { tool: "claude" });
    const md = readFileSync(claudeMd(), "utf8");
    expect(md.startsWith("# Mine\n\nHand written.\n")).toBe(true);
    expect(md).toContain(HOOK_INSTRUCTIONS_START);
    writeFileSync(claudeMd(), `${HOOK_INSTRUCTIONS_START}\nbroken\n`);
    const r = run();
    runHooksInstall(r.io, { tool: "claude" });
    expect(r.exit()).toBe(1);
    expect(r.err.join("\n")).toContain("markers are malformed");
  });
});

describe("mex hooks remove", () => {
  it("deletes exactly what install added and restores user files", () => {
    mkdirSync(join(root, ".claude"));
    const original = `${JSON.stringify(USER_SETTINGS, null, 2)}\n`;
    writeFileSync(settingsPath(), original);
    writeFileSync(claudeMd(), "# Mine\n\nHand written.\n");
    runHooksInstall(run().io, { tool: "claude" });
    const r = run();
    runHooksRemove(r.io, { tool: "claude" });
    expect(r.exit()).toBe(0);
    expect(readFileSync(settingsPath(), "utf8")).toBe(original);
    expect(readFileSync(claudeMd(), "utf8")).toBe("# Mine\n\nHand written.\n");
  });

  it("deletes the files MEX created and the hooks key it emptied", () => {
    runHooksInstall(run().io, { tool: "claude" });
    runHooksRemove(run().io, { tool: "claude" });
    expect(existsSync(claudeMd())).toBe(false);
    expect(readJson()).toEqual({});
  });

  it("leaves a user hook that sits in a group with a MEX hook", () => {
    runHooksInstall(run().io, { tool: "claude" });
    const settings = readJson();
    settings.hooks.PostToolUse[0].hooks.unshift({ type: "command", command: "echo mine" });
    writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
    runHooksRemove(run().io, { tool: "claude" });
    expect(readJson()).toEqual({ hooks: { PostToolUse: [{ matcher: "Read", hooks: [{ type: "command", command: "echo mine" }] }] } });
  });

  it("is a no-op when nothing is installed, and --dry-run writes nothing", () => {
    const none = run();
    runHooksRemove(none.io, { tool: "claude" });
    expect(none.exit()).toBe(0);
    expect(none.out.join("\n")).toContain("nothing to remove");
    runHooksInstall(run().io, { tool: "claude" });
    const before = readFileSync(settingsPath(), "utf8");
    const dry = run();
    runHooksRemove(dry.io, { tool: "claude", dryRun: true });
    expect(readFileSync(settingsPath(), "utf8")).toBe(before);
    expect(dry.out.join("\n")).toContain("-            \"command\": \"node");
    expect(existsSync(claudeMd())).toBe(true);
  });
});

describe("mex hooks status", () => {
  const status = (options: { shim?: boolean } = {}) => {
    const r = run(options);
    runHooksStatus(r.io, { tool: "claude", json: true });
    return JSON.parse(r.out[0]!).data;
  };

  it("walks through none, installed, outdated, partial and broken", () => {
    expect(status().state).toBe("none");
    runHooksInstall(run().io, { tool: "claude" });
    const installed = status();
    expect(installed.state).toBe("installed");
    expect(installed.installed.kind).toBe("node");
    expect(installed.instructionsPresent).toBe(true);
    // A mex-hook bin appeared on PATH after the install: the entries are current but not what install would write.
    expect(status({ shim: true }).state).toBe("outdated");

    const settings = readJson();
    settings.hooks.PostToolUse.pop();
    writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
    expect(status().state).toBe("partial");

    runHooksInstall(run().io, { tool: "claude" });
    rmSync(entry);
    const broken = status();
    expect(broken.state).toBe("broken");
    expect(broken.installed.exists).toBe(false);
  });

  it("counts the user's own hooks without touching them", () => {
    mkdirSync(join(root, ".claude"));
    writeFileSync(settingsPath(), JSON.stringify(USER_SETTINGS));
    runHooksInstall(run().io, { tool: "claude" });
    expect(status().settings.userHooks).toBe(4);
  });

  it("prints a readable report", () => {
    runHooksInstall(run().io, { tool: "claude" });
    const r = run();
    runHooksStatus(r.io, { tool: "claude" });
    const text = r.out.join("\n");
    expect(text).toContain("MEX hooks for Claude Code: installed");
    expect(text).toContain("node with the hook bundle");
    expect(text).toContain("CLAUDE.md block: present");
  });
});

describe("hook command resolution", () => {
  it("finds a shim on PATH, falls back to the bundle with forward slashes, and reports nothing found", () => {
    const shimDir = mkdtempSync(join(tmpdir(), "mex-hooks-shim-"));
    try {
      expect(findBinOnPath({ env: { PATH: shimDir } })).toBeNull();
      writeFileSync(join(shimDir, process.platform === "win32" ? "mex-hook.cmd" : "mex-hook"), "x");
      expect(findBinOnPath({ env: { PATH: shimDir } })).toContain("mex-hook");
      expect(resolveHookCommand({ env: { PATH: shimDir }, entryCandidates: [entry] })).toMatchObject({ kind: "bin", command: `mex-hook ${MEX_HOOK_MARKER}` });
    } finally {
      rmSync(shimDir, { recursive: true, force: true });
    }
    const node = resolveHookCommand({ env: { PATH: "" }, entryCandidates: [entry] })!;
    expect(node.kind).toBe("node");
    expect(node.command.startsWith('node "')).toBe(true);
    expect(node.command).not.toContain("\\");
    expect(resolveHookCommand({ env: { PATH: "" }, entryCandidates: [] })).toBeNull();
  });
});
