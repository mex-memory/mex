import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const doc = readFileSync(new URL("../COMPATIBILITY.md", import.meta.url), "utf8");
const section = doc.slice(doc.indexOf("## Agents in 0.9"), doc.indexOf("## Runtime requirement"));
const rows = (heading: string) => {
  const start = section.indexOf(heading);
  const end = section.indexOf("\n### ", start + 1);
  return section.slice(start, end < 0 ? undefined : end).split("\n").filter((l) => l.startsWith("| ") && !l.startsWith("| ---"));
};

describe("COMPATIBILITY.md agent tables", () => {
  const agents = ["Claude Code", "Codex", "Cursor", "Antigravity", "Gemini CLI", "Copilot CLI", "OpenCode", "Devin", "Kiro"];

  it("has a capability row with a session-learning column for every agent", () => {
    const table = rows("## Agents in 0.9");
    for (const agent of [...agents, "Cline", "Amp", "Aider"]) {
      const row = table.find((l) => l.startsWith(`| ${agent}`));
      expect(row, agent).toBeDefined();
      expect(row!.split(" | ").length, agent).toBe(8);
    }
  });

  it("covers every agent in the rule-file matrix, plus Cline, Amp and Aider", () => {
    const table = rows("### Who loads which rule file");
    for (const agent of [...agents, "Cline", "Amp", "Aider"]) expect(table.some((l) => l.startsWith(`| ${agent}`)), agent).toBe(true);
  });

  it("states positions for Cline, Amp, Aider and Devin Desktop", () => {
    for (const agent of ["Cline", "Amp", "Aider", "Devin Desktop"]) expect(section).toContain(`**${agent}`);
  });

  it("names a cheap and a best model for every release-03 agent", () => {
    const table = rows("### Models per agent");
    for (const agent of ["Claude Code", "Codex", "Cursor", "Antigravity", "Gemini CLI"]) {
      expect(table.find((l) => l.startsWith(`| ${agent}`))?.split(" | ").length, agent).toBe(4);
    }
  });

  it("dates the docs it was checked against", () => {
    expect(section).toMatch(/Read on \d{1,2} \w{3} \d{4}/);
  });
});
