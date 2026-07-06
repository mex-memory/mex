import { describe, it, expect } from "vitest";
import { isCliAvailable } from "../src/cli-tools.js";

describe("isCliAvailable", () => {
  it("detects a command that is on PATH", () => {
    // `node` is necessarily present — the test runner is running under it.
    expect(isCliAvailable("node")).toBe(true);
  });

  it("returns false for a command that does not exist", () => {
    expect(isCliAvailable("definitely-not-a-real-cli-xyz123")).toBe(false);
  });

  it("does not throw on a bogus command (swallows the probe error)", () => {
    expect(() => isCliAvailable("nope-nope-nope")).not.toThrow();
  });
});
