import { afterEach, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LegacyFiles } from "../legacy-files.js";
import { readLegacyScaffold } from "../legacy-reader.js";

const state = vi.hoisted(() => ({ afterRead: undefined as (() => void) | undefined }));
vi.mock("node:fs", async original => {
  const fs = await original<typeof import("node:fs")>();
  return {
    ...fs,
    readSync: (...args: Parameters<typeof fs.readSync>) => {
      const size = (fs.readSync as (...args: Parameters<typeof fs.readSync>) => number)(...args);
      const action = state.afterRead;
      state.afterRead = undefined;
      action?.();
      return size;
    },
  };
});

const roots: string[] = [];
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "mex-upgrade-race-"));
  roots.push(root);
  mkdirSync(join(root, ".mex/context"), { recursive: true });
  writeFileSync(join(root, ".mex/context/a.md"), "# Rule\nOriginal.\n");
  return root;
}
afterEach(() => {
  state.afterRead = undefined;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("refuses a same-inode edit while the descriptor is being consumed", () => {
  const root = fixture();
  const files = new LegacyFiles(root);
  state.afterRead = () => writeFileSync(join(root, ".mex/context/a.md"), "# Rule\nModified!\n");
  expect(() => files.read(".mex/context/a.md")).toThrow("LEGACY_CHANGED");
});

it("refuses a parent replacement during a read, even with identical file bytes", () => {
  const root = fixture();
  const files = new LegacyFiles(root);
  state.afterRead = () => {
    renameSync(join(root, ".mex/context"), join(root, ".mex/old-context"));
    mkdirSync(join(root, ".mex/context"));
    writeFileSync(join(root, ".mex/context/a.md"), "# Rule\nOriginal.\n");
  };
  expect(() => files.read(".mex/context/a.md")).toThrow("LEGACY_CHANGED");
});

it("makes the whole snapshot incomplete if an earlier document changes during a later read", () => {
  const root = fixture();
  writeFileSync(join(root, "AGENTS.md"), "Human instructions.\n");
  // Re-arm only after the first file is fully read (its second EOF read).
  state.afterRead = () => {
    state.afterRead = () => {
      state.afterRead = () => writeFileSync(join(root, ".mex/context/a.md"), "# Rule\nChanged after parse.\n");
    };
  };
  const result = readLegacyScaffold(root);
  expect(result.complete).toBe(false);
  expect(result.diagnostics.some(item => item.code === "LEGACY_CHANGED")).toBe(true);
});
