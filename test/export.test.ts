import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  MAX_EXPORT_FILES,
  MAX_EXPORT_FILE_BYTES,
  MAX_EXPORT_TOTAL_BYTES,
  runExport,
} from "../src/export.js";
import type { MexConfig } from "../src/types.js";

let tmpDir: string;
let config: MexConfig;
let stdoutSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "mex-export-"));
  mkdirSync(join(tmpDir, ".mex/context"), { recursive: true });
  mkdirSync(join(tmpDir, ".mex/patterns"), { recursive: true });
  writeFileSync(join(tmpDir, ".mex/ROUTER.md"), "# Router\n\nEntry point.\n");
  writeFileSync(join(tmpDir, ".mex/context/stack.md"), "# Stack\n\nNode 22.\n");
  writeFileSync(join(tmpDir, ".mex/patterns/retry.md"), "# Retry\n");
  config = { projectRoot: tmpDir, scaffoldRoot: join(tmpDir, ".mex"), aiTools: [] };
  stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("mex export (#56)", () => {
  it("bundles every scaffold file under a header per source file", async () => {
    await runExport(config, {});
    const document = stdoutSpy.mock.calls.map((call) => String(call[0])).join("");

    expect(document).toContain("# mex scaffold export");
    expect(document).toContain("## ROUTER.md");
    expect(document).toContain("## context/stack.md");
    expect(document).toContain("## patterns/retry.md");
    // Content survives intact under its own header.
    expect(document).toContain("Entry point.");
    expect(document).toContain("Node 22.");
    // Deterministic order: sorted by path.
    expect(document.indexOf("## ROUTER.md")).toBeLessThan(document.indexOf("## context/stack.md"));
    expect(document.indexOf("## context/stack.md")).toBeLessThan(document.indexOf("## patterns/retry.md"));
  });

  it("writes the same bundle to --out and reports the count", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runExport(config, { out: "exports/scaffold.md" });
    expect(stdoutSpy.mock.calls.map((call) => String(call[0])).join("")).toBe("");
    const written = readFileSync(join(tmpDir, "exports/scaffold.md"), "utf-8");
    expect(written).toContain("## ROUTER.md");
    expect(logSpy.mock.calls.map((call) => String(call[0])).join(""))
      .toContain("Wrote 3 scaffold file(s) to exports/scaffold.md");
  });

  it("fails with guidance when the scaffold is missing", async () => {
    rmSync(join(tmpDir, ".mex"), { recursive: true, force: true });
    await expect(runExport(config, {})).rejects.toThrow("No scaffold files found. Run: mex setup");
  });
});

describe("mex export destination safety (#183 P1)", () => {
  it("refuses an --out path that is an existing scaffold file, keeping its bytes", async () => {
    const routerPath = join(tmpDir, ".mex/ROUTER.md");
    const before = readFileSync(routerPath, "utf-8");
    await expect(runExport(config, { out: ".mex/ROUTER.md" })).rejects.toThrow(
      /Refusing to export: ".mex\/ROUTER\.md" would overwrite scaffold file ROUTER\.md/
    );
    expect(readFileSync(routerPath, "utf-8")).toBe(before);
  });

  it("refuses an --out path that is the project configuration, keeping its bytes", async () => {
    const configPath = join(tmpDir, ".mex/config.json");
    writeFileSync(configPath, JSON.stringify({ scaffold_id: "keep-me" }));
    await expect(runExport(config, { out: ".mex/config.json" })).rejects.toThrow(
      /Refusing to export: ".mex\/config\.json" would overwrite project configuration/
    );
    expect(readFileSync(configPath, "utf-8")).toBe(JSON.stringify({ scaffold_id: "keep-me" }));
  });

  it("refuses a symlink alias of a scaffold file, keeping the target bytes", async () => {
    const routerPath = join(tmpDir, ".mex/ROUTER.md");
    const before = readFileSync(routerPath, "utf-8");
    mkdirSync(join(tmpDir, "exports"));
    symlinkSync(routerPath, join(tmpDir, "exports/scaffold.md"));
    await expect(runExport(config, { out: "exports/scaffold.md" })).rejects.toThrow(
      /Refusing to export/
    );
    expect(readFileSync(routerPath, "utf-8")).toBe(before);
  });

  it("refuses a scaffold file reached through a symlinked parent directory", async () => {
    // Directory junctions need no special privilege (unlike file symlinks),
    // so this exercises the same alias detection on every platform.
    const routerPath = join(tmpDir, ".mex/ROUTER.md");
    const before = readFileSync(routerPath, "utf-8");
    symlinkSync(join(tmpDir, ".mex"), join(tmpDir, "xlink"), "junction");
    await expect(runExport(config, { out: "xlink/ROUTER.md" })).rejects.toThrow(
      /Refusing to export: "xlink\/ROUTER\.md" would overwrite scaffold file ROUTER\.md/
    );
    expect(readFileSync(routerPath, "utf-8")).toBe(before);
  });

  it("excludes a previous bundle inside the scaffold from its own inputs", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const bundleRel = ".mex/context/bundle.md";
    await runExport(config, { out: bundleRel });
    const first = readFileSync(join(tmpDir, bundleRel), "utf-8");
    expect(first).not.toContain("## context/bundle.md");
    await runExport(config, { out: bundleRel });
    const second = readFileSync(join(tmpDir, bundleRel), "utf-8");
    expect(second).toBe(first);
    expect(logSpy).toHaveBeenCalled();
  });

  it("refuses any other existing project state, keeping its bytes", async () => {
    mkdirSync(join(tmpDir, ".mex/events"), { recursive: true });
    const decisions = join(tmpDir, ".mex/events/decisions.jsonl");
    writeFileSync(decisions, JSON.stringify({ event: "keep-me" }));
    const readme = join(tmpDir, "README.md");
    writeFileSync(readme, "# Keep me\n");
    await expect(runExport(config, { out: ".mex/events/decisions.jsonl" })).rejects.toThrow(
      /already exists and is not a previous export bundle/
    );
    await expect(runExport(config, { out: "README.md" })).rejects.toThrow(
      /already exists and is not a previous export bundle/
    );
    expect(readFileSync(decisions, "utf-8")).toBe(JSON.stringify({ event: "keep-me" }));
    expect(readFileSync(readme, "utf-8")).toBe("# Keep me\n");
  });

  it("refuses a hardlink alias of a scaffold file, keeping the target bytes", async () => {
    const routerPath = join(tmpDir, ".mex/ROUTER.md");
    const before = readFileSync(routerPath, "utf-8");
    mkdirSync(join(tmpDir, "exports"));
    // Same inode, different path: realpath comparison cannot see it, but the
    // existence refusal still protects the target.
    linkSync(routerPath, join(tmpDir, "exports/scaffold.md"));
    await expect(runExport(config, { out: "exports/scaffold.md" })).rejects.toThrow(
      /Refusing to export/
    );
    expect(readFileSync(routerPath, "utf-8")).toBe(before);
  });

  it("refuses an existing directory as --out", async () => {
    mkdirSync(join(tmpDir, "exports"));
    await expect(runExport(config, { out: "exports" })).rejects.toThrow(
      /Refusing to export/
    );
  });
});

describe("mex export bounds (#183 P2)", () => {
  function resetScaffold(files: Array<{ rel: string; bytes: number }>): void {
    rmSync(join(tmpDir, ".mex"), { recursive: true, force: true });
    for (const file of files) {
      const target = join(tmpDir, ".mex", file.rel);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, Buffer.alloc(file.bytes, "a"));
    }
  }

  function filler(count: number, bytes: number, prefix = "context/f"): Array<{ rel: string; bytes: number }> {
    return Array.from({ length: count }, (_, index) => ({ rel: `${prefix}${index}.md`, bytes }));
  }

  it("refuses when the file count exceeds the limit and writes nothing", async () => {
    resetScaffold(filler(MAX_EXPORT_FILES + 1, 0));
    await expect(runExport(config, { out: "exports/scaffold.md" })).rejects.toThrow(
      new RegExp(`supports at most ${MAX_EXPORT_FILES}`)
    );
    expect(existsSync(join(tmpDir, "exports/scaffold.md"))).toBe(false);
  });

  it("accepts exactly the file-count limit", async () => {
    resetScaffold(filler(MAX_EXPORT_FILES, 0));
    await expect(runExport(config, {})).resolves.toBeUndefined();
  });

  it("refuses a file larger than the per-file limit and writes nothing", async () => {
    resetScaffold([{ rel: "context/big.md", bytes: MAX_EXPORT_FILE_BYTES + 1 }]);
    await expect(runExport(config, { out: "exports/scaffold.md" })).rejects.toThrow(
      new RegExp(`supports at most ${MAX_EXPORT_FILE_BYTES} bytes per file`)
    );
    expect(existsSync(join(tmpDir, "exports/scaffold.md"))).toBe(false);
  });

  it("accepts a file of exactly the per-file limit", async () => {
    resetScaffold([{ rel: "context/big.md", bytes: MAX_EXPORT_FILE_BYTES }]);
    await expect(runExport(config, {})).resolves.toBeUndefined();
  });

  it("refuses when the aggregate exceeds the total limit and writes nothing", async () => {
    // Nine 1 MiB files stay within the per-file cap but total 9 MiB.
    resetScaffold(filler(9, MAX_EXPORT_FILE_BYTES));
    await expect(runExport(config, { out: "exports/scaffold.md" })).rejects.toThrow(
      new RegExp(`supports at most ${MAX_EXPORT_TOTAL_BYTES} bytes in total`)
    );
    expect(existsSync(join(tmpDir, "exports/scaffold.md"))).toBe(false);
  });

  it("accepts an aggregate of exactly the total limit", async () => {
    resetScaffold(filler(8, MAX_EXPORT_FILE_BYTES));
    await expect(runExport(config, {})).resolves.toBeUndefined();
  });
});

describe("mex export write completion (#183 P2)", () => {
  // Force short writes through a per-test node:fs mock: the export module is
  // re-imported fresh so only these tests observe the mock.
  async function importExportWithWrites(
    writeBehavior: (write: typeof import("node:fs").writeSync, fd: number, buf: Buffer, offset: number, length: number, position: null) => number
  ): Promise<typeof import("../src/export.js")> {
    vi.resetModules();
    vi.doMock("node:fs", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs")>();
      return {
        ...actual,
        writeSync: ((fd: number, buf: Buffer, offset: number, length: number, position: null) =>
          writeBehavior(actual.writeSync, fd, buf, offset, length, position)) as unknown as typeof actual.writeSync,
      };
    });
    try {
      return await import("../src/export.js");
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  }

  it("fails a new-file export when the descriptor stops accepting bytes", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const mocked = await importExportWithWrites(() => 0);
    await expect(mocked.runExport(config, { out: "exports/scaffold.md" })).rejects.toThrow(
      /could not be fully written/
    );
    // Partial bytes may exist, but success is never reported.
    expect(logSpy.mock.calls.map((call) => String(call[0])).join("")).not.toContain("Wrote");
  });

  it("fails a previous-bundle overwrite when the descriptor stops accepting bytes", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runExport(config, { out: "exports/scaffold.md" });
    logSpy.mockClear();
    const mocked = await importExportWithWrites(() => 0);
    await expect(mocked.runExport(config, { out: "exports/scaffold.md" })).rejects.toThrow(
      /could not be fully written/
    );
    expect(logSpy.mock.calls.map((call) => String(call[0])).join("")).not.toContain("Wrote 3");
  });

  it("completes the bundle when an early write is short", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    let shortLeft = 1;
    const mocked = await importExportWithWrites((write, fd, buf, offset, length, position) => {
      if (shortLeft > 0) {
        shortLeft -= 1;
        return write(fd, buf, offset, Math.min(10, length), position);
      }
      return write(fd, buf, offset, length, position);
    });
    await mocked.runExport(config, { out: "exports/scaffold.md" });
    const written = readFileSync(join(tmpDir, "exports/scaffold.md"), "utf-8");
    expect(written).toContain("## ROUTER.md");
    expect(written).toContain("Node 22.");
    expect(logSpy.mock.calls.map((call) => String(call[0])).join(""))
      .toContain("Wrote 3 scaffold file(s) to exports/scaffold.md");
  });

  it.skipIf(process.platform === "win32")("refuses a FIFO as --out without hanging", () => {
    mkdirSync(join(tmpDir, "exports"));
    execFileSync("mkfifo", [join(tmpDir, "exports/scaffold.md")], { timeout: 5000 });
    // A blocking open stalls the event loop, so an in-process test timeout
    // cannot catch this regression. Bound the real CLI in a separate process.
    const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
    const result = spawnSync(process.execPath, [cliPath, "export", "--out", "exports/scaffold.md"], {
      cwd: tmpDir,
      encoding: "utf-8",
      env: { ...process.env, MEX_TELEMETRY: "0" },
      timeout: 5000,
      killSignal: "SIGKILL",
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(
      /already exists and is not a previous export bundle/
    );
    expect(result.stdout).not.toContain("Wrote");
  }, 10000);
});
