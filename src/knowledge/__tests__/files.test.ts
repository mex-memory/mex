import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEntryFile, readEntryFile } from "../files.js";

vi.mock("node:fs", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, linkSync: vi.fn(fs.linkSync), unlinkSync: vi.fn(fs.unlinkSync) };
});
const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
let root: string, directory: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mex-knowledge-files-"));
  directory = join(root, "notes"); mkdirSync(directory);
  vi.mocked(linkSync).mockImplementation(fs.linkSync);
  vi.mocked(unlinkSync).mockImplementation(fs.unlinkSync);
});
afterEach(() => { vi.clearAllMocks(); rmSync(root, { recursive: true, force: true }); });

describe("note publication failures", () => {
  it("acknowledges a complete publication even if staging cleanup fails", () => {
    vi.mocked(unlinkSync).mockImplementation(() => { throw new Error("cleanup unavailable"); });
    expect(() => createEntryFile(directory, "mx_saved1", "A complete fact.\n")).not.toThrow();
    expect(readEntryFile(join(directory, "mx_saved1.md"))).toBe("A complete fact.\n");
    expect(readdirSync(directory).filter(name => name.endsWith(".md"))).toEqual(["mx_saved1.md"]);
  });

  it("preserves the publication error when cleanup also fails", () => {
    const failure = new Error("publication unavailable");
    vi.mocked(linkSync).mockImplementation(() => { throw failure; });
    vi.mocked(unlinkSync).mockImplementation(() => { throw new Error("cleanup unavailable"); });
    expect(() => createEntryFile(directory, "mx_saved1", "A complete fact.\n")).toThrow(failure);
    expect(existsSync(join(directory, "mx_saved1.md"))).toBe(false);
  });

  it("leaves a replacement staging file untouched after publication fails", () => {
    const failure = new Error("publication unavailable");
    let staging = "";
    vi.mocked(linkSync).mockImplementation(source => {
      staging = String(source);
      renameSync(staging, join(root, "original"));
      writeFileSync(staging, "A different owner's file.");
      throw failure;
    });
    expect(() => createEntryFile(directory, "mx_saved1", "A complete fact.\n")).toThrow(failure);
    expect(readFileSync(staging, "utf8")).toBe("A different owner's file.");
    expect(readFileSync(join(root, "original"), "utf8")).toBe("A complete fact.\n");
    expect(existsSync(join(directory, "mx_saved1.md"))).toBe(false);
  });
});
