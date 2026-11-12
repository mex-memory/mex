import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installSetupAgentAssets } from "../index.js";
import type { AiTool } from "../../types.js";

const roots: string[] = [];
const packagedSkillsRoot = resolve(__dirname, "../../../skills");

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("normal setup official-skill activation", () => {
  it.each([
    {
      label: "Claude-only",
      tools: ["claude"] as AiTool[],
      clients: ["claude"],
      present: [".claude/skills/mex-statechart/SKILL.md", ".claude/skills/mex-statechart/SKILL.md", "CLAUDE.md"],
      absent: [".agents", "AGENTS.md"],
    },
    {
      label: "Codex-only",
      tools: ["codex"] as AiTool[],
      clients: ["codex"],
      present: [".agents/skills/mex-statechart/SKILL.md", ".agents/skills/mex-statechart/SKILL.md", "AGENTS.md"],
      absent: [".claude", "CLAUDE.md"],
    },
    {
      label: "both",
      tools: ["codex", "claude", "cursor"] as AiTool[],
      clients: ["claude", "codex"],
      present: [
        ".claude/skills/mex-statechart/SKILL.md",
        ".claude/skills/mex-statechart/SKILL.md",
        ".agents/skills/mex-statechart/SKILL.md",
        ".agents/skills/mex-statechart/SKILL.md",
        "CLAUDE.md",
        "AGENTS.md",
      ],
      absent: [],
    },
  ])("installs the $label selection through setup's production seam", ({ tools, clients, present, absent }) => {
    const projectRoot = fixture();
    const report = installSetupAgentAssets({
      projectRoot,
      selectedTools: tools,
      packageVersion: "setup-test",
      packagedSkillsRoot,
    });

    expect(report).toMatchObject({ clients, applied: true, changed: true, conflicted: false });
    for (const path of present) expect(existsSync(join(projectRoot, path)), path).toBe(true);
    for (const path of absent) expect(existsSync(join(projectRoot, path)), path).toBe(false);
  });

  it("does nothing for unsupported selections and keeps dry-run byte-empty", () => {
    const unsupportedRoot = fixture();
    expect(installSetupAgentAssets({
      projectRoot: unsupportedRoot,
      selectedTools: ["cursor", "copilot"],
      packagedSkillsRoot,
    })).toBeNull();
    expect(readdirSync(unsupportedRoot)).toEqual([]);

    const dryRoot = fixture();
    const report = installSetupAgentAssets({
      projectRoot: dryRoot,
      selectedTools: ["claude", "codex"],
      packageVersion: "setup-test",
      packagedSkillsRoot,
      dryRun: true,
    });
    expect(report).toMatchObject({ dryRun: true, applied: false, changed: true });
    expect(readdirSync(dryRoot)).toEqual([]);
  });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "mex-setup-agent-skills-"));
  roots.push(root);
  return root;
}
