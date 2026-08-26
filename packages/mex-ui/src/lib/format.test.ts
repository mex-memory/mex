import { describe, it, expect } from "vitest";
import {
  formatBytes,
  formatCount,
  formatDuration,
  formatRelativeTime,
  humanizeCode,
  languageLabel,
  percent,
  pluralize,
  truncatePath,
} from "./format";

describe("formatBytes", () => {
  it("scales through the units", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(1024 * 1024 * 1.5)).toBe("1.5 MB");
  });

  it("drops the decimal once the number is wide", () => {
    expect(formatBytes(1024 * 64)).toBe("64 KB");
  });

  it("renders an em dash for nonsense input", () => {
    expect(formatBytes(-1)).toBe("—");
    expect(formatBytes(Number.NaN)).toBe("—");
  });
});

describe("formatRelativeTime", () => {
  const now = new Date("2026-06-15T12:00:00.000Z");

  it("collapses anything recent to `just now`", () => {
    expect(formatRelativeTime("2026-06-15T11:59:30.000Z", now)).toBe("just now");
  });

  it("counts minutes, hours, and days", () => {
    expect(formatRelativeTime("2026-06-15T11:30:00.000Z", now)).toBe("30m ago");
    expect(formatRelativeTime("2026-06-15T06:00:00.000Z", now)).toBe("6h ago");
    expect(formatRelativeTime("2026-06-11T12:00:00.000Z", now)).toBe("4d ago");
  });

  it("falls back to a date past a month", () => {
    expect(formatRelativeTime("2026-01-14T12:00:00.000Z", now)).toBe("2026-01-14");
  });

  it("never shows a negative age for clock skew", () => {
    expect(formatRelativeTime("2026-06-15T12:05:00.000Z", now)).toBe("just now");
  });

  it("handles missing and unparseable timestamps", () => {
    expect(formatRelativeTime(null, now)).toBe("—");
    expect(formatRelativeTime("not-a-date", now)).toBe("—");
  });
});

describe("formatDuration", () => {
  it("switches from milliseconds to seconds to minutes", () => {
    expect(formatDuration(430)).toBe("430ms");
    expect(formatDuration(4300)).toBe("4.3s");
    expect(formatDuration(42_000)).toBe("42s");
    expect(formatDuration(95_000)).toBe("1m 35s");
  });
});

describe("truncatePath", () => {
  it("leaves a short path alone", () => {
    expect(truncatePath("/home/me/app", 48)).toBe("/home/me/app");
  });

  it("keeps the meaningful tail of a long posix path", () => {
    const result = truncatePath("/Users/me/code/projects/api/src/routes/users.ts", 30);
    expect(result.startsWith("…/")).toBe(true);
    expect(result.endsWith("users.ts")).toBe(true);
    expect(result.length).toBeLessThanOrEqual(30);
  });

  it("preserves windows separators", () => {
    const result = truncatePath("C:\\Users\\me\\code\\projects\\api\\src\\routes\\users.ts", 30);
    expect(result.startsWith("…\\")).toBe(true);
    expect(result).toContain("users.ts");
  });
});

describe("percent", () => {
  it("clamps to 0-100 and tolerates a zero total", () => {
    expect(percent(1, 4)).toBe(25);
    expect(percent(9, 4)).toBe(100);
    expect(percent(-1, 4)).toBe(0);
    expect(percent(1, 0)).toBe(0);
  });
});

describe("labels", () => {
  it("pluralizes on the count", () => {
    expect(pluralize(1, "file")).toBe("1 file");
    expect(pluralize(3, "file")).toBe("3 files");
    expect(pluralize(2, "entity", "entities")).toBe("2 entities");
  });

  it("uses canonical language names and passes unknown ones through", () => {
    expect(languageLabel("typescript")).toBe("TypeScript");
    expect(languageLabel("cpp")).toBe("C++");
    expect(languageLabel("brainfuck")).toBe("brainfuck");
  });

  it("turns engine issue codes into sentences", () => {
    expect(humanizeCode("STALE_FILE")).toBe("Stale file");
    expect(humanizeCode("GROUNDING_MOVED")).toBe("Grounding moved");
    expect(humanizeCode("DRIFT")).toBe("Drift");
  });

  it("formats counts with thousands separators", () => {
    expect(formatCount(1234)).toBe((1234).toLocaleString());
    expect(formatCount(Number.NaN)).toBe("—");
  });
});
