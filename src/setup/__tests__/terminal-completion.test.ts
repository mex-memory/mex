import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stdin, stdout } from "node:process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runTerminalSetup } from "../terminal.js";

const mocks = vi.hoisted(() => ({
  runHeadlessSetup: vi.fn(), projectSetupStatus: vi.fn(), runSetupHubCommand: vi.fn(),
}));
vi.mock("../terminal-ui.js", () => ({ createTerminalSetupUI: (_view: unknown, action: (value: unknown) => void) => {
  setTimeout(() => action({ type: "start" }), 0);
  return { update() {}, suspend: async () => {}, resume() {}, close: async () => {} };
} }));
vi.mock("../headless.js", () => ({ runHeadlessSetup: mocks.runHeadlessSetup }));
vi.mock("../../hub/command.js", () => ({ runSetupHubCommand: mocks.runSetupHubCommand }));
vi.mock("../../hub/setup/readiness.js", () => ({ projectSetupStatus: mocks.projectSetupStatus }));

const roots: string[] = [];
const inputTTY = Object.getOwnPropertyDescriptor(stdin, "isTTY");
const outputTTY = Object.getOwnPropertyDescriptor(stdout, "isTTY");
afterEach(() => {
  vi.clearAllMocks(); vi.restoreAllMocks(); vi.unstubAllEnvs();
  if (inputTTY) Object.defineProperty(stdin, "isTTY", inputTTY); else delete (stdin as { isTTY?: boolean }).isTTY;
  if (outputTTY) Object.defineProperty(stdout, "isTTY", outputTTY); else delete (stdout as { isTTY?: boolean }).isTTY;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("terminal completion", () => {
  it.each([
    ["code-repo", true, "Setup complete. Coverage notice. Grounding notice."],
    ["code-repo", false, "Review and commit the canonical MEX setup."],
    ["agent-memory", false, "Setup complete. Grounding notice."],
  ] as const)("finishes in the terminal for %s (committed: %s)", async (mode, ready, completion) => {
    const root = mkdtempSync(join(tmpdir(), "mex-terminal-completion-")); roots.push(root);
    mkdirSync(join(root, ".git"));
    vi.spyOn(process, "cwd").mockReturnValue(root);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.stubEnv("CI", ""); vi.stubEnv("TERM", "xterm");
    Object.defineProperty(stdin, "isTTY", { configurable: true, value: true });
    Object.defineProperty(stdout, "isTTY", { configurable: true, value: true });
    mocks.runHeadlessSetup.mockResolvedValue({ ready: true, mode, anchorNotes: [],
      message: "Review and commit the canonical MEX setup.",
      coverageNotice: mode === "code-repo" ? "Coverage notice." : undefined,
      groundingNotice: "Grounding notice.",
    });
    mocks.projectSetupStatus.mockResolvedValue({ mode, ready });
    const result = await runTerminalSetup({ mode, tools: [] });
    const message = completion + " Run `mex hub` to open the Hub.";
    expect(result).toEqual({ outcome: "complete", exitCode: 0, message });
    expect(log).toHaveBeenCalledWith(message);
    expect(mocks.projectSetupStatus).toHaveBeenCalledExactlyOnceWith(root);
    expect(mocks.projectSetupStatus).toHaveBeenCalledAfter(mocks.runHeadlessSetup);
    expect(mocks.runSetupHubCommand).not.toHaveBeenCalled();
  });
});
