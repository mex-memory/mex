import { afterEach, expect, it, vi } from "vitest";
vi.mock("../index.js", () => ({
  installAgents: vi.fn(async () => ({ agents: ["codex"], changes: [], notices: ["In Codex, review and trust MEX's hooks once: /hooks in the CLI, or Review hooks beside the message box in the app. Until then Codex skips them."], legacyTracked: [] })),
  installationChanges: () => [], additionalUninstallPaths: () => [],
  uninstallAgents: vi.fn(async () => ({ conflicts: [], purged: false })),
}));
vi.mock("../../record/location.js", () => ({ recordLocation: () => ({ home: "<MEX home>" }) }));
import { runInstall, runUninstall } from "../cli.js";
const tty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
afterEach(() => { vi.restoreAllMocks(); if (tty) Object.defineProperty(process.stdout, "isTTY", tty); else Reflect.deleteProperty(process.stdout, "isTTY"); });
it("ends a terminal install with next and undo, keeping trust instructions", async () => {
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
  const out = vi.spyOn(console, "log").mockImplementation(() => {});
  await runInstall();
  expect(out.mock.calls.map(call => call[0])).toEqual([
    "MEX installation:", "  Agent hooks are up to date.", "In Codex, review and trust MEX's hooks once: /hooks in the CLI, or Review hooks beside the message box in the app. Until then Codex skips them.",
    "Next: run mex in a repo to turn MEX on there. Undo any time: mex uninstall",
  ]);
});
it("keeps JSON and dry-run installs free of the success instruction", async () => {
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
  const out = vi.spyOn(console, "log").mockImplementation(() => {});
  await runInstall({ json: true });
  expect(() => JSON.parse(out.mock.calls[0][0])).not.toThrow();
  out.mockClear();
  await runInstall({ dryRun: true });
  expect(out.mock.calls.flat().join("\n")).not.toContain("Next:");
});
it("ends uninstall with the actual retained notes path", async () => {
  const out = vi.spyOn(console, "log").mockImplementation(() => {});
  await runUninstall();
  expect(out.mock.calls.at(-1)).toEqual(["MEX is off on this machine. Your notes are kept in <MEX home>; mex uninstall --purge removes them."]);
});
