import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installSetupAgentAssets, setupCommitCheckpointCommands } from "../index.js";
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
      present: [".claude/skills/mex-inbox/SKILL.md", ".claude/skills/mex-relay/SKILL.md", "CLAUDE.md"],
      absent: [".agents", "AGENTS.md"],
    },
    {
      label: "Codex-only",
      tools: ["codex"] as AiTool[],
      clients: ["codex"],
      present: [".agents/skills/mex-inbox/SKILL.md", ".agents/skills/mex-relay/SKILL.md", "AGENTS.md"],
      absent: [".claude", "CLAUDE.md"],
    },
    {
      label: "both",
      tools: ["codex", "claude", "cursor"] as AiTool[],
      clients: ["claude", "codex", "cursor"],
      present: [
        ".claude/skills/mex-inbox/SKILL.md",
        ".claude/skills/mex-relay/SKILL.md",
        ".agents/skills/mex-inbox/SKILL.md",
        ".agents/skills/mex-relay/SKILL.md",
        "CLAUDE.md",
        "AGENTS.md",
        ".cursorrules",
      ],
      absent: [],
    },
    {
      label: "Cursor-only",
      tools: ["cursor"] as AiTool[],
      clients: ["cursor"],
      present: [".agents/skills/mex-inbox/SKILL.md", ".cursorrules"],
      absent: [".claude", "AGENTS.md"],
    },
    {
      label: "Copilot-only",
      tools: ["copilot"] as AiTool[],
      clients: ["copilot"],
      present: [".agents/skills/mex-inbox/SKILL.md", ".github/copilot-instructions.md"],
      absent: [".claude", "AGENTS.md"],
    },
    {
      label: "OpenCode-only",
      tools: ["opencode"] as AiTool[],
      clients: ["opencode"],
      present: [".agents/skills/mex-inbox/SKILL.md", "AGENTS.md"],
      absent: [".claude", "CLAUDE.md"],
    },
    {
      label: "Windsurf-only",
      tools: ["windsurf"] as AiTool[],
      clients: ["windsurf"],
      present: [".agents/skills/mex-inbox/SKILL.md", ".windsurfrules"],
      absent: [".claude", "AGENTS.md"],
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

  it("stages each shared skill copy and instruction file once in the commit checkpoint", () => {
    const skills = (root: string) => ["mex-inbox", "mex-relay", "mex-statechart"].map((skill) => `${root}/${skill}`).join(" ");
    expect(setupCommitCheckpointCommands(["cursor"])).toContain(`git add .cursorrules ${skills(".agents/skills")}`);
    expect(setupCommitCheckpointCommands(["opencode"])).toContain(`git add AGENTS.md .opencode/opencode.json ${skills(".agents/skills")}`);
    expect(setupCommitCheckpointCommands(["codex", "cursor", "opencode"])).toEqual([
      "git status --short",
      "git add .mex",
      `git add AGENTS.md ${skills(".agents/skills")}`,
      "git add .cursorrules",
      "git add .opencode/opencode.json",
      'git commit -m "chore: initialize MEX"',
    ]);
  });

  it("does nothing without a selection and keeps dry-run byte-empty", () => {
    const emptyRoot = fixture();
    expect(installSetupAgentAssets({
      projectRoot: emptyRoot,
      selectedTools: [],
      packagedSkillsRoot,
    })).toBeNull();
    expect(readdirSync(emptyRoot)).toEqual([]);

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
