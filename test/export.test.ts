import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runExport } from "../src/export.js";
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
