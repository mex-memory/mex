import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentAssetsError,
  applyAgentAssetsPlan,
  planAgentAssets,
  type AgentAssetsErrorCode,
} from "../../agent-skills/installer.js";
import { classifySetupAgentAssetsError } from "../agent-errors.js";
import { SetupError } from "../errors.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("setup agent integration error classification", () => {
  it.each([
    ["INVALID_PACKAGED_SKILL", "Reinstall MEX"],
    ["INVALID_OPTIONS", "Check the project directory"],
    ["IGNORE_CHECK_FAILED", "run git status"],
    ["CONCURRENT_MODIFICATION", "review the affected files"],
    ["PATH_IDENTITY_CHANGED", "reconcile those backups before rerunning setup"],
    ["REPLACEMENT_ACTIVE_BACKUP_RETAINED", "reconcile those backups before rerunning setup"],
    ["APPLY_FAILED", "reconcile those backups before rerunning setup"],
  ] satisfies Array<[AgentAssetsErrorCode, string]>)("classifies %s by code while retaining private diagnostics", (code, recovery) => {
    const underlying = new Error("private child output and secret token");
    const original = new AgentAssetsError(code, "failure at /private/project/secret-path", { cause: underlying });

    const classified = classifySetupAgentAssetsError(original);

    expect(classified).toBeInstanceOf(SetupError);
    expect(classified?.message).toBe(original.message);
    expect(classified?.cause).toBe(original);
    expect(original.cause).toBe(underlying);
    expect(classified?.userMessage).toContain(recovery);
    expect(classified?.userMessage).not.toMatch(/private|secret|token/);
    expect(classified?.userMessage.length).toBeLessThanOrEqual(512);
    const differentText = new AgentAssetsError(code, "unrelated diagnostic");
    expect(classifySetupAgentAssetsError(differentText)?.userMessage).toBe(classified?.userMessage);
  });

  it("preserves rollback diagnostics without recommending an unreviewed retry", () => {
    const rollback = new AggregateError([
      new Error("activation failed at /private/project"),
      new Error("backup retained at /private/backup"),
    ]);
    const original = new AgentAssetsError("APPLY_FAILED", "Could not restore /private/backup", { cause: rollback });

    const classified = classifySetupAgentAssetsError(original);

    expect(classified?.cause).toBe(original);
    expect(original.cause).toBe(rollback);
    expect(classified?.userMessage).toContain("some files or backups may remain");
    expect(classified?.userMessage).toContain("reconcile those backups before rerunning setup");
    expect(classified?.userMessage).toContain(".mex-backup-");
    expect(classified?.userMessage).toContain(".claude/skills or .agents/skills");
    expect(classified?.userMessage).not.toContain("terminal diagnostics");
    expect(classified?.userMessage).not.toContain("/private/");
  });

  it.each(["EACCES", "ENOSPC"])("delegates raw %s failures to the filesystem classifier", (code) => {
    const original = Object.assign(new Error("private filesystem diagnostic"), { code });

    const classified = classifySetupAgentAssetsError(original);

    expect(classified?.message).toBe(original.message);
    expect(classified?.cause).toBe(original);
    expect(classified?.userMessage).toContain("Could not install the selected agent integrations");
    expect(classified?.userMessage).toContain(code === "EACCES" ? "permissions" : "Storage is full");
    expect(classified?.userMessage).not.toContain("private");
  });

  it.each([
    new Error("INVALID_PACKAGED_SKILL: missing packaged skills"),
    Object.assign(new Error("pretended installer failure"), { code: "INVALID_PACKAGED_SKILL" }),
    { name: "AgentAssetsError", code: "APPLY_FAILED", message: "pretended installer failure" },
    new AgentAssetsError("UNKNOWN_PLAN", "private internal diagnostic"),
    new AgentAssetsError("DRY_RUN_PLAN", "private internal diagnostic"),
    new AgentAssetsError("FUTURE_CODE" as AgentAssetsErrorCode, "private future diagnostic"),
    null,
  ])("leaves unrecognized failures for the generic fallback: %j", (error) => {
    expect(classifySetupAgentAssetsError(error)).toBeNull();
  });

  it.each(["missing", "invalid"])("classifies a real %s packaged-skills failure", (kind) => {
    const root = fixture();
    const source = join(root, "packaged-skills");
    if (kind === "invalid") {
      mkdirSync(join(source, "mex-inbox"), { recursive: true });
      writeFileSync(join(source, "mex-inbox", "README.md"), "No SKILL.md\n");
    }
    const original = captureInstallerError(() => planAgentAssets({
      projectRoot: root, packagedSkillsRoot: source, packageVersion: "1.0.0",
      clients: ["claude"], checkIgnored: false,
    }));

    const classified = classifySetupAgentAssetsError(original);

    expect(original.code).toBe("INVALID_PACKAGED_SKILL");
    expect(classified?.cause).toBe(original);
    expect(classified?.userMessage).toContain("packaged MEX agent skills are missing or invalid");
    expect(classified?.userMessage).not.toContain(root);
  });

  it("classifies a real change between installation preview and apply", () => {
    const root = fixture();
    const source = join(root, "packaged-skills");
    for (const skill of ["mex-inbox", "mex-relay"]) {
      mkdirSync(join(source, skill), { recursive: true });
      writeFileSync(join(source, skill, "SKILL.md"), "Packaged skill\n");
    }
    const plan = planAgentAssets({
      projectRoot: root, packagedSkillsRoot: source, packageVersion: "1.0.0",
      clients: ["claude"], checkIgnored: false,
    });
    mkdirSync(join(root, ".claude/skills/mex-inbox"), { recursive: true });
    writeFileSync(join(root, ".claude/skills/mex-inbox/SKILL.md"), "Concurrent authored skill\n");
    const original = captureInstallerError(() => applyAgentAssetsPlan(plan));

    const classified = classifySetupAgentAssetsError(original);

    expect(original.code).toBe("CONCURRENT_MODIFICATION");
    expect(classified?.userMessage).toContain("Finish or stop other edits");
    expect(classified?.cause).toBe(original);
  });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "mex-setup-agent-errors-"));
  roots.push(root);
  return root;
}

function captureInstallerError(run: () => unknown): AgentAssetsError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(AgentAssetsError);
    return error as AgentAssetsError;
  }
  throw new Error("Expected an agent installer failure.");
}
