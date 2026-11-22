/**
 * The learn-deeper offer on the setup screen: both screens ask with the same keys, and a
 * person who skips is told it cost nothing and how to start it later. The engine is mocked:
 * this is the screen's part only.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../learn-deeper/git.js", () => ({ origin: async () => ({ host: "github.com", owner: "acme", name: "widgets" }) }));
vi.mock("../../learn-deeper/offer.js", () => ({
  offerLearning: async (options: { confirm?: (lines: string[], details: string[]) => Promise<boolean>; write: (line: string) => void }) => {
    if (!options.confirm) { options.write("no confirm"); return; }
    await options.confirm(["Learn from past reviews and docs using your agent plan?", "Estimate 1,000 tokens"], ["details line"]);
  },
}));
vi.mock("../keys.js", () => ({ readKey: vi.fn(async () => "s") }));

const { offerLearnDeeper } = await import("../deeper-steps.js");
const { Rich } = await import("../rich.js");

function context(rich: boolean, interactive = true) {
  const lines: string[] = [];
  return {
    lines,
    value: {
      root: "C:/repo", projectId: "g-0123456789abcdef01234567", location: {} as never, interactive, env: {},
      mode: (rich ? "rich" : "plain") as never, rich: rich ? new Rich({ NO_COLOR: "1" }, 100) : undefined,
      write: (line: string) => { lines.push(line); },
    },
  };
}

describe("the learn-deeper offer on the setup screen", () => {
  it("plain: says how to skip, and says it was skipped at $0", async () => {
    const { lines, value } = context(false);
    expect(await offerLearnDeeper(value)).toBeUndefined();
    expect(lines).toContain("Enter = start, s = skip, d = details");
    expect(lines.at(-1)).toBe("Learn deeper skipped · $0 · start it any time with `mex learn`");
  });

  it("rich: the same keys, and the skip is a Learn deeper row", async () => {
    const { lines, value } = context(true);
    await offerLearnDeeper(value);
    // eslint-disable-next-line no-control-regex
    const text = lines.join("\n").replace(/\u001b\[[0-9;]*m/gu, "");
    expect(text).toMatch(/\[Enter\] start.*\[s\] skip.*\[d\] details/u);
    expect(text).toMatch(/Learn deeper\s+skipped · \$0 · start it any time with `mex learn`/u);
  });

  it("never asks an agent, a script or CI", async () => {
    const { lines, value } = context(false, false);
    await offerLearnDeeper(value);
    expect(lines).toEqual(["no confirm"]);
  });
});
