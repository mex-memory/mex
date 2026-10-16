import { describe, expect, it } from "vitest";
import { describeRefreshWork, readRefreshWork } from "../refresh-work.js";

describe("describeRefreshWork", () => {
  it("names an incremental refresh with its counts", () => {
    expect(describeRefreshWork({ mode: "incremental", filesChanged: 3, filesReextracted: 4 }))
      .toBe("Refresh: incremental, 3 changed, 4 re-extracted.");
  });

  it("gives the reason a full refresh was not incremental", () => {
    expect(describeRefreshWork({
      mode: "full", fallbackReason: "the configuration or the engine changed", filesChanged: 2, filesReextracted: 480,
    })).toBe("Refresh: full (the configuration or the engine changed), 2 changed, 480 re-extracted.");
  });

  it("says plainly when there was nothing to do", () => {
    expect(describeRefreshWork(undefined)).toBe("Refresh: nothing changed.");
  });
});

describe("readRefreshWork", () => {
  const result = (extra: Record<string, unknown>): string => JSON.stringify({ state: "succeeded", filesIndexed: 1, ...extra });

  it("reads the mode, reason and counts out of `graph refresh --json`", () => {
    expect(readRefreshWork(result({
      refresh: { mode: "full", fallbackReason: "no extraction cache describes the stored graph", filesChanged: 5, filesReextracted: 90, publication: "full", filesRewritten: 90 },
    }))).toEqual({ mode: "full", reason: "no extraction cache describes the stored graph", changed: 5, reextracted: 90 });
    expect(readRefreshWork(result({ refresh: { mode: "incremental", filesChanged: 1, filesReextracted: 1 } })))
      .toEqual({ mode: "incremental", changed: 1, reextracted: 1 });
  });

  it("reports a refresh that found nothing to do as unchanged", () => {
    expect(readRefreshWork(result({}))).toEqual({ mode: "unchanged", changed: 0, reextracted: 0 });
  });

  it("is null for anything that is not a successful refresh result", () => {
    expect(readRefreshWork("")).toBeNull();
    expect(readRefreshWork("not json")).toBeNull();
    expect(readRefreshWork(JSON.stringify({ state: "failed" }))).toBeNull();
    expect(readRefreshWork(result({ refresh: { mode: "sideways" } }))).toBeNull();
  });
});
