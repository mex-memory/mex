import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stdin, stdout } from "node:process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runTerminalSetup } from "../terminal.js";
import { SetupError } from "../errors.js";
import type { SetupRunOptions } from "../index.js";
import { createTerminalSetupUI } from "../terminal-ui.js";

vi.mock("../terminal-ui.js", () => ({
  createTerminalSetupUI: vi.fn((_view: unknown, action: (value: unknown) => void) => {
    queueMicrotask(() => action({ type: "cancel" }));
    return { update() {}, suspend: async () => {}, resume() {}, close: async () => {} };
  }),
}));

const roots: string[] = [];
const inputTTY = Object.getOwnPropertyDescriptor(stdin, "isTTY");
const outputTTY = Object.getOwnPropertyDescriptor(stdout, "isTTY");

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("CI", "");
  vi.stubEnv("TERM", "xterm");
  Object.defineProperty(stdin, "isTTY", { configurable: true, value: true });
  Object.defineProperty(stdout, "isTTY", { configurable: true, value: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (inputTTY) Object.defineProperty(stdin, "isTTY", inputTTY); else delete (stdin as { isTTY?: boolean }).isTTY;
  if (outputTTY) Object.defineProperty(stdout, "isTTY", outputTTY); else delete (stdout as { isTTY?: boolean }).isTTY;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project() {
  const root = mkdtempSync(join(tmpdir(), "mex-terminal-git-"));
  roots.push(root);
  vi.spyOn(process, "cwd").mockReturnValue(root);
  vi.spyOn(console, "log").mockImplementation(() => {});
  return root;
}

describe("terminal setup Git prerequisite", () => {
  it.each<[string, SetupRunOptions & { ci?: boolean; noTTY?: boolean }]>([
    ["interactive", {}],
    ["interactive with an explicit tool", { tools: ["claude"] }],
    ["non-interactive", { yes: true }],
    ["CI", { ci: true }],
    ["no-TTY", { noTTY: true }],
    ["dry-run", { dryRun: true }],
  ])("rejects a code repository without Git before creating the %s UI or files", async (_name, { ci, noTTY, ...options }) => {
    const root = project();
    if (ci) vi.stubEnv("CI", "true");
    if (noTTY) Object.defineProperty(stdin, "isTTY", { configurable: true, value: false });
    const setup = runTerminalSetup({ mode: "code-repo", tools: [], ...options });
    await expect(setup).rejects.toThrow(SetupError);
    await expect(setup).rejects.toThrow(
      "No Git repository found. Run `git init` first, then rerun setup.",
    );
    expect(createTerminalSetupUI).not.toHaveBeenCalled();
    expect(readdirSync(root)).toEqual([]);
  });

  it.each(["directory", "file"])("allows the picker when .git is a %s", async kind => {
    const root = project();
    if (kind === "directory") mkdirSync(join(root, ".git"));
    else writeFileSync(join(root, ".git"), "gitdir: /example/worktrees/project\n");
    await expect(runTerminalSetup({ mode: "code-repo", tools: [] })).resolves.toMatchObject({ outcome: "cancelled" });
    expect(createTerminalSetupUI).toHaveBeenCalledOnce();
    expect(readdirSync(root)).toEqual([".git"]);
  });

  it("allows the picker from a subfolder of a Git repository", async () => {
    const root = project();
    mkdirSync(join(root, ".git"));
    mkdirSync(join(root, "src", "deep"), { recursive: true });
    vi.mocked(process.cwd).mockReturnValue(join(root, "src", "deep"));
    await expect(runTerminalSetup({ mode: "code-repo", tools: [] })).resolves.toMatchObject({ outcome: "cancelled" });
    expect(createTerminalSetupUI).toHaveBeenCalledOnce();
    expect(readdirSync(root).sort()).toEqual([".git", "src"]);
  });

  it("allows the agent-memory picker without Git", async () => {
    const root = project();
    await expect(runTerminalSetup({ mode: "agent-memory", tools: [] })).resolves.toMatchObject({ outcome: "cancelled" });
    expect(createTerminalSetupUI).toHaveBeenCalledOnce();
    expect(readdirSync(root)).toEqual([]);
  });

  it("allows the picker without Git when the workspace is configured for agent memory", async () => {
    const root = project();
    mkdirSync(join(root, ".mex"));
    writeFileSync(join(root, ".mex", "config.json"), JSON.stringify({ setupMode: "agent-memory" }));
    await expect(runTerminalSetup({ tools: [] })).resolves.toMatchObject({ outcome: "cancelled" });
    expect(createTerminalSetupUI).toHaveBeenCalledOnce();
    expect(readdirSync(root)).toEqual([".mex"]);
  });
});
