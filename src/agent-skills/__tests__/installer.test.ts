import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentAssetsError,
  MEX_MANAGED_SKILL_METADATA,
  applyAgentAssetsPlan,
  defaultAgentSkillIgnoreChecker,
  planAgentAssets,
  renderInstructionChangePreview,
  renderManagedInstructionBlock,
  syncAgentAssets,
  type AgentAssetsReport,
  type AgentSkillClient,
  type MexManagedSkillMetadata,
  type OfficialMexSkill,
} from "../index.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("managed agent asset installation", () => {
  it.each([
    ["claude", ".claude/skills", "CLAUDE.md", ".agents/skills", "AGENTS.md"],
    ["codex", ".agents/skills", "AGENTS.md", ".claude/skills", "CLAUDE.md"],
  ] as const)("installs only the selected %s client", (client, skillRoot, instructions, otherRoot, otherInstructions) => {
    const fixture = createFixture();
    const report = sync(fixture, [client]);

    expect(report).toMatchObject({ applied: true, changed: true, conflicted: false });
    for (const skill of ["mex-inbox", "mex-relay", "mex-statechart"] as const) {
      expect(exists(fixture.project, `${skillRoot}/${skill}/SKILL.md`)).toBe(true);
      expectInstalledBytes(fixture, skill, `${skillRoot}/${skill}`);
    }
    expect(exists(fixture.project, instructions)).toBe(true);
    expect(exists(fixture.project, otherRoot)).toBe(false);
    expect(exists(fixture.project, otherInstructions)).toBe(false);
  });

  it("installs both clients from one canonical source with deterministic ownership", () => {
    const fixture = createFixture();
    const report = sync(fixture, ["codex", "claude", "codex"]);

    expect(report.clients).toEqual(["claude", "codex"]);
    expect(report.actions).toHaveLength(8);
    for (const [clientRoot, instructions] of [
      [".claude/skills", "CLAUDE.md"],
      [".agents/skills", "AGENTS.md"],
    ] as const) {
      for (const skill of ["mex-inbox", "mex-relay", "mex-statechart"] as const) {
        expectInstalledBytes(fixture, skill, `${clientRoot}/${skill}`);
        const metadata = readMetadata(fixture.project, `${clientRoot}/${skill}`);
        expect(metadata).toMatchObject({
          schemaVersion: 1,
          owner: "mex-agent",
          skill,
          packageVersion: "1.0.0",
        });
        expect(Object.keys(metadata.files)).toEqual(Object.keys(metadata.files).sort());
      }
      expect(read(fixture.project, instructions)).toContain("MEX agent skills");
    }
  });

  it("is an exact no-op on rerun and does not replace installed files", () => {
    const fixture = createFixture();
    sync(fixture, ["claude"]);
    const skillPath = join(fixture.project, ".claude/skills/mex-inbox/SKILL.md");
    const instructionPath = join(fixture.project, "CLAUDE.md");
    const before = {
      skillInode: statSync(skillPath).ino,
      instructionInode: statSync(instructionPath).ino,
      tree: snapshotTree(fixture.project),
    };

    const report = sync(fixture, ["claude"]);

    expect(report).toMatchObject({ applied: true, changed: false, conflicted: false });
    expect(report.actions.map((action) => action.action)).toEqual(["noop", "noop", "noop", "noop"]);
    expect(statSync(skillPath).ino).toBe(before.skillInode);
    expect(statSync(instructionPath).ino).toBe(before.instructionInode);
    expect(snapshotTree(fixture.project)).toEqual(before.tree);
  });

  it("dry-run writes nothing and reports the same actions and warnings as a real run", () => {
    const dryFixture = createFixture();
    const realFixture = createFixture();
    const ignored = (_root: string, path: string) => path.includes("/mex-inbox/");
    const before = snapshotTree(dryFixture.project);

    const dry = syncAgentAssets({
      projectRoot: dryFixture.project,
      packagedSkillsRoot: dryFixture.source,
      packageVersion: "1.0.0",
      clients: ["claude", "codex"],
      dryRun: true,
      ignoreChecker: ignored,
    });
    const real = syncAgentAssets({
      projectRoot: realFixture.project,
      packagedSkillsRoot: realFixture.source,
      packageVersion: "1.0.0",
      clients: ["claude", "codex"],
      ignoreChecker: ignored,
    });

    expect(dry).toMatchObject({ dryRun: true, applied: false, changed: true });
    expect(snapshotTree(dryFixture.project)).toEqual(before);
    expect(dry.actions).toEqual(real.actions);
    expect(dry.warnings).toEqual(real.warnings);
  });

  it("reports a bounded exact managed-block change without user-owned file bytes", () => {
    const fixture = createFixture();
    write(fixture.project, "CLAUDE.md", "# private handwritten preface\nkeep this out of previews\n");

    const report = syncAgentAssets({
      projectRoot: fixture.project,
      packagedSkillsRoot: fixture.source,
      packageVersion: "1.0.0",
      clients: ["claude"],
      dryRun: true,
      checkIgnored: false,
    });
    const action = instructionAction(report, "claude");

    expect(action.instructionChange).toEqual({
      scope: "append",
      before: null,
      after: renderManagedInstructionBlock("claude"),
    });
    expect(JSON.stringify(action)).not.toContain("private handwritten preface");
    expect(JSON.stringify(action)).not.toContain("keep this out of previews");
    expect(renderInstructionChangePreview(action)).toBe([
      "Instruction change (append) for CLAUDE.md:",
      "--- before MEX managed block ---",
      "(none)",
      "--- after MEX managed block ---",
      renderManagedInstructionBlock("claude"),
    ].join("\n"));
  });

  it("atomically upgrades an older unmodified managed copy", () => {
    const fixture = createFixture();
    sync(fixture, ["claude"]);
    write(fixture.source, "mex-inbox/SKILL.md", "inbox v2\n");

    const report = syncAgentAssets({
      projectRoot: fixture.project,
      packagedSkillsRoot: fixture.source,
      packageVersion: "2.0.0",
      clients: ["claude"],
      checkIgnored: false,
    });

    expect(actionFor(report, "mex-inbox")).toMatchObject({ action: "update" });
    expect(read(fixture.project, ".claude/skills/mex-inbox/SKILL.md")).toBe("inbox v2\n");
    expect(readMetadata(fixture.project, ".claude/skills/mex-inbox").packageVersion).toBe("2.0.0");
    expect(readdirSync(join(fixture.project, ".claude/skills"))).toEqual(["mex-inbox", "mex-relay", "mex-statechart"]);
  });

  it("preserves a modified managed copy and reports its exact conflict path", () => {
    const fixture = createFixture();
    sync(fixture, ["claude"]);
    write(fixture.project, ".claude/skills/mex-inbox/SKILL.md", "user customization\n");
    write(fixture.source, "mex-inbox/SKILL.md", "upstream v2\n");

    const report = syncAgentAssets({
      projectRoot: fixture.project,
      packagedSkillsRoot: fixture.source,
      packageVersion: "2.0.0",
      clients: ["claude"],
      checkIgnored: false,
    });

    expect(actionFor(report, "mex-inbox")).toMatchObject({
      action: "conflict",
      path: ".claude/skills/mex-inbox",
    });
    expect(report.warnings).toContainEqual(expect.objectContaining({
      code: "managed-skill-modified",
      path: ".claude/skills/mex-inbox",
    }));
    expect(read(fixture.project, ".claude/skills/mex-inbox/SKILL.md")).toBe("user customization\n");
  });

  // Git checks text files out with CRLF under core.autocrlf=true, the Windows
  // default, so a committed managed skill cloned on Windows differs from its
  // recorded hashes in line endings only. That is the content MEX installed.
  it("treats a CRLF checkout of an unmodified managed copy as unchanged", () => {
    const fixture = createFixture();
    sync(fixture, ["claude"]);
    toCrlf(join(fixture.project, ".claude/skills/mex-inbox"));
    const before = snapshotTree(join(fixture.project, ".claude/skills/mex-inbox"));

    const report = sync(fixture, ["claude"]);

    expect(report.conflicted).toBe(false);
    expect(actionFor(report, "mex-inbox").action).toBe("noop");
    expect(report.warnings.filter((warning) => warning.code === "managed-skill-modified")).toEqual([]);
    // Nothing is rewritten just to change line endings back.
    expect(snapshotTree(join(fixture.project, ".claude/skills/mex-inbox"))).toEqual(before);
  });

  it("updates a CRLF checkout of an unmodified managed copy when the package changes", () => {
    const fixture = createFixture();
    sync(fixture, ["claude"]);
    toCrlf(join(fixture.project, ".claude/skills/mex-inbox"));
    write(fixture.source, "mex-inbox/SKILL.md", "upstream v2\n");

    const report = syncAgentAssets({
      projectRoot: fixture.project,
      packagedSkillsRoot: fixture.source,
      packageVersion: "2.0.0",
      clients: ["claude"],
      checkIgnored: false,
    });

    expect(report.conflicted).toBe(false);
    expect(actionFor(report, "mex-inbox").action).toBe("update");
    expect(read(fixture.project, ".claude/skills/mex-inbox/SKILL.md")).toBe("upstream v2\n");
  });

  it("still preserves a real edit in a CRLF checkout", () => {
    const fixture = createFixture();
    sync(fixture, ["claude"]);
    toCrlf(join(fixture.project, ".claude/skills/mex-inbox"));
    const skill = join(fixture.project, ".claude/skills/mex-inbox/SKILL.md");
    writeFileSync(skill, readFileSync(skill, "utf8") + "user note\r\n");

    const report = sync(fixture, ["claude"]);

    expect(actionFor(report, "mex-inbox").action).toBe("conflict");
    expect(report.warnings).toContainEqual(expect.objectContaining({
      code: "managed-skill-modified",
      path: ".claude/skills/mex-inbox",
    }));
    expect(readFileSync(skill, "utf8").endsWith("user note\r\n")).toBe(true);
  });

  it("copies a CRLF package exactly and accepts an LF checkout of it", () => {
    const fixture = createFixture();
    toCrlf(fixture.source);
    sync(fixture, ["claude"]);
    const directory = join(fixture.project, ".claude/skills/mex-inbox");
    expect(read(fixture.project, ".claude/skills/mex-inbox/SKILL.md")).toBe("inbox v1\r\n");
    for (const path of ["SKILL.md", "references/workflow.md"].map((name) => join(directory, name))) {
      writeFileSync(path, readFileSync(path, "utf8").replace(/\r\n/gu, "\n"));
    }
    const before = snapshotTree(directory);
    expect(actionFor(sync(fixture, ["claude"]), "mex-inbox").action).toBe("noop");
    expect(snapshotTree(directory)).toEqual(before);
  });

  it.each(["lf", "crlf", "mixed"] as const)(
    "recognizes legacy CRLF ownership hashes in a %s checkout without rewriting it",
    (endings) => {
      const fixture = createFixture();
      sync(fixture, ["claude"]);
      const directory = join(fixture.project, ".claude/skills/mex-inbox");
      const metadata = readMetadata(fixture.project, ".claude/skills/mex-inbox");
      const files = Object.fromEntries(Object.keys(metadata.files).map((path) => [path,
        createHash("sha256").update(readFileSync(join(directory, path), "utf8")
          .replace(/\r?\n/gu, "\r\n")).digest("hex"),
      ]));
      writeFileSync(join(directory, MEX_MANAGED_SKILL_METADATA),
        JSON.stringify({ ...metadata, files }, null, 2) + "\n");
      if (endings === "crlf") toCrlf(directory);
      if (endings === "mixed") {
        toCrlf(directory);
        writeFileSync(join(directory, "SKILL.md"), "inbox v1\n");
      }
      const before = snapshotTree(directory);
      const report = sync(fixture, ["claude"]);
      expect(actionFor(report, "mex-inbox").action).toBe("noop");
      expect(snapshotTree(directory)).toEqual(before);
      const skill = join(directory, "SKILL.md");
      const original = readFileSync(skill);
      const edited = Buffer.concat([original, Buffer.from("user note\n")]);
      writeFileSync(skill, edited);
      expect(actionFor(sync(fixture, ["claude"]), "mex-inbox").action).toBe("conflict");
      expect(readFileSync(skill)).toEqual(edited);
      writeFileSync(skill, original);
      write(fixture.source, "mex-inbox/SKILL.md", "upstream v2\n");
      expect(actionFor(sync(fixture, ["claude"]), "mex-inbox").action).toBe("update");
      expect(read(fixture.project, ".claude/skills/mex-inbox/SKILL.md")).toBe("upstream v2\n");
      expect(actionFor(sync(fixture, ["claude"]), "mex-inbox").action).toBe("noop");
    },
  );

  it("leaves mixed LF/CRLF endings unchanged, including ownership metadata", () => {
    const fixture = createFixture();
    write(fixture.source, "mex-inbox/SKILL.md", "first\nsecond\nthird\n");
    sync(fixture, ["claude"]);
    const directory = join(fixture.project, ".claude/skills/mex-inbox");
    toCrlf(directory);
    for (const path of ["SKILL.md", MEX_MANAGED_SKILL_METADATA]) {
      const absolute = join(directory, path);
      writeFileSync(absolute, readFileSync(absolute, "utf8").replace("\r\n", "\n"));
    }
    const before = snapshotTree(directory);
    expect(actionFor(sync(fixture, ["claude"]), "mex-inbox").action).toBe("noop");
    expect(snapshotTree(directory)).toEqual(before);
  });

  it.each(["SKILL.md", MEX_MANAGED_SKILL_METADATA])(
    "preserves BOM, trailing-newline and content changes in %s",
    (path) => {
      for (const eol of ["\n", "\r\n"]) {
        for (const edit of [
          (text: string) => "\ufeff" + text,
          (text: string) => text.slice(0, -eol.length),
          (text: string) => text + eol,
          (text: string) => text.replace("inbox", "custom"),
        ]) {
          const fixture = createFixture();
          sync(fixture, ["claude"]);
          const directory = join(fixture.project, ".claude/skills/mex-inbox");
          if (eol === "\r\n") toCrlf(directory);
          const absolute = join(directory, path);
          writeFileSync(absolute, edit(readFileSync(absolute, "utf8")));
          const before = snapshotTree(directory);
          expect(actionFor(sync(fixture, ["claude"]), "mex-inbox").action).toBe("conflict");
          expect(snapshotTree(directory)).toEqual(before);
        }
      }
    },
  );

  it.each([
    Buffer.from([0, 13, 10, 255]),
    Buffer.from([255, 13, 10]),
    Buffer.from([0, 10, 255]),
    Buffer.from([255, 10]),
  ])("keeps binary payloads byte-exact", (bytes) => {
    const fixture = createFixture();
    const path = "mex-inbox/asset.bin";
    writeFileSync(join(fixture.source, path), bytes);
    sync(fixture, ["claude"]);
    const installed = join(fixture.project, ".claude/skills", path);
    expect(readFileSync(installed)).toEqual(bytes);
    writeFileSync(installed, bytes.includes(13)
      ? Buffer.from(bytes.filter((byte) => byte !== 13))
      : Buffer.from([...bytes].flatMap((byte) => byte === 10 ? [13, 10] : [byte])));
    const before = snapshotTree(join(fixture.project, ".claude/skills/mex-inbox"));
    expect(actionFor(sync(fixture, ["claude"]), "mex-inbox").action).toBe("conflict");
    expect(snapshotTree(join(fixture.project, ".claude/skills/mex-inbox"))).toEqual(before);
  });

  it("detects an ending-only change after preview before updating a managed skill", () => {
    const fixture = createFixture();
    sync(fixture, ["claude"]);
    const directory = join(fixture.project, ".claude/skills/mex-inbox");
    toCrlf(directory);
    write(fixture.source, "mex-inbox/SKILL.md", "upstream v2\n");
    const plan = planAgentAssets({ projectRoot: fixture.project, packagedSkillsRoot: fixture.source,
      packageVersion: "2.0.0", clients: ["claude"], checkIgnored: false });
    const skill = join(directory, "SKILL.md");
    writeFileSync(skill, readFileSync(skill, "utf8").replace(/\r\n/gu, "\n"));
    const before = snapshotTree(directory);
    expect(() => applyAgentAssetsPlan(plan)).toThrowError(
      expect.objectContaining({ code: "CONCURRENT_MODIFICATION" }),
    );
    expect(snapshotTree(directory)).toEqual(before);
  });

  it("treats an added empty directory as a managed-copy modification", () => {
    const fixture = createFixture();
    sync(fixture, ["claude"]);
    mkdirSync(join(fixture.project, ".claude/skills/mex-inbox/user-empty"));

    const report = sync(fixture, ["claude"]);

    expect(actionFor(report, "mex-inbox").action).toBe("conflict");
    expect(report.warnings).toContainEqual(expect.objectContaining({
      code: "managed-skill-modified",
      path: ".claude/skills/mex-inbox",
    }));
    expect(exists(fixture.project, ".claude/skills/mex-inbox/user-empty")).toBe(true);
  });

  it("never overwrites an unmanaged same-name path or touches unrelated skills", () => {
    const fixture = createFixture();
    write(fixture.project, ".claude/skills/mex-inbox/custom.txt", "mine\n");
    write(fixture.project, ".claude/skills/my-private-skill/secret.txt", "untouched\n");
    const privateBefore = snapshotTree(join(fixture.project, ".claude/skills/my-private-skill"));

    const report = sync(fixture, ["claude"]);

    expect(actionFor(report, "mex-inbox")).toMatchObject({
      action: "conflict",
      path: ".claude/skills/mex-inbox",
    });
    expect(report.warnings).toContainEqual(expect.objectContaining({
      code: "unmanaged-skill-conflict",
      path: ".claude/skills/mex-inbox",
    }));
    expect(read(fixture.project, ".claude/skills/mex-inbox/custom.txt")).toBe("mine\n");
    expect(snapshotTree(join(fixture.project, ".claude/skills/my-private-skill"))).toEqual(privateBefore);
  });

  it.each([
    ["invalid JSON", "{broken", "malformed-ownership"],
    ["path traversal", JSON.stringify({
      schemaVersion: 1,
      owner: "mex-agent",
      skill: "mex-inbox",
      packageVersion: "0.1.0",
      files: { "SKILL.md": "a".repeat(64), "../outside": "b".repeat(64) },
    }), "malformed-ownership"],
  ])("preserves a managed directory with %s metadata", (_label, metadata, warningCode) => {
    const fixture = createFixture();
    write(fixture.project, ".claude/skills/mex-inbox/SKILL.md", "old\n");
    write(fixture.project, `.claude/skills/mex-inbox/${MEX_MANAGED_SKILL_METADATA}`, metadata);
    const before = snapshotTree(join(fixture.project, ".claude/skills/mex-inbox"));

    const report = sync(fixture, ["claude"]);

    expect(actionFor(report, "mex-inbox").action).toBe("conflict");
    expect(report.warnings).toContainEqual(expect.objectContaining({ code: warningCode }));
    expect(snapshotTree(join(fixture.project, ".claude/skills/mex-inbox"))).toEqual(before);
  });

  it("rejects destination symlinks without reading or changing their targets", () => {
    const fixture = createFixture();
    const outside = temporaryRoot("mex-agent-assets-outside-");
    write(outside, "secret.txt", "outside\n");
    mkdirSync(join(fixture.project, ".claude/skills"), { recursive: true });
    symlinkSync(outside, join(fixture.project, ".claude/skills/mex-inbox"));

    const report = sync(fixture, ["claude"]);

    expect(actionFor(report, "mex-inbox").action).toBe("conflict");
    expect(report.warnings).toContainEqual(expect.objectContaining({
      code: "unsafe-path",
      path: ".claude/skills/mex-inbox",
    }));
    expect(read(outside, "secret.txt")).toBe("outside\n");
    expect(readdirSync(outside)).toEqual(["secret.txt"]);
  });

  it("rejects symlinks in packaged skill trees before planning any writes", () => {
    const fixture = createFixture();
    write(fixture.source, "shared.txt", "shared\n");
    symlinkSync(
      join(fixture.source, "shared.txt"),
      join(fixture.source, "mex-inbox/references/linked.md"),
    );
    const before = snapshotTree(fixture.project);

    expect(() => sync(fixture, ["claude"])).toThrowError(
      expect.objectContaining<Partial<AgentAssetsError>>({ code: "INVALID_PACKAGED_SKILL" }),
    );
    expect(snapshotTree(fixture.project)).toEqual(before);
  });

  it("rolls an unmodified skill back if activation fails after backup", () => {
    const fixture = createFixture();
    sync(fixture, ["claude"]);
    const oldTree = snapshotTree(join(fixture.project, ".claude/skills/mex-inbox"));
    write(fixture.source, "mex-inbox/SKILL.md", "inbox replacement\n");
    const plan = planAgentAssets({
      projectRoot: fixture.project,
      packagedSkillsRoot: fixture.source,
      packageVersion: "2.0.0",
      clients: ["claude"],
      checkIgnored: false,
    });

    expect(() => applyAgentAssetsPlan(plan, {
      hooks: {
        beforeSkillActivation(path) {
          if (path.endsWith("mex-inbox")) throw new Error("injected activation failure");
        },
      },
    })).toThrowError(expect.objectContaining<Partial<AgentAssetsError>>({ code: "APPLY_FAILED" }));

    expect(snapshotTree(join(fixture.project, ".claude/skills/mex-inbox"))).toEqual(oldTree);
    expect(readdirSync(join(fixture.project, ".claude/skills")).filter((name) => name.startsWith("."))).toEqual([]);
  });

  it("revalidates a skill backup and restores concurrent bytes instead of deleting them", () => {
    const fixture = createFixture();
    sync(fixture, ["claude"]);
    write(fixture.source, "mex-inbox/SKILL.md", "inbox replacement\n");
    const plan = planAgentAssets({
      projectRoot: fixture.project,
      packagedSkillsRoot: fixture.source,
      packageVersion: "2.0.0",
      clients: ["claude"],
      checkIgnored: false,
    });

    expect(() => applyAgentAssetsPlan(plan, {
      hooks: {
        beforeSkillActivation(path) {
          if (!path.endsWith("mex-inbox")) return;
          const parent = join(fixture.project, ".claude/skills");
          const backup = readdirSync(parent)
            .find((name) => name.startsWith(".mex-inbox.mex-backup-"));
          expect(backup).toBeDefined();
          writeFileSync(join(parent, backup!, "SKILL.md"), "concurrent backup edit\n");
        },
      },
    })).toThrowError(expect.objectContaining<Partial<AgentAssetsError>>({
      code: "CONCURRENT_MODIFICATION",
    }));

    expect(read(fixture.project, ".claude/skills/mex-inbox/SKILL.md"))
      .toBe("concurrent backup edit\n");
    expect(readdirSync(join(fixture.project, ".claude/skills"))
      .filter((name) => name.startsWith(".mex-inbox.mex-"))).toEqual([]);
  });

  it("reports an active skill replacement and retains an original changed after activation", () => {
    const fixture = createFixture();
    sync(fixture, ["claude"]);
    write(fixture.source, "mex-inbox/SKILL.md", "inbox replacement\n");
    const plan = planAgentAssets({
      projectRoot: fixture.project,
      packagedSkillsRoot: fixture.source,
      packageVersion: "2.0.0",
      clients: ["claude"],
      checkIgnored: false,
    });
    let retainedBackup = "";
    let caught: unknown;

    try {
      applyAgentAssetsPlan(plan, {
        hooks: {
          afterSkillActivation(path, backupPath) {
            if (!path.endsWith("mex-inbox")) return;
            expect(backupPath).not.toBeNull();
            retainedBackup = backupPath!;
            writeFileSync(join(backupPath!, "SKILL.md"), "late original edit\n");
          },
        },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject<Partial<AgentAssetsError>>({
      code: "REPLACEMENT_ACTIVE_BACKUP_RETAINED",
    });
    expect((caught as Error).message).toContain("replacement is active");
    expect((caught as Error).message).toContain(retainedBackup);
    expect(read(fixture.project, ".claude/skills/mex-inbox/SKILL.md"))
      .toBe("inbox replacement\n");
    expect(readFileSync(join(retainedBackup, "SKILL.md"), "utf8")).toBe("late original edit\n");
  });

  it("does not recurse through a staged skill path swapped to a symlink", () => {
    const fixture = createFixture();
    const outside = temporaryRoot("mex-agent-stage-swap-");
    write(outside, "sentinel.txt", "outside stays\n");
    let swappedStage = "";
    let retainedStage = "";
    const plan = planAgentAssets({
      projectRoot: fixture.project,
      packagedSkillsRoot: fixture.source,
      packageVersion: "1.0.0",
      clients: ["claude"],
      checkIgnored: false,
    });

    expect(() => applyAgentAssetsPlan(plan, {
      hooks: {
        beforeSkillActivation(path) {
          if (!path.endsWith("mex-inbox")) return;
          const parent = join(fixture.project, ".claude/skills");
          const stageName = readdirSync(parent)
            .find((name) => name.startsWith(".mex-inbox.mex-stage-"));
          expect(stageName).toBeDefined();
          swappedStage = join(parent, stageName!);
          retainedStage = join(parent, ".mex-inbox.retained-stage");
          renameSync(swappedStage, retainedStage);
          symlinkSync(outside, swappedStage);
        },
      },
    })).toThrowError(expect.objectContaining<Partial<AgentAssetsError>>({
      code: "PATH_IDENTITY_CHANGED",
    }));

    expect(lstatSync(swappedStage).isSymbolicLink()).toBe(true);
    expect(read(outside, "sentinel.txt")).toBe("outside stays\n");
    expect(readdirSync(outside)).toEqual(["sentinel.txt"]);
    expect(existsSync(join(retainedStage, "SKILL.md"))).toBe(true);
    unlinkSync(swappedStage);
  });

  it("does not clean through a swapped skill parent", () => {
    const fixture = createFixture();
    const outside = temporaryRoot("mex-agent-parent-swap-");
    write(outside, "sentinel.txt", "outside stays\n");
    const parent = join(fixture.project, ".claude/skills");
    const retainedParent = join(fixture.project, ".claude/skills-retained");
    const plan = planAgentAssets({
      projectRoot: fixture.project,
      packagedSkillsRoot: fixture.source,
      packageVersion: "1.0.0",
      clients: ["claude"],
      checkIgnored: false,
    });

    expect(() => applyAgentAssetsPlan(plan, {
      hooks: {
        beforeSkillActivation(path) {
          if (!path.endsWith("mex-inbox")) return;
          renameSync(parent, retainedParent);
          symlinkSync(outside, parent);
        },
      },
    })).toThrowError(expect.objectContaining<Partial<AgentAssetsError>>({
      code: "PATH_IDENTITY_CHANGED",
    }));

    expect(read(outside, "sentinel.txt")).toBe("outside stays\n");
    expect(readdirSync(outside)).toEqual(["sentinel.txt"]);
    unlinkSync(parent);
    renameSync(retainedParent, parent);
  });

  it("stops when the project-root pathname is swapped after staging", () => {
    const fixture = createFixture();
    const retainedRoot = `${fixture.project}-retained`;
    const plan = planAgentAssets({
      projectRoot: fixture.project,
      packagedSkillsRoot: fixture.source,
      packageVersion: "1.0.0",
      clients: ["claude"],
      checkIgnored: false,
    });

    expect(() => applyAgentAssetsPlan(plan, {
      hooks: {
        beforeSkillActivation(path) {
          if (!path.endsWith("mex-inbox")) return;
          renameSync(fixture.project, retainedRoot);
          mkdirSync(fixture.project);
          write(fixture.project, "replacement-root.txt", "do not touch\n");
        },
      },
    })).toThrowError(expect.objectContaining<Partial<AgentAssetsError>>({
      code: "PATH_IDENTITY_CHANGED",
    }));

    expect(read(fixture.project, "replacement-root.txt")).toBe("do not touch\n");
    expect(readdirSync(fixture.project)).toEqual(["replacement-root.txt"]);
    rmSync(fixture.project, { recursive: true, force: true });
    renameSync(retainedRoot, fixture.project);
  });

  it("preserves a skill destination that appears during missing-destination activation", () => {
    const fixture = createFixture();
    const plan = planAgentAssets({
      projectRoot: fixture.project,
      packagedSkillsRoot: fixture.source,
      packageVersion: "1.0.0",
      clients: ["claude"],
      checkIgnored: false,
    });

    expect(() => applyAgentAssetsPlan(plan, {
      hooks: {
        beforeSkillActivation(path) {
          if (path.endsWith("mex-inbox")) {
            mkdirSync(join(fixture.project, ".claude/skills/mex-inbox"));
          }
        },
      },
    })).toThrowError(expect.objectContaining<Partial<AgentAssetsError>>({
      code: "CONCURRENT_MODIFICATION",
    }));

    expect(exists(fixture.project, ".claude/skills/mex-inbox")).toBe(true);
    expect(readdirSync(join(fixture.project, ".claude/skills/mex-inbox"))).toEqual([]);
    expect(readdirSync(join(fixture.project, ".claude/skills"))
      .filter((name) => name.startsWith(".mex-inbox.mex-"))).toEqual([]);
  });

  it("retains the original backup if a concurrent target prevents skill rollback", () => {
    const fixture = createFixture();
    sync(fixture, ["claude"]);
    const oldTree = snapshotTree(join(fixture.project, ".claude/skills/mex-inbox"));
    write(fixture.source, "mex-inbox/SKILL.md", "inbox replacement\n");
    const plan = planAgentAssets({
      projectRoot: fixture.project,
      packagedSkillsRoot: fixture.source,
      packageVersion: "2.0.0",
      clients: ["claude"],
      checkIgnored: false,
    });

    expect(() => applyAgentAssetsPlan(plan, {
      hooks: {
        beforeSkillActivation(path) {
          if (!path.endsWith("mex-inbox")) return;
          write(fixture.project, ".claude/skills/mex-inbox/concurrent.txt", "do not replace\n");
          throw new Error("injected activation failure");
        },
      },
    })).toThrowError(/failed to restore its backup/u);

    expect(read(fixture.project, ".claude/skills/mex-inbox/concurrent.txt")).toBe("do not replace\n");
    const backup = readdirSync(join(fixture.project, ".claude/skills"))
      .find((name) => name.startsWith(".mex-inbox.mex-backup-"));
    expect(backup).toBeDefined();
    expect(snapshotTree(join(fixture.project, ".claude/skills", backup!))).toEqual(oldTree);
  });

  it("rejects applying a dry-run/serialized plan and detects changes after preview", () => {
    const dryFixture = createFixture();
    const dryPlan = planAgentAssets({
      projectRoot: dryFixture.project,
      packagedSkillsRoot: dryFixture.source,
      packageVersion: "1.0.0",
      clients: ["claude"],
      dryRun: true,
      checkIgnored: false,
    });
    expect(() => applyAgentAssetsPlan(dryPlan)).toThrowError(
      expect.objectContaining<Partial<AgentAssetsError>>({ code: "DRY_RUN_PLAN" }),
    );
    expect(() => applyAgentAssetsPlan(JSON.parse(JSON.stringify(dryPlan)))).toThrowError(
      expect.objectContaining<Partial<AgentAssetsError>>({ code: "UNKNOWN_PLAN" }),
    );

    const fixture = createFixture();
    const plan = planAgentAssets({
      projectRoot: fixture.project,
      packagedSkillsRoot: fixture.source,
      packageVersion: "1.0.0",
      clients: ["claude"],
      checkIgnored: false,
    });
    write(fixture.project, ".claude/skills/mex-inbox/user-race.txt", "appeared\n");
    expect(() => applyAgentAssetsPlan(plan)).toThrowError(
      expect.objectContaining<Partial<AgentAssetsError>>({ code: "CONCURRENT_MODIFICATION" }),
    );
    expect(read(fixture.project, ".claude/skills/mex-inbox/user-race.txt")).toBe("appeared\n");
  });

  it("detects ignored skill destinations through read-only git check-ignore", () => {
    const fixture = createFixture();
    execFileSync("git", ["init", "-q"], { cwd: fixture.project });
    write(fixture.project, ".gitignore", ".claude/\n");
    write(fixture.project, ".claude/settings.local.json", "{}\n");
    write(fixture.project, ".claude/skills/private-skill/SKILL.md", "private\n");
    const beforeIgnore = read(fixture.project, ".gitignore");

    const plan = planAgentAssets({
      projectRoot: fixture.project,
      packagedSkillsRoot: fixture.source,
      packageVersion: "1.0.0",
      clients: ["claude"],
      dryRun: true,
    });

    expect(plan.warnings.filter((warning) => warning.code === "ignored-skill-path"))
      .toEqual([
        expect.objectContaining({ path: ".claude/skills/mex-inbox/SKILL.md" }),
        expect.objectContaining({ path: ".claude/skills/mex-relay/SKILL.md" }),
        expect.objectContaining({ path: ".claude/skills/mex-statechart/SKILL.md" }),
      ]);
    expect(read(fixture.project, ".gitignore")).toBe(beforeIgnore);
    const resolution = plan.warnings.find((warning) => warning.skill === "mex-inbox")!.resolution!;
    expect(resolution).toContain("!/.claude/");
    expect(resolution).toContain("/.claude/*");
    expect(resolution).toContain("!/.claude/skills/");
    expect(resolution).toContain("/.claude/skills/*");
    expect(resolution).toContain("!/.claude/skills/mex-inbox/**");
    expect(resolution).toContain("!/.claude/skills/mex-relay/**");
    expect(resolution).toContain("do not unignore unrelated .claude files");
    expect(plan.warnings.find((warning) => warning.skill === "mex-relay")!.resolution)
      .toBe(resolution);

    const emittedRules = resolution.split("\n")
      .filter((line) => line.startsWith("!/") || line.startsWith("/"));
    write(fixture.project, ".gitignore", [
      ".claude/",
      ...emittedRules,
      "",
    ].join("\n"));
    const afterNarrowRules = planAgentAssets({
      projectRoot: fixture.project,
      packagedSkillsRoot: fixture.source,
      packageVersion: "1.0.0",
      clients: ["claude"],
      dryRun: true,
    });
    expect(afterNarrowRules.warnings).not.toContainEqual(expect.objectContaining({
      code: "ignored-skill-path",
    }));
    expect(gitIgnored(fixture.project, ".claude/skills/mex-inbox/SKILL.md")).toBe(false);
    expect(gitIgnored(fixture.project, ".claude/skills/mex-relay/SKILL.md")).toBe(false);
    expect(gitIgnored(fixture.project, ".claude/settings.local.json")).toBe(true);
    expect(gitIgnored(fixture.project, ".claude/skills/private-skill/SKILL.md")).toBe(true);
  });

  it("checks desired files so content-only ignore rules report the exact ignored path", () => {
    const fixture = createFixture();
    execFileSync("git", ["init", "-q"], { cwd: fixture.project });
    write(fixture.project, ".gitignore", ".claude/skills/mex-inbox/**\n");

    const plan = planAgentAssets({
      projectRoot: fixture.project,
      packagedSkillsRoot: fixture.source,
      packageVersion: "1.0.0",
      clients: ["claude"],
      dryRun: true,
    });

    expect(plan.warnings).toContainEqual(expect.objectContaining({
      code: "ignored-skill-path",
      skill: "mex-inbox",
      path: ".claude/skills/mex-inbox/SKILL.md",
    }));
    expect(plan.warnings).not.toContainEqual(expect.objectContaining({
      code: "ignored-skill-path",
      skill: "mex-relay",
    }));
  });

  it("surfaces an ignore-check failure instead of assuming skill paths are visible", () => {
    const fixture = createFixture();
    const before = snapshotTree(fixture.project);
    const plan = planAgentAssets({
      projectRoot: fixture.project,
      packagedSkillsRoot: fixture.source,
      packageVersion: "1.0.0",
      clients: ["claude"],
      dryRun: true,
      ignoreChecker() {
        throw new Error("git probe unavailable\nwith extra output");
      },
    });

    expect(plan.warnings.filter((warning) => warning.code === "ignore-check-failed"))
      .toEqual([
        expect.objectContaining({
          skill: "mex-inbox",
          path: ".claude/skills/mex-inbox",
          message: expect.stringContaining("git probe unavailable with extra output"),
          resolution: expect.stringContaining("git check-ignore --no-index"),
        }),
        expect.objectContaining({
          skill: "mex-relay",
          path: ".claude/skills/mex-relay",
        }),
        expect.objectContaining({ skill: "mex-statechart", path: ".claude/skills/mex-statechart" }),
      ]);
    expect(snapshotTree(fixture.project)).toEqual(before);
  });

  it("treats git check-ignore exit statuses other than one as probe failures", () => {
    const fixture = createFixture();
    write(fixture.project, ".git", "gitdir: /path/that/does/not/exist\n");

    expect(() => defaultAgentSkillIgnoreChecker(
      fixture.project,
      ".claude/skills/mex-inbox/SKILL.md",
    )).toThrowError(expect.objectContaining<Partial<AgentAssetsError>>({
      code: "IGNORE_CHECK_FAILED",
    }));

    const plan = planAgentAssets({
      projectRoot: fixture.project,
      packagedSkillsRoot: fixture.source,
      packageVersion: "1.0.0",
      clients: ["claude"],
      dryRun: true,
    });
    expect(plan.warnings.filter((warning) => warning.code === "ignore-check-failed"))
      .toHaveLength(3);
  });

  it("creates and updates instruction files without changing user-owned bytes", () => {
    const fixture = createFixture();
    const claudePrefix = Buffer.from("\ufeff# Claude user rules\r\nDo not alter.\r\n", "utf8");
    const codexPrefix = Buffer.from("# Codex user rules\nDo not alter.\n", "utf8");
    writeFileSync(join(fixture.project, "CLAUDE.md"), claudePrefix);
    writeFileSync(join(fixture.project, "AGENTS.md"), codexPrefix);

    sync(fixture, ["claude", "codex"]);

    const claude = readFileSync(join(fixture.project, "CLAUDE.md"));
    const codex = readFileSync(join(fixture.project, "AGENTS.md"));
    expect(claude.subarray(0, claudePrefix.length)).toEqual(claudePrefix);
    expect(codex.subarray(0, codexPrefix.length)).toEqual(codexPrefix);
    expect(claude.toString("utf8")).toContain("`/mex-inbox`");
    expect(claude.toString("utf8")).not.toContain("$mex-");
    expect(codex.toString("utf8")).toContain("`$mex-inbox`");
    expect(codex.toString("utf8")).not.toContain("/mex-");
  });

  it("migrates exact legacy instructions but preserves one-byte modifications", () => {
    const fixture = createFixture();
    const legacy = Buffer.from("exact generated legacy\n", "utf8");
    const hash = createHash("sha256").update(legacy).digest("hex");
    writeFileSync(join(fixture.project, "CLAUDE.md"), legacy);
    writeFileSync(join(fixture.project, "AGENTS.md"), Buffer.concat([legacy, Buffer.from("x")]));

    const report = syncAgentAssets({
      projectRoot: fixture.project,
      packagedSkillsRoot: fixture.source,
      packageVersion: "1.0.0",
      clients: ["claude", "codex"],
      checkIgnored: false,
      legacyInstructionHashes: { claude: [hash], codex: [hash] },
    });

    expect(instructionAction(report, "claude").action).toBe("migrate");
    expect(read(fixture.project, "CLAUDE.md")).toMatch(/^<!-- mex-agent:skills:start -->/u);
    expect(read(fixture.project, "CLAUDE.md")).not.toContain("generated legacy");
    expect(instructionAction(report, "codex").action).toBe("update");
    expect(readFileSync(join(fixture.project, "AGENTS.md")).subarray(0, legacy.length + 1))
      .toEqual(Buffer.concat([legacy, Buffer.from("x")]));
  });

  it("fails closed and preserves instructions with malformed markers", () => {
    const fixture = createFixture();
    const malformed = "before\n<!-- mex-agent:skills:start -->\none\n<!-- mex-agent:skills:start -->\ntwo\n<!-- mex-agent:skills:end -->\n";
    write(fixture.project, "CLAUDE.md", malformed);

    const report = sync(fixture, ["claude"]);

    expect(instructionAction(report, "claude").action).toBe("conflict");
    expect(report.warnings).toContainEqual(expect.objectContaining({
      code: "malformed-instruction-markers",
      path: "CLAUDE.md",
    }));
    expect(read(fixture.project, "CLAUDE.md")).toBe(malformed);
  });

  it("rolls instruction replacement back portably and preserves its mode", () => {
    const fixture = createFixture();
    sync(fixture, ["claude"]);
    const path = join(fixture.project, "CLAUDE.md");
    const old = readFileSync(path);
    chmodSync(path, 0o640);
    writeFileSync(
      path,
      Buffer.from(old.toString("utf8").replace("## MEX agent skills", "## stale MEX policy")),
    );
    const plan = planAgentAssets({
      projectRoot: fixture.project,
      packagedSkillsRoot: fixture.source,
      packageVersion: "1.0.0",
      clients: ["claude"],
      checkIgnored: false,
    });
    const before = readFileSync(path);

    expect(() => applyAgentAssetsPlan(plan, {
      hooks: { beforeInstructionActivation: () => { throw new Error("injected"); } },
    })).toThrowError(expect.objectContaining<Partial<AgentAssetsError>>({ code: "APPLY_FAILED" }));

    expect(readFileSync(path)).toEqual(before);
    expect(statSync(path).mode & 0o777).toBe(0o640);
    expect(readdirSync(fixture.project).filter((name) => name.includes("CLAUDE.md.mex-"))).toEqual([]);
  });

  it("reports an active instruction replacement and retains a late-changed original", () => {
    const fixture = createFixture();
    sync(fixture, ["claude"]);
    const instructionPath = join(fixture.project, "CLAUDE.md");
    writeFileSync(
      instructionPath,
      readFileSync(instructionPath, "utf8")
        .replace("## MEX agent skills", "## stale MEX agent skills"),
      "utf8",
    );
    const plan = planAgentAssets({
      projectRoot: fixture.project,
      packagedSkillsRoot: fixture.source,
      packageVersion: "1.0.0",
      clients: ["claude"],
      checkIgnored: false,
    });
    let retainedBackup = "";
    let caught: unknown;

    try {
      applyAgentAssetsPlan(plan, {
        hooks: {
          afterInstructionActivation(path, backupPath) {
            expect(path).toBe("CLAUDE.md");
            expect(backupPath).not.toBeNull();
            retainedBackup = backupPath!;
            writeFileSync(backupPath!, "late original instruction edit\n", "utf8");
          },
        },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject<Partial<AgentAssetsError>>({
      code: "REPLACEMENT_ACTIVE_BACKUP_RETAINED",
    });
    expect((caught as Error).message).toContain("replacement is active");
    expect((caught as Error).message).toContain(retainedBackup);
    expect(read(fixture.project, "CLAUDE.md")).toContain("## MEX agent skills");
    expect(read(fixture.project, "CLAUDE.md")).not.toContain("stale MEX agent skills");
    expect(readFileSync(retainedBackup, "utf8")).toBe("late original instruction edit\n");
  });

  it("uses no-clobber activation when an absent instruction file appears", () => {
    const fixture = createFixture();
    sync(fixture, ["claude"]);
    rmSync(join(fixture.project, "CLAUDE.md"));
    const plan = planAgentAssets({
      projectRoot: fixture.project,
      packagedSkillsRoot: fixture.source,
      packageVersion: "1.0.0",
      clients: ["claude"],
      checkIgnored: false,
    });

    expect(() => applyAgentAssetsPlan(plan, {
      hooks: {
        beforeInstructionActivation(path) {
          expect(path).toBe("CLAUDE.md");
          write(fixture.project, path, "concurrent user instructions\n");
        },
      },
    })).toThrowError(expect.objectContaining<Partial<AgentAssetsError>>({
      code: "CONCURRENT_MODIFICATION",
    }));

    expect(read(fixture.project, "CLAUDE.md")).toBe("concurrent user instructions\n");
    expect(readdirSync(fixture.project).filter((name) => name.includes("CLAUDE.md.mex-"))).toEqual([]);
  });

  it("revalidates existing instructions immediately before activation", () => {
    const fixture = createFixture();
    sync(fixture, ["claude"]);
    const path = join(fixture.project, "CLAUDE.md");
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace("## MEX agent skills", "## old managed policy"),
      "utf8",
    );
    const plan = planAgentAssets({
      projectRoot: fixture.project,
      packagedSkillsRoot: fixture.source,
      packageVersion: "1.0.0",
      clients: ["claude"],
      checkIgnored: false,
    });

    expect(() => applyAgentAssetsPlan(plan, {
      hooks: {
        beforeInstructionActivation(relativePath) {
          write(fixture.project, relativePath, "concurrent replacement\n");
        },
      },
    })).toThrow();

    expect(read(fixture.project, "CLAUDE.md")).toBe("concurrent replacement\n");
    const backup = readdirSync(fixture.project)
      .find((name) => name.startsWith(".CLAUDE.md.mex-backup-"));
    expect(backup).toBeDefined();
    expect(readFileSync(join(fixture.project, backup!), "utf8"))
      .toContain("## old managed policy");
  });

  it("detects an instruction mode change after preview", () => {
    const fixture = createFixture();
    sync(fixture, ["claude"]);
    const path = join(fixture.project, "CLAUDE.md");
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace("## MEX agent skills", "## old managed policy"),
      "utf8",
    );
    chmodSync(path, 0o640);
    const plan = planAgentAssets({
      projectRoot: fixture.project,
      packagedSkillsRoot: fixture.source,
      packageVersion: "1.0.0",
      clients: ["claude"],
      checkIgnored: false,
    });
    chmodSync(path, 0o600);

    expect(() => applyAgentAssetsPlan(plan)).toThrowError(
      expect.objectContaining<Partial<AgentAssetsError>>({ code: "CONCURRENT_MODIFICATION" }),
    );
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("keeps every reported path portable", () => {
    const fixture = createFixture();
    const report = sync(fixture, ["claude", "codex"]);
    expect([...report.actions, ...report.warnings].every((item) => !item.path.includes("\\")))
      .toBe(true);
  });
});

interface Fixture {
  project: string;
  source: string;
}

function createFixture(): Fixture {
  const project = temporaryRoot("mex-agent-assets-project-");
  const source = temporaryRoot("mex-agent-assets-source-");
  write(source, "mex-statechart/SKILL.md", "statechart v1\n");
  write(source, "mex-statechart/scripts/runtime.mjs", "export const runtime = true;\n");
  write(source, "mex-inbox/SKILL.md", "inbox v1\n");
  write(source, "mex-inbox/references/workflow.md", "inbox reference\n");
  write(source, "mex-relay/SKILL.md", "relay v1\n");
  write(source, "mex-relay/references/workflow.md", "relay reference\n");
  write(source, "mex-relay/scripts/resolve.mjs", "export const resolve = true;\n");
  chmodSync(join(source, "mex-relay/scripts/resolve.mjs"), 0o755);
  return { project, source };
}

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function sync(fixture: Fixture, clients: readonly AgentSkillClient[]): AgentAssetsReport {
  return syncAgentAssets({
    projectRoot: fixture.project,
    packagedSkillsRoot: fixture.source,
    packageVersion: "1.0.0",
    clients,
    checkIgnored: false,
  });
}

function write(root: string, path: string, content: string): void {
  const absolute = join(root, ...path.split("/"));
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content, "utf8");
}

function read(root: string, path: string): string {
  return readFileSync(join(root, ...path.split("/")), "utf8");
}

function exists(root: string, path: string): boolean {
  return existsSync(join(root, ...path.split("/")));
}

function readMetadata(root: string, skillPath: string): MexManagedSkillMetadata {
  return JSON.parse(read(root, `${skillPath}/${MEX_MANAGED_SKILL_METADATA}`)) as MexManagedSkillMetadata;
}

function expectInstalledBytes(fixture: Fixture, skill: OfficialMexSkill, installedPath: string): void {
  const source = snapshotTree(join(fixture.source, skill));
  const installed = snapshotTree(join(fixture.project, ...installedPath.split("/")));
  delete installed[MEX_MANAGED_SKILL_METADATA];
  expect(installed).toEqual(source);
}

function snapshotTree(root: string): Record<string, string> {
  if (!existsSync(root)) return {};
  const output: Record<string, string> = {};
  walk(root, root, output);
  return output;
}

function walk(root: string, directory: string, output: Record<string, string>): void {
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = join(directory, entry.name);
    const path = relative(root, absolute).split("\\").join("/");
    const entryStat = lstatSync(absolute);
    if (entryStat.isSymbolicLink()) {
      output[path] = "symlink";
    } else if (entryStat.isDirectory()) {
      walk(root, absolute, output);
    } else {
      output[path] = createHash("sha256").update(readFileSync(absolute)).digest("hex");
    }
  }
}

function actionFor(report: AgentAssetsReport, skill: OfficialMexSkill) {
  const action = report.actions.find((item) => item.kind === "skill" && item.skill === skill);
  expect(action).toBeDefined();
  return action!;
}

function instructionAction(report: AgentAssetsReport, client: AgentSkillClient) {
  const action = report.actions.find((item) => item.kind === "instructions" && item.client === client);
  expect(action).toBeDefined();
  return action!;
}

function gitIgnored(projectRoot: string, path: string): boolean {
  return spawnSync(
    "git",
    ["check-ignore", "--no-index", "-q", "--", path],
    { cwd: projectRoot, stdio: "ignore" },
  ).status === 0;
}

/** Rewrite every file under the directory as a CRLF Git checkout would. */
function toCrlf(directory: string): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) toCrlf(path);
    else writeFileSync(path, readFileSync(path, "utf8").replace(/\r?\n/gu, "\r\n"));
  }
}
