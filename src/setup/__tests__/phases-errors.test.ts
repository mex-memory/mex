import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { classifySetupFileSystemError, SetupError } from "../errors.js";
import { buildSetupGraph, createSetupScaffold, verifyExistingSetupConfig } from "../phases.js";
import { GraphMaintenanceError } from "../../graph/maintenance.js";
import * as maintenance from "../../graph/maintenance.js";

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return { ...original, readFileSync: vi.fn(original.readFileSync) };
});

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(readFileSync).mockReset();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "mex-setup-errors-"));
  roots.push(root);
  return root;
}

describe("expected setup preparation errors", () => {
  it.each(["{broken", "[]", "null"])("explains invalid config %s without replacing it", async (contents) => {
    const root = fixture();
    writeFileSync(join(root, "config.json"), contents);
    expect(() => verifyExistingSetupConfig(root)).toThrow(SetupError);
    expect(() => verifyExistingSetupConfig(root)).toThrow("not a valid JSON object");
    const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
    expect(fs.readFileSync(join(root, "config.json"), "utf8")).toBe(contents);
  });

  it("distinguishes an unreadable config from invalid JSON", () => {
    const root = fixture();
    writeFileSync(join(root, "config.json"), "{}");
    const cause = Object.assign(new Error("EACCES /private/config.json secret"), { code: "EACCES" });
    vi.mocked(readFileSync).mockImplementationOnce(() => { throw cause; });
    try {
      verifyExistingSetupConfig(root);
      expect.fail("Expected unreadable config to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(SetupError);
      expect(error).toMatchObject({ cause, userMessage: expect.stringContaining("Could not read .mex/config.json. Access was denied") });
      expect((error as SetupError).userMessage).not.toMatch(/private|secret|valid JSON/);
    }
  });

  it("identifies a conflicting scaffold path and leaves it intact", () => {
    const root = fixture();
    mkdirSync(join(root, ".mex"));
    writeFileSync(join(root, ".mex/context"), "keep me");
    try {
      createSetupScaffold({ projectRoot: root, mode: "agent-memory" });
      expect.fail("Expected the path conflict to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(SetupError);
      expect((error as SetupError).userMessage).toContain("Could not create .mex/context/architecture.md.");
      expect((error as SetupError).userMessage).toContain("conflicting file");
      expect((error as SetupError).userMessage).not.toContain(root);
    }
  });

  it.each([
    ["EACCES", "permissions"], ["EPERM", "permissions"], ["EROFS", "read-only"],
    ["ENOSPC", "Free disk space"], ["EDQUOT", "quota"], ["EBUSY", "busy"],
    ["ENOENT", "missing"], ["EMFILE", "too many open files"],
  ])("projects %s without copying exception text", (code, remedy) => {
    const cause = Object.assign(new Error("private diagnostic /secret/path"), { code });
    const error = classifySetupFileSystemError(cause, "Could not save .mex/config.json.");
    expect(error).toMatchObject({ message: cause.message, cause });
    expect(error?.userMessage).toContain(remedy);
    expect(error?.userMessage).not.toMatch(/private|secret/);
  });

  it("does not classify unexpected exceptions by their message", () => {
    expect(classifySetupFileSystemError(new Error("EACCES"), "Save config.")).toBeNull();
    expect(classifySetupFileSystemError(Object.assign(new Error("secret"), { code: "UNKNOWN" }), "Save config.")).toBeNull();
  });
});

describe("setup Graph error boundary", () => {
  it("preserves a known maintenance failure's safe recovery instructions", async () => {
    vi.spyOn(maintenance, "rebuildGraph").mockRejectedValue(new GraphMaintenanceError("GRAPH_MAINTENANCE_LOCKED", "private lock details"));
    await expect(buildSetupGraph("/unused")).rejects.toMatchObject({
      userMessage: expect.stringMatching(/another|running|progress/i),
    });
  });

  it("keeps unknown graph failures outside the browser-safe contract", async () => {
    vi.spyOn(maintenance, "rebuildGraph").mockRejectedValue(new Error("private compiler crash"));
    const error = await buildSetupGraph("/unused").catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(SetupError);
  });

  it("checks cancellation before classifying a concurrent graph failure", async () => {
    const controller = new AbortController();
    vi.spyOn(maintenance, "rebuildGraph").mockImplementation(async () => {
      controller.abort();
      throw new GraphMaintenanceError("GRAPH_MAINTENANCE_LOCKED", "private lock details");
    });
    await expect(buildSetupGraph("/unused", { signal: controller.signal })).rejects.toThrow("Setup was cancelled");
  });
});
