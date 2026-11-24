import { describe, expect, it } from "vitest";
import { stripVTControlCharacters } from "node:util";
import { confirmAnalysis, renderAnalysisActivity } from "../analysis-screen.js";
import { pickAnalysisAgent } from "../../learn-deeper/offer.js";
import type { AgentStatus } from "../../model-runner/agents.js";
import { Rich } from "../rich.js";
import { TerminalBlock } from "../select.js";

describe("deep analysis screens", () => {
  it("opens and hides the rich quote in place, and Escape declines", async () => {
    const lines: string[] = [];
    const block = new TerminalBlock(text => lines.push(text), () => 80);
    const keys = ["d", "h", "quit"];
    const approved = await confirmAnalysis({
      rich: new Rich(), block, write: line => lines.push(line), read: async () => keys.shift()!,
      introduction: "MEX can read the repo's history.", details: [["Usage", "around 2,000 tokens (estimated)"]],
    });
    expect(approved).toBe(false);
    expect(stripVTControlCharacters(lines.join("\n"))).toMatch(/\[Enter\] proceed.*\[d\] details[\s\S]+Usage\s+around 2,000 tokens \(estimated\)[\s\S]+\[h\] hide details/u);
    expect(lines.join("")).toContain("\x1b[0J");
    expect(lines.join("")).not.toContain("[s]");
  });

  it("gives the same detail and consent to a plain terminal", async () => {
    const lines: string[] = [];
    const keys = ["d", "enter"];
    expect(await confirmAnalysis({
      write: line => lines.push(line), read: async () => keys.shift()!,
      details: [["Stop it", "`mex cancel` at any time"]],
    })).toBe(true);
    expect(lines).toContain("Stop it: `mex cancel` at any time");
    expect(lines.join("")).not.toContain("\x1b");
  });

  it("draws live stages, the active call and three recent results", () => {
    const activity = {
      agent: "Claude Code", stage: 1, done: 412, total: 880, unit: "sources",
      finished: ["863 PRs · 2 reverts · 15 docs"], tokens: 212_000,
      startedAt: "2026-01-01T00:00:00Z", current: { subject: "PR #4951", title: "compress", startedAt: "2026-01-01T00:05:37Z" },
      recent: Array.from({ length: 4 }, (_, i) => ({ subject: `PR #${i}`, result: "2 lessons" })),
    };
    const now = Date.parse("2026-01-01T00:06:00Z");
    const text = renderAnalysisActivity("repo", activity, { rich: new Rich(), now }).map(stripVTControlCharacters).join("\n");
    expect(text).toMatch(/DEEP ANALYSIS.*repo.*Claude Code.*6m 00s · 212k tokens/u);
    expect(text).toMatch(/Sort sources\s+▰+▱+\s+412 of 880$/mu);
    expect(text).toContain("Claude Code is working on PR #4951 compress  23s");
    expect(text).toContain("PR #2 → 2 lessons");
    expect(text).not.toContain("PR #3 →");
    expect(text).toContain("mex cancel: stop it");
    expect(renderAnalysisActivity("repo", activity, { now })).toEqual([
      "Deep analysis · repo · Claude Code · 6m 00s · 212k tokens",
      "  Read sources · 863 PRs · 2 reverts · 15 docs",
      "Sort sources 412 of 880",
      "Claude Code is working on PR #4951 compress (23s)",
      "  PR #0 → 2 lessons", "  PR #1 → 2 lessons", "  PR #2 → 2 lessons",
    ]);
  });

  it("ranks runnable agents, shows disabled reasons and names the missing agents", async () => {
    const runner = { ok: true, best: null, cheap: null, usage: "reported", models: "Writer and checker" } as const;
    const agents: AgentStatus[] = [
      { id: "claude-code", name: "Claude Code", installed: true, cli: "claude", hooks: "supported", runner, sessions7d: 2 },
      { id: "codex", name: "Codex", installed: true, cli: "codex", hooks: "supported", runner, sessions7d: 5 },
      { id: "gemini", name: "Gemini CLI", installed: true, cli: "gemini", hooks: "none", runner: { ok: false, reason: "unavailable in this build" }, sessions7d: 0 },
      { id: "kiro", name: "Kiro", installed: false, cli: null, hooks: "none", runner: { ok: false, reason: "CLI absent" }, sessions7d: 0 },
    ];
    const lines: string[] = [];
    expect(await pickAnalysisAgent(agents, { write: line => lines.push(line), read: async () => "enter" })).toBe(agents[1]);
    expect(lines.join("\n")).toMatch(/1\. Codex.*you use it most[\s\S]+2\. Claude Code[\s\S]+Gemini CLI.*unavailable in this build[\s\S]+supports 1 more agent: Kiro/u);
  });
});
