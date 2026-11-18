import { afterEach, expect, it, vi } from "vitest";
import { fstatSync, lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync, type Stats, type BigIntStats } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LegacyFiles } from "../legacy-files.js";
import { readLegacyScaffold } from "../legacy-reader.js";

const state = vi.hoisted(() => ({
  afterRead: undefined as ((fd: number) => void) | undefined,
  replacedParent: "",
  freezeDirectories: false,
  directories: new Map<string, unknown>(),
  freezeFiles: false,
  files: new Map<string, unknown>(),
}));
vi.mock("node:fs", async original => {
  const fs = await original<typeof import("node:fs")>();
  const stableFile = (stat: Stats | BigIntStats) => {
    if (!state.freezeFiles || !stat.isFile()) return stat;
    const key = `${stat.dev}:${stat.ino}`;
    if (!state.files.has(key)) state.files.set(key, stat);
    return state.files.get(key);
  };
  return {
    ...fs,
    fstatSync: ((...args: unknown[]) => stableFile(Reflect.apply(fs.fstatSync, fs, args))) as typeof fs.fstatSync,
    lstatSync: ((...args: unknown[]) => {
      const stat = Reflect.apply(fs.lstatSync, fs, args) as Stats | BigIntStats | undefined;
      if (stat === undefined) return stat;
      const path = String(args[0]);
      if (state.freezeDirectories && stat.isDirectory()) {
        if (!state.directories.has(path)) state.directories.set(path, stat);
        return state.directories.get(path);
      }
      if (state.replacedParent === path) return new Proxy(stat, { get(target, key) {
        if (key === "ino") return typeof target.ino === "bigint" ? target.ino + 1n : target.ino + 1;
        return Reflect.get(target, key);
      } });
      return stableFile(stat);
    }) as typeof fs.lstatSync,
    readSync: (...args: Parameters<typeof fs.readSync>) => {
      const size = (fs.readSync as (...args: Parameters<typeof fs.readSync>) => number)(...args);
      const action = state.afterRead;
      state.afterRead = undefined;
      action?.(args[0]);
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
  state.replacedParent = "";
  state.freezeDirectories = false;
  state.directories.clear();
  state.freezeFiles = false;
  state.files.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("refuses a same-inode edit while the descriptor is being consumed", () => {
  const root = fixture();
  state.freezeFiles = true;
  const files = new LegacyFiles(root);
  state.afterRead = () => writeFileSync(join(root, ".mex/context/a.md"), "# Rule\nModified!\n");
  expect(() => files.read(".mex/context/a.md")).toThrow("LEGACY_CHANGED");
});

it("refuses a parent replacement during a read, even with identical file bytes", () => {
  const root = fixture();
  const files = new LegacyFiles(root);
  state.afterRead = () => {
    // Windows refuses renaming this directory while its child descriptor is
    // open. Inject the changed parent identity at the same read boundary;
    // actual directory replacement is also tested after descriptor close.
    state.replacedParent = join(files.root, ".mex/context");
  };
  expect(() => files.read(".mex/context/a.md")).toThrow("LEGACY_CHANGED");
});

it("detects new directory entries even when directory timestamps do not advance", () => {
  const root = fixture();
  state.freezeDirectories = true;
  const files = new LegacyFiles(root);
  files.list(".mex");
  mkdirSync(join(root, ".mex/new"));
  expect(() => files.verify()).toThrow("LEGACY_CHANGED");
});

it("detects an actual parent replacement after its child descriptor closes", () => {
  const root = fixture();
  const files = new LegacyFiles(root);
  files.read(".mex/context/a.md");
  renameSync(join(root, ".mex/context"), join(root, ".mex/old-context"));
  mkdirSync(join(root, ".mex/context"));
  writeFileSync(join(root, ".mex/context/a.md"), "# Rule\nOriginal.\n");
  expect(() => files.verify()).toThrow("LEGACY_CHANGED");
});

it("makes the whole snapshot incomplete if an earlier document changes during a later read", () => {
  const root = fixture();
  state.freezeFiles = true;
  writeFileSync(join(root, "AGENTS.md"), "Human instructions.\n");
  const later = lstatSync(join(root, "AGENTS.md"), { bigint: true });
  const changeEarlier = (fd: number): void => {
    if (fstatSync(fd, { bigint: true }).ino === later.ino) {
      writeFileSync(join(root, ".mex/context/a.md"), "# Rule\nModified!\n");
    } else state.afterRead = changeEarlier;
  };
  state.afterRead = changeEarlier;
  const result = readLegacyScaffold(root);
  expect(result.complete).toBe(false);
  expect(result.diagnostics.some(item => item.code === "LEGACY_CHANGED")).toBe(true);
});
