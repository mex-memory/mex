import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the git helpers BEFORE importing the checker so it picks up the stubs.
vi.mock("../src/git.js", () => ({
  daysSinceLastChange: vi.fn(),
  commitsSinceLastChange: vi.fn(),
}));

const { daysSinceLastChange, commitsSinceLastChange } = await import("../src/git.js");
const { checkStaleness, DEFAULT_STALENESS_THRESHOLDS, daysSinceFrontmatterDate } = await import("../src/drift/checkers/staleness.js");

const asMock = <T extends (...args: unknown[]) => unknown>(fn: T) =>
  fn as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  asMock(daysSinceLastChange).mockReset();
  asMock(commitsSinceLastChange).mockReset();
});

describe("checkStaleness — defaults", () => {
  it("defaults to 30d warn / 90d error / 50c warn / 200c error", () => {
    expect(DEFAULT_STALENESS_THRESHOLDS).toEqual({
      warnDays: 30,
      errorDays: 90,
      warnCommits: 50,
      errorCommits: 200,
    });
  });

  it("emits no issues when the file is fresh", async () => {
    asMock(daysSinceLastChange).mockResolvedValue(5);
    asMock(commitsSinceLastChange).mockResolvedValue(10);

    const issues = await checkStaleness("a.md", "a.md", "/tmp/repo");
    expect(issues).toEqual([]);
  });

  it("collapses day + commit warnings into one combined issue at the default thresholds", async () => {
    asMock(daysSinceLastChange).mockResolvedValue(31);
    asMock(commitsSinceLastChange).mockResolvedValue(60);

    const issues = await checkStaleness("a.md", "a.md", "/tmp/repo");
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ severity: "warning", code: "STALE_FILE" });
    expect(issues[0].message).toContain("31 days");
    expect(issues[0].message).toContain("60 commits");
  });

  it("collapses day + commit errors into one combined issue at the default thresholds", async () => {
    asMock(daysSinceLastChange).mockResolvedValue(120);
    asMock(commitsSinceLastChange).mockResolvedValue(300);

    const issues = await checkStaleness("a.md", "a.md", "/tmp/repo");
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ severity: "error" });
    expect(issues[0].message).toContain("threshold: 90d");
    expect(issues[0].message).toContain("threshold: 200");
  });
});

describe("checkStaleness — custom thresholds", () => {
  it("respects a tighter warn threshold (14d)", async () => {
    asMock(daysSinceLastChange).mockResolvedValue(15);
    asMock(commitsSinceLastChange).mockResolvedValue(0);

    const issues = await checkStaleness("a.md", "a.md", "/tmp/repo", {
      warnDays: 14,
      errorDays: 30,
      warnCommits: 20,
      errorCommits: 50,
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ severity: "warning" });
    expect(issues[0].message).toContain("15 days");
    expect(issues[0].message).toContain("threshold: 14d");
  });

  it("respects a tighter error threshold (30d)", async () => {
    asMock(daysSinceLastChange).mockResolvedValue(45);
    asMock(commitsSinceLastChange).mockResolvedValue(0);

    const issues = await checkStaleness("a.md", "a.md", "/tmp/repo", {
      warnDays: 14,
      errorDays: 30,
      warnCommits: 20,
      errorCommits: 50,
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ severity: "error" });
    expect(issues[0].message).toContain("threshold: 30d");
  });

  it("respects tighter commit thresholds", async () => {
    asMock(daysSinceLastChange).mockResolvedValue(0);
    asMock(commitsSinceLastChange).mockResolvedValue(25);

    const issues = await checkStaleness("a.md", "a.md", "/tmp/repo", {
      warnDays: 999,
      errorDays: 9999,
      warnCommits: 20,
      errorCommits: 50,
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ severity: "warning" });
    expect(issues[0].message).toContain("threshold: 20");
  });

  it("is silent when custom thresholds raise the bar above reality", async () => {
    asMock(daysSinceLastChange).mockResolvedValue(60);
    asMock(commitsSinceLastChange).mockResolvedValue(150);

    const issues = await checkStaleness("a.md", "a.md", "/tmp/repo", {
      warnDays: 90,
      errorDays: 180,
      warnCommits: 200,
      errorCommits: 500,
    });
    expect(issues).toEqual([]);
  });
});

describe("checkStaleness — last_updated frontmatter", () => {
  it("ignores missing or placeholder last_updated values", () => {
    const now = new Date("2026-05-14T12:00:00Z");
    expect(daysSinceFrontmatterDate(undefined, now)).toBeNull();
    expect(daysSinceFrontmatterDate("[YYYY-MM-DD]", now)).toBeNull();
  });

  it("computes days since a concrete frontmatter date", () => {
    const now = new Date("2026-05-14T12:00:00Z");
    expect(daysSinceFrontmatterDate("2026-05-07", now)).toBe(7);
  });

  it("adds last_updated staleness to the combined issue", async () => {
    asMock(daysSinceLastChange).mockResolvedValue(0);
    asMock(commitsSinceLastChange).mockResolvedValue(0);

    const issues = await checkStaleness("a.md", "a.md", "/tmp/repo", {
      warnDays: 7,
      errorDays: 30,
      warnCommits: 999,
      errorCommits: 9999,
    }, { lastUpdated: "2020-01-01" });

    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain("last_updated");
  });
});
