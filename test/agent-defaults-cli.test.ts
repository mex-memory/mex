import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeAll, expect, it } from "vitest";
import { openRecord } from "../src/record/index.js";
import { recordCheck } from "../src/knowledge/check.js";
import { serializeEntry, type EntryCheck } from "../src/knowledge/entry.js";
import { entry } from "../src/knowledge/__tests__/fixtures.js";

let binary: string;
beforeAll(() => {
  binary = process.env.MEX_HOOK_BINARY ?? join(mkdtempSync(join(tmpdir(), "mex-defaults-hook-")), process.platform === "win32" ? "mex-hook.exe" : "mex-hook");
  if (!process.env.MEX_HOOK_BINARY) {
    execFileSync("go", ["build", "-o", binary, "./cmd/mex-hook"], { cwd: resolve("native"), timeout: 240_000, stdio: "pipe" });
  }
}, 300_000);

it("uses the Codex fallback only for a blocked slot and restores local files on uninstall", () => {
  const base = mkdtempSync(join(tmpdir(), "mex-defaults-cli-")), root = join(base, "repo"), profile = join(base, "profile");
  mkdirSync(profile);
  execFileSync("git", ["init", "-q", root]);
  const cli = resolve("dist/cli.js");
  const env = {
    ...process.env, MEX_HOME: profile, HOME: profile, USERPROFILE: profile, LOCALAPPDATA: profile,
    CLAUDE_CONFIG_DIR: join(profile, "claude"), CODEX_HOME: join(profile, "codex"), COPILOT_HOME: join(profile, "copilot"),
    MEX_OFFLINE: "1", MEX_TELEMETRY: "0", MEX_INSTALL_AUTO: "0", MEX_HOOK_BINARY: binary, MEX_BACKGROUND: "0",
  };
  const run = (...args: string[]) => {
    const result = spawnSync(process.execPath, [cli, ...args], { cwd: root, env, encoding: "utf8", timeout: 30_000 });
    expect(result.status, result.stderr || String(result.error)).toBe(0);
    return result.stdout;
  };
  const start = (session: string, agent = "codex") => {
    const input = JSON.stringify({ session_id: session, hook_event_name: "SessionStart", source: "startup", cwd: root });
    const result = spawnSync(binary, [agent, "SessionStart"], { cwd: root, env, input, encoding: "utf8", timeout: 15_000 });
    expect(result.status, result.stderr || String(result.error)).toBe(0);
    return (JSON.parse(result.stdout) as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput?.additionalContext ?? "";
  };
  const agents = join(root, "AGENTS.md"), override = join(root, "AGENTS.override.md"), exclude = join(root, ".git", "info", "exclude");
  const original = Buffer.from("# Repository instructions\r\nAlways add a changelog entry.\r\n");
  const ignore = readFileSync(exclude), docs = "# Release\n\nPublish artifacts from the stable lane.\n";
  writeFileSync(agents, original);
  writeFileSync(join(root, "README.md"), docs);
  mkdirSync(join(root, ".codex"));
  mkdirSync(join(root, ".kiro"));
  expect(run("--no-wait")).toMatch(/MEX defaults.*14 defaults.*1 left out.*Kiro/u);

  const writer = openRecord({ home: join(profile, ".mex") });
  const projectId = writer.checkout(root)!.project_id;
  try {
    expect(writer.db.prepare("SELECT count(*) AS count FROM model_calls").get()?.count).toBe(0);
    const notes = join(writer.location.home, "projects", projectId, "notes");
    mkdirSync(notes, { recursive: true });
    writeFileSync(join(notes, "mx_person01.md"), serializeEntry(entry("mx_person01", {}, "Use the signed release tag.")));
    const learned = "Publish artifacts from the stable lane.";
    const check = recordCheck(binary, { checkout: root, kind: "source", role: "complete", target: { file: "README.md" } }) as EntryCheck;
    writeFileSync(join(notes, "mx_deep01.md"), serializeEntry(entry("mx_deep01", {
      source: { type: "docs", ref: "README.md", producer: "learn-deeper", quote: learned },
      evidence: "docs",
      checks: [check],
    }, learned)));
  } finally { writer.close(); }
  run("rules", "--write", "--now");
  const settingOff = start("always-on-disabled");
  expect(settingOff).toContain("## MEX rules (Codex fallback)");
  expect(settingOff).toContain("Use the signed release tag.");
  expect(settingOff).not.toContain("Publish artifacts from the stable lane.");
  run("config", "set", "learning.alwaysOn", "on", "--project");
  run("rules", "--write", "--now");
  const shadowed = start("human-root");
  expect(shadowed).toContain("## MEX rules (Codex fallback)");
  expect(shadowed).toContain("## MEX defaults");
  expect(shadowed).toContain("Publish artifacts from the stable lane.");
  expect(shadowed.indexOf("Use the signed release tag.")).toBeLessThan(shadowed.indexOf("Publish artifacts from the stable lane."));
  expect(shadowed.indexOf("Publish artifacts from the stable lane.")).toBeLessThan(shadowed.indexOf("## MEX defaults"));
  expect(shadowed.match(/Use the signed release tag\./gu)).toHaveLength(1);
  expect(shadowed).not.toContain("Add a changelog or release-note entry");
  expect(start("claude", "claude-code")).not.toContain("## MEX defaults");
  expect(readFileSync(agents)).toEqual(original);
  writeFileSync(join(root, "README.md"), "# Release\n\nThe publishing process changed.\n");
  expect(start("stale-check")).not.toContain("Publish artifacts from the stable lane.");
  writeFileSync(join(root, "README.md"), docs);
  const preview = spawnSync(binary, ["--brief-run"], {
    cwd: root, env, encoding: "utf8", input: JSON.stringify({
      checkout: root, mex_home: join(profile, ".mex"), project_id: projectId, agent: "codex",
    }),
  });
  expect(JSON.parse(preview.stdout)).toMatchObject({ ok: true });
  expect(preview.stdout).not.toContain("MEX defaults");

  expect(run("config", "set", "agent.defaults", "off")).toContain("Agent defaults off");
  expect(run("status", "--json")).toContain('"agentDefaults": "off"');
  const disabled = start("disabled");
  expect(disabled).toContain("## MEX rules (Codex fallback)");
  expect(disabled).not.toContain("## MEX defaults");
  expect(run("config", "set", "agent.defaults", "on")).toContain("Agent defaults on");
  unlinkSync(agents);
  expect(start("no-slot-conflict")).not.toContain("## MEX rules (Codex fallback)");
  run("rules", "--write", "--now");
  const generated = readFileSync(agents);
  expect(generated.toString()).toContain("## MEX defaults");
  expect(start("native-file")).not.toContain("## MEX rules (Codex fallback)");
  writeFileSync(override, original);
  expect(start("native-shadowed")).toContain("## MEX rules (Codex fallback)");
  expect(readFileSync(agents)).toEqual(generated);
  expect(readFileSync(override)).toEqual(original);

  run("off");
  expect(existsSync(agents)).toBe(false);
  expect(start("checkout-off")).not.toContain("## MEX defaults");
  const uninstall = JSON.parse(run("uninstall", "--json")) as { conflicts: string[] };
  expect(uninstall.conflicts).toEqual([]);
  expect(existsSync(agents)).toBe(false);
  expect(readFileSync(override)).toEqual(original);
  expect(readFileSync(exclude)).toEqual(ignore);
}, 120_000);
