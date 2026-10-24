import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stdin, stdout } from "node:process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runTerminalSetup } from "../terminal.js";
import { SetupError } from "../errors.js";

const state = vi.hoisted(() => ({ committed: false, inspectedAfterHub: false, pickerShown: false }));
vi.mock("../terminal-ui.js", () => ({ createTerminalSetupUI: (_view: unknown, action: (value: unknown) => void) => {
  state.pickerShown = true;
  setTimeout(() => action({ type: "start" }), 0);
  return { update() {}, suspend: async () => {}, resume() {}, close: async () => {} };
} }));
vi.mock("../headless.js", () => ({ runHeadlessSetup: async () => ({ ready: true, mode: "code-repo", anchorNotes: [],
  message: "Review and commit the canonical MEX setup." }) }));
vi.mock("../../hub/command.js", () => ({ runSetupHubCommand: async (options: { onListening: (value: unknown) => void }) => {
  options.onListening({ bootstrapUrl: "http://127.0.0.1:1234/#token=example" });
  state.inspectedAfterHub = true;
} }));
vi.mock("../../hub/setup/readiness.js", () => ({ projectSetupStatus: async () => {
  expect(state.inspectedAfterHub).toBe(true);
  return { mode: "code-repo", ready: state.committed };
} }));

const roots: string[] = [];
const inputTTY = Object.getOwnPropertyDescriptor(stdin, "isTTY");
const outputTTY = Object.getOwnPropertyDescriptor(stdout, "isTTY");
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  if (inputTTY) Object.defineProperty(stdin, "isTTY", inputTTY); else delete (stdin as { isTTY?: boolean }).isTTY;
  if (outputTTY) Object.defineProperty(stdout, "isTTY", outputTTY); else delete (stdout as { isTTY?: boolean }).isTTY;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("terminal completion after the finishing browser closes", () => {
  it.each([true, false])("rechecks the browser's commit result (committed: %s)", async committed => {
    state.committed = committed; state.inspectedAfterHub = false; state.pickerShown = false;
    const root = mkdtempSync(join(tmpdir(), "mex-terminal-completion-")); roots.push(root);
    mkdirSync(join(root, ".git"));
    vi.spyOn(process, "cwd").mockReturnValue(root);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.stubEnv("CI", ""); vi.stubEnv("TERM", "xterm");
    Object.defineProperty(stdin, "isTTY", { configurable: true, value: true });
    Object.defineProperty(stdout, "isTTY", { configurable: true, value: true });
    const result = await runTerminalSetup({ mode: "code-repo", tools: [], openBrowser: false });
    expect(result).toMatchObject({ outcome: "complete", exitCode: 0 });
    if (committed) {
      expect(result.message).toContain("Setup complete");
      expect(result.message).toContain("mex hub");
      expect(result.message).not.toContain("Review and commit");
    } else {
      expect(result.message).toContain("Review and commit");
      expect(result.message).toContain("mex setup --browser");
    }
  });
});

describe("the tool picker and the Git refusal", () => {
  it("refuses a code repository without .git before the picker is shown", async () => {
    state.pickerShown = false;
    const root = mkdtempSync(join(tmpdir(), "mex-terminal-git-")); roots.push(root);
    vi.spyOn(process, "cwd").mockReturnValue(root);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.stubEnv("CI", ""); vi.stubEnv("TERM", "xterm");
    Object.defineProperty(stdin, "isTTY", { configurable: true, value: true });
    Object.defineProperty(stdout, "isTTY", { configurable: true, value: true });
    // No .git here: the engine refuses code-repository mode, and it should
    // do so before an interactive choice is spent on the run.
    const attempt = runTerminalSetup({ mode: "code-repo", tools: [], openBrowser: false });
    await expect(attempt).rejects.toBeInstanceOf(SetupError);
    await expect(attempt).rejects.toMatchObject({ userMessage: expect.stringContaining("No Git repository found") });
    expect(state.pickerShown).toBe(false);
  });
});
