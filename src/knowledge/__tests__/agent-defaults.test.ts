import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { additionalUninstallPaths, uninstallAgents } from "../../install/index.js";
import { openRecord } from "../../record/index.js";
import { setCheckoutEnabled } from "../../controls/index.js";
import { DEFAULTS_REPORT, DEFAULTS_SETTING, defaultRuleTexts, defaultsScope, selectAgentDefaults } from "../agent-defaults.js";
import { serializeEntry } from "../entry.js";
import { changeNativeFile } from "../native-journal.js";
import { rebuildNative } from "../native.js";
import { planNative } from "../native-plan.js";
import { CAPS, renderNative } from "../native-render.js";
import { writeNative } from "../native-write.js";
import { scanRuleFiles } from "../rule-files.js";
import { entry } from "./fixtures.js";

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "mex-defaults-")), root = join(base, "repo"), home = join(base, "home");
  execFileSync("git", ["init", "-q", root]);
  const options = { projectPath: root, home, isNetwork: () => false };
  const writer = openRecord(options);
  const checkout = writer.checkout(root)!;
  writer.close();
  function put(name: string, text: string | Buffer) {
    const file = join(root, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  const get = (name: string) => readFileSync(join(root, name));
  return { root, home, options, checkout, put, get };
}

describe("agent defaults", () => {
  it.each([
    { agent: "claude-code", path: ".claude/rules/mex-local.md", own: "CLAUDE.md", header: "<!-- mex:generated" },
    { agent: "codex", path: "AGENTS.md", own: "README.md", header: "<!-- mex:generated" },
    { agent: "copilot", path: ".github/instructions/mex-local.instructions.md", own: ".github/copilot-instructions.md", header: "---\napplyTo: \"**\"" },
  ] as const)("writes once in the $agent format and rebuilds without churn", ({ agent, path, own, header }) => {
    const f = fixture();
    f.put(own, "# Instructions\r\nUse the staging branch for release candidates.\r\n");
    const before = f.get(own);
    const run = () => rebuildNative(f.options, { agents: [agent], setupDefaults: {} });
    expect(run().written).toEqual([path]);
    const output = f.get(path).toString();
    expect(output.startsWith(header)).toBe(true);
    expect(output.match(/## MEX defaults/gu)).toHaveLength(1);
    expect(output).toContain("Follow the repository's own instructions where they differ.");
    expect(output.match(/^- /gmu)).toHaveLength(15);
    expect(f.get(own)).toEqual(before);
    const mtime = statSync(join(f.root, path)).mtimeMs;
    expect(run().unchanged).toEqual([path]);
    expect(statSync(join(f.root, path)).mtimeMs).toBe(mtime);
    expect(scanRuleFiles(f.root, "2026-11-24", [path]).entries).toEqual([]);
  });

  it("filters conflicts, repeats and ambiguous rules using repository instructions and contributor docs", () => {
    const f = fixture();
    f.put("AGENTS.md", "# Local rules\n\n- Never weaken existing assertions.\n- Write full docstrings for every function.\n");
    f.put("docs/internals/contributing/writing.rst", "Always add a changelog entry.\n\nUpdate snapshots with -u.\n\nPlease log the cache key in review builds.\n");
    f.put(".git/info/exclude", "/.claude/\n");
    f.put(".claude/rules/rules.md", "# Style\n\nKeep unrelated refactors out of your patch.\n");
    f.put(".kiro/steering/project.md", "# Project\n\nNever add options unless requested.\n");
    f.put(".cursor/rules/project.mdc", "Use the repository formatter.\n");
    f.put("GEMINI.md", "# Local instructions\n");
    f.put(".agent/rules/notes.md", "Use the example project for manual checks.\n");
    f.put("README.md", "# Product reference\n\nAlways remove dead code.\n");
    const { report, rules } = selectAgentDefaults(f.root);
    expect(report.omitted).toEqual(expect.arrayContaining([
      { id: "scope", reason: "repeat", path: ".claude/rules/rules.md" },
      { id: "additions", reason: "repeat", path: ".kiro/steering/project.md" },
      { id: "conventions", reason: "repeat", path: ".cursor/rules/project.mdc" },
      { id: "comments", reason: "conflict", path: "AGENTS.md" },
      { id: "assertions", reason: "conflict", path: "docs/internals/contributing/writing.rst" },
      { id: "changelog", reason: "conflict", path: "docs/internals/contributing/writing.rst" },
    ]));
    expect(rules.some(rule => rule.id === "unused")).toBe(true);
    expect(defaultRuleTexts(report)).toEqual(rules.map(rule => rule.text));
    expect(defaultRuleTexts({ ...report, enabled: false })).toEqual([]);
    expect(defaultRuleTexts(undefined)).toEqual([]);
    expect(report.unavailable).toEqual(["Cursor", "Gemini CLI", "Kiro", "Antigravity"]);
    const result = rebuildNative(f.options, { setupDefaults: {} });
    const reader = openRecord(f.options);
    try {
      expect(JSON.parse(reader.setting(defaultsScope(f.checkout.path), DEFAULTS_REPORT)!)).toEqual(result.defaults);
    } finally { reader.close(); }
  });

  it("holds defaults behind every selected rule even when there is no space", () => {
    const pack = selectAgentDefaults(fixture().root).rules;
    const candidates = Array.from({ length: 20 }, (_, index) => ({
      level: "personal" as const,
      entry: entry("mx_note" + String(index).padStart(2, "0"), {}, "é".repeat(287) + " note."),
    }));
    const plain = renderNative("codex-agents", "", candidates);
    const enabled = renderNative("codex-agents", "", candidates, false, pack);
    expect(enabled.defaultCount).toBeLessThan(15);
    expect(enabled.ids).toEqual(plain.ids);
    expect(enabled.dropped).toEqual(plain.dropped);
    expect(enabled.text.startsWith(plain.text)).toBe(true);
    expect(Buffer.byteLength(enabled.text)).toBeLessThanOrEqual(CAPS["codex-agents"]);
  });

  it("uses an active MEX-owned shared AGENTS.md and removes only its defaults when switched off", () => {
    const f = fixture();
    f.put(".mex/learned/mx_team04.md", serializeEntry(entry("mx_team04", {}, "Prefer the release lane for signed builds.")));
    expect(rebuildNative(f.options, { agents: ["codex"] }).written).toEqual(["AGENTS.md"]);
    const baseline = f.get("AGENTS.md");
    expect(rebuildNative(f.options, { setupDefaults: {}, agents: ["claude-code", "codex", "copilot"] }).written).toEqual(["AGENTS.md"]);
    expect(f.get("AGENTS.md").toString().startsWith(baseline.toString())).toBe(true);
    expect(f.get("AGENTS.md").toString()).toContain("## MEX defaults");
    const writer = openRecord(f.options);
    try { setCheckoutEnabled(writer, f.root, false); } finally { writer.close(); }
    expect(rebuildNative(f.options).written).toEqual(["AGENTS.md"]);
    expect(f.get("AGENTS.md")).toEqual(baseline);
  });

  it("removes the block when disabled or switched off and restores it on re-enable", () => {
    const f = fixture();
    f.put("CLAUDE.md", "# Our rules\n");
    const path = ".claude/rules/mex-local.md";
    const rebuild = () => rebuildNative(f.options, { setupDefaults: {} });
    expect(rebuild().written).toEqual([path]);
    const bytes = f.get(path), writer = openRecord(f.options);
    try {
      writer.db.prepare("INSERT INTO settings VALUES(?,?,?)").run(f.checkout.project_id, DEFAULTS_SETTING, "off");
      expect(rebuild().removed).toEqual([path]);
      writer.db.prepare("DELETE FROM settings WHERE key=?").run(DEFAULTS_SETTING);
      expect(rebuild().written).toEqual([path]);
      setCheckoutEnabled(writer, f.root, false);
      expect(rebuild().removed).toEqual([path]);
      setCheckoutEnabled(writer, f.root, true);
      expect(rebuild().written).toEqual([path]);
      expect(f.get(path)).toEqual(bytes);
    } finally { writer.close(); }
  });

  it("uninstalls journaled local and shared files, keeping the checkout bytes", async () => {
    const f = fixture();
    const authored = Buffer.from("\ufeff# Repo instructions\r\nUse the release branch.\r\n");
    const ignore = Buffer.from([35, 32, 0xff, 13, 10, 42, 46, 108, 111, 103]);
    f.put("CLAUDE.md", authored);
    f.put(".git/info/exclude", ignore);
    const teamRule = ".mex/learned/mx_team01.md";
    f.put(teamRule, serializeEntry(entry("mx_team01", {}, "A release starts on the release branch.")));
    const teamBytes = f.get(teamRule);
    expect(rebuildNative(f.options, { setupDefaults: {} }).written).toEqual([".claude/rules/mex.md", ".claude/rules/mex-local.md"]);
    f.put(teamRule, serializeEntry(entry("mx_team01", {}, "A release starts with a signed tag on the release branch.")));
    expect(rebuildNative(f.options).written).toEqual([".claude/rules/mex.md"]);
    const paths = additionalUninstallPaths({ home: f.home });
    expect(paths.some(path => path.endsWith("mex.md"))).toBe(true);
    expect(paths.some(path => path.endsWith("exclude"))).toBe(true);
    expect((await uninstallAgents({ home: f.home })).conflicts).toEqual([]);
    for (const name of [".claude/rules/mex.md", ".claude/rules/mex-local.md", ".mex/native.json"]) {
      expect(existsSync(join(f.root, name))).toBe(false);
    }
    expect(f.get("CLAUDE.md")).toEqual(authored);
    expect(f.get(".git/info/exclude")).toEqual(ignore);
    expect(f.get(teamRule)).not.toEqual(teamBytes);
    expect(f.get(teamRule).toString()).toContain("signed tag");
    expect((await uninstallAgents({ home: f.home })).restored).toEqual([]);
  });

  it("preserves edits to generated output and to the rest of the Git exclude file", async () => {
    const f = fixture();
    const path = ".claude/rules/mex-local.md";
    f.put("CLAUDE.md", "# Team instructions\r\n");
    f.put(".git/info/exclude", "# Start\r\n");
    expect(rebuildNative(f.options, { setupDefaults: {} }).written).toEqual([path]);
    const edited = Buffer.concat([f.get(path), Buffer.from("\nKeep the team note.\n")]);
    f.put(path, edited);
    f.put(".git/info/exclude", Buffer.concat([f.get(".git/info/exclude"), Buffer.from("local-drafts/\r\n")]));
    const result = await uninstallAgents({ home: f.home });
    expect(result.conflicts.map(path => path.replace(/\\/gu, "/"))).toEqual([expect.stringMatching(/\/mex-local\.md$/u)]);
    expect(f.get(path)).toEqual(edited);
    expect(f.get(".git/info/exclude").toString()).toBe("# Start\r\nlocal-drafts/\r\n");
  });

  it("cleans up an older manifest without removing authored rule files", async () => {
    const f = fixture();
    const path = ".claude/rules/mex-local.md";
    const original = Buffer.from("# Original exclude\r\n");
    f.put("CLAUDE.md", "# Ours\n");
    f.put(".git/info/exclude", original);
    const projectDirectory = join(f.home, "projects", f.checkout.project_id);
    mkdirSync(projectDirectory, { recursive: true });
    const older = planNative(f.root, ["claude-code"], [{ level: "personal", entry: entry("mx_older1") }]);
    expect(writeNative(older, { root: f.root, projectDirectory }).written).toEqual([path]);
    expect(additionalUninstallPaths({ home: f.home }).some(file => file.endsWith("mex-local.md"))).toBe(true);
    expect((await uninstallAgents({ home: f.home })).conflicts).toEqual([]);
    expect(existsSync(join(f.root, path))).toBe(false);
    expect(existsSync(join(projectDirectory, "native-local.json"))).toBe(false);
    expect(f.get(".git/info/exclude")).toEqual(original);
    expect(f.get("CLAUDE.md").toString()).toBe("# Ours\n");
  });

  it("recovers a journaled rule file when interrupted before its manifest was published", async () => {
    const f = fixture();
    const path = join(f.checkout.path, "AGENTS.md");
    const first = planNative(f.root, ["codex"], [{ level: "team", entry: entry("mx_rule01", {}, "A first release rule.") }]).files[0]!;
    const writer = openRecord(f.options);
    try {
      changeNativeFile(writer, path, { data: null, mode: 0o600 }, { data: Buffer.from(first.text).toString("base64"), mode: 0o644 });
      f.put(".mex/learned/mx_rule01.md", serializeEntry(entry("mx_rule01", {}, "The new release rule.")));
      const result = rebuildNative(f.options);
      expect(result.written).toEqual(["AGENTS.md"]);
      expect(f.get("AGENTS.md").toString()).toContain("The new release rule.");
    } finally { writer.close(); }
    expect((await uninstallAgents({ home: f.home })).conflicts).toEqual([]);
    expect(existsSync(path)).toBe(false);
  });
});
