import { describe, expect, it } from "vitest";
import { formatSetupGraphActivity, setupGraphActivity } from "../graph-progress.js";

describe("setup graph activity", () => {
  it("labels parsed file counts without making a whole-setup percentage claim", () => {
    expect(setupGraphActivity({ phase: "parse", completed: 12, total: 40, message: "private source path" })).toEqual({
      detail: "Parsing source files", progress: { completed: 12, total: 40, unit: "files parsed" },
    });
    expect(formatSetupGraphActivity({ phase: "parse", completed: 12, total: 40, message: "private source path" }))
      .toBe("Parsing source files: 12 / 40 files parsed");
  });

  it("clears completed parse counts during resolve, validation, and publication", () => {
    for (const phase of ["resolve", "validate", "publish"] as const) {
      const activity = setupGraphActivity({ phase, completed: 40, total: 40, message: "private path or command" });
      expect(activity.progress).toBeUndefined();
      expect(activity.detail).not.toContain("private");
    }
  });

  it("does not fabricate counts or a total and refuses invalid measurements", () => {
    expect(setupGraphActivity({ phase: "parse", message: "raw" })).toEqual({ detail: "Parsing source files" });
    expect(setupGraphActivity({ phase: "parse", completed: 0, message: "raw" }).progress).toEqual({ completed: 0, unit: "files parsed" });
    for (const completed of [NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(setupGraphActivity({ phase: "parse", completed, total: 3, message: "raw" }).progress).toBeUndefined();
    }
    expect(setupGraphActivity({ phase: "parse", completed: 10, total: 2, message: "raw" }).progress).toEqual({ completed: 10, unit: "files parsed" });
  });
});
