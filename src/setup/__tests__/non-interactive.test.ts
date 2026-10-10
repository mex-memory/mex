/**
 * `mex setup --cli --tool <tool> --yes` runs without a terminal: the tool
 * comes from the flag, and population counts as finished once the scaffold
 * has no placeholders left.
 */
import { describe, expect, it } from "vitest";
import { parseSetupTools } from "../index.js";

describe("parseSetupTools", () => {
  it("accepts known tools case-insensitively and maps none to no tool", () => {
    expect(parseSetupTools(["claude", "Codex"])).toEqual(["claude", "codex"]);
    expect(parseSetupTools(["none"])).toEqual([]);
  });

  it("rejects an unknown tool by name", () => {
    expect(() => parseSetupTools(["emacs"])).toThrow(/Unknown --tool emacs/);
  });
});
