import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { buildIndex } from "../../file-index/build.js";
import { openRecord } from "../../record/index.js";
import { setLearningTrial } from "../../learn-deeper/trial-settings.js";
import { serializeEntry } from "../entry.js";
import { rebuildNative } from "../native.js";
import { entry } from "./fixtures.js";

// Every check holds here; this file is about where learned rules are written.
vi.mock("../check.js", async original => ({
  ...await original<typeof import("../check.js")>(),
  currentVerdicts: () => new Map([["team/mx_deepwide1", "held"]]),
}));

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function fixture(scope = "**") {
  const base = mkdtempSync(join(tmpdir(), "mex-always-on-")), root = join(base, "repo"), home = join(base, "home");
  dirs.push(base);
  execFileSync("git", ["init", "-q", root]);
  mkdirSync(join(root, ".claude"));
  mkdirSync(join(root, ".mex", "learned"), { recursive: true });
  writeFileSync(join(root, "CONTRIBUTING.md"), "Always use the stable branch for release fixes.\n");
  const human = entry("mx_team01", { source: { type: "docs", ref: "CONTRIBUTING.md" }, evidence: "docs" }, "Releases go through the release workflow, because tags trigger publishing.");
  const learned = entry("mx_deepwide1", {
    scope: [scope],
    source: { type: "docs", ref: "CONTRIBUTING.md", producer: "learn-deeper" }, evidence: "docs",
    checks: [{ kind: "quote", role: "complete", files: {}, saw: { hash: `sha256:${"0".repeat(64)}` },
      target: { file: "CONTRIBUTING.md", exact: "Always use the stable branch for release fixes.", prefix: "", suffix: "" } }],
  }, "Open release fixes against the stable branch.");
  writeFileSync(join(root, ".mex", "learned", "mx_team01.md"), serializeEntry(human));
  writeFileSync(join(root, ".mex", "learned", "mx_deepwide1.md"), serializeEntry(learned));
  const options = { projectPath: root, home, isNetwork: () => false };
  openRecord(options).close();
  const read = (name: string) => existsSync(join(root, name)) ? readFileSync(join(root, name), "utf8") : "";
  return { root, options, read };
}

describe("learning.alwaysOn", () => {
  it("is off by default: learned repo-wide rules stay out of rule files", () => {
    const f = fixture();
    rebuildNative(f.options, { force: true });
    expect(f.read(".claude/rules/mex.md")).toContain("<!-- mex:mx_team01 -->");
    expect(f.read(".claude/rules/mex.md")).not.toContain("mx_deepwide1");
    expect(f.read(".claude/rules/mex-local.md")).not.toContain("mx_deepwide1");
  });

  it("when turned on, loads them from the person's local files and never the shared ones", () => {
    const f = fixture();
    const writer = openRecord(f.options);
    try { setLearningTrial(writer, "learning.alwaysOn", "on", f.root); } finally { writer.close(); }
    rebuildNative(f.options, { force: true });
    expect(f.read(".claude/rules/mex-local.md")).toContain("<!-- mex:mx_deepwide1 -->");
    expect(f.read(".claude/rules/mex.md")).toContain("<!-- mex:mx_team01 -->");
    expect(f.read(".claude/rules/mex.md")).not.toContain("mx_deepwide1");
    rebuildNative(f.options, { sharedOnly: true });
    expect(f.read(".claude/rules/mex.md")).not.toContain("mx_deepwide1");

    const again = openRecord(f.options);
    try { setLearningTrial(again, "learning.alwaysOn", "off", f.root); } finally { again.close(); }
    rebuildNative(f.options, { force: true });
    expect(f.read(".claude/rules/mex-local.md")).not.toContain("mx_deepwide1");
  });
});

it("writes a broad Go rule only to the person's root rule file when enabled", async () => {
  const f = fixture("**/*.go");
  for (let i = 0; i < 6; i++) writeFileSync(join(f.root, `source${i}.go`), "package main\n");
  for (let i = 0; i < 14; i++) writeFileSync(join(f.root, `client${i}.ts`), "export const client = 1;\n");
  const writer = openRecord(f.options);
  try {
    await buildIndex({ root: f.root, projectId: writer.checkout(f.root)!.project_id, recordDirectory: writer.location.directory, workers: 0 });
    const off = rebuildNative(f.options, { force: true, agents: ["claude-code"] });
    expect(off.selected).toBe(1);
    expect(f.read(".claude/rules/mex-local.md")).not.toContain("mx_deepwide1");
    setLearningTrial(writer, "learning.alwaysOn", "on", f.root);
    const on = rebuildNative(f.options, { force: true, agents: ["claude-code"] });
    expect(on.selected).toBe(2);
    expect(f.read(".claude/rules/mex-local.md")).toContain("Open release fixes against the stable branch. <!-- mex:mx_deepwide1 -->");
    expect(f.read(".claude/rules/mex-local.md")).not.toContain("paths:");
    expect(f.read(".claude/rules/mex.md")).not.toContain("mx_deepwide1");
    setLearningTrial(writer, "learning.alwaysOn", "off", f.root);
    rebuildNative(f.options, { force: true, agents: ["claude-code"] });
    expect(f.read(".claude/rules/mex-local.md")).not.toContain("mx_deepwide1");
  } finally { writer.close(); }
});
