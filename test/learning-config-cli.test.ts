import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { openRecordReadOnly } from "../src/record/index.js";

it("accepts the learning command printed by the first screen in global scope", () => {
  const base = mkdtempSync(join(tmpdir(), "mex-config-cli-"));
  const env = { ...process.env, MEX_HOME: join(base, "home"), CLAUDE_CONFIG_DIR: join(base, "claude"), CODEX_HOME: join(base, "codex"), LOCALAPPDATA: join(base, "local"), MEX_TELEMETRY: "0", MEX_INSTALL_AUTO: "0", MEX_BACKGROUND: "0" };
  for (const value of ["off", "on"]) {
    const result = spawnSync(process.execPath, [resolve("dist/cli.js"), "config", "set", "learning.statements", value], { env, cwd: base, encoding: "utf8", timeout: 15_000 });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toContain(value === "on" ? "at most 3% of your usage. Turn off: mex config set learning.statements off" : "MEX no longer learns from what you type.");
    const reader = openRecordReadOnly({ home: join(env.MEX_HOME, ".mex") });
    try { expect(reader?.setting("global", "learning.statements")).toBe(value); } finally { reader?.close(); }
  }
});

it("refuses learning from past sessions while this version has no producer for it, and accepts off", () => {
  const base = mkdtempSync(join(tmpdir(), "mex-config-cli-"));
  const env = { ...process.env, MEX_HOME: join(base, "home"), CLAUDE_CONFIG_DIR: join(base, "claude"), CODEX_HOME: join(base, "codex"), LOCALAPPDATA: join(base, "local"), MEX_TELEMETRY: "0", MEX_INSTALL_AUTO: "0", MEX_BACKGROUND: "0" };
  const set = (value: string) => spawnSync(process.execPath, [resolve("dist/cli.js"), "config", "set", "learning.sessions", value], { env, cwd: base, encoding: "utf8", timeout: 15_000 });
  const on = set("on");
  expect(on.status).toBe(1);
  expect(on.stderr.trim()).toBe("Learning from past sessions isn't available in this version yet; nothing changed.");
  expect(existsSync(join(env.MEX_HOME, ".mex", "record.db"))).toBe(false);
  const off = set("off");
  expect(off.status, off.stderr).toBe(0);
  expect(off.stdout.trim()).toBe("Learning from past sessions is off.");
  const reader = openRecordReadOnly({ home: join(env.MEX_HOME, ".mex") });
  try { expect(reader?.setting("global", "learning.sessions")).toBe("off"); } finally { reader?.close(); }
  expect(set("on").status).toBe(1);
  const again = openRecordReadOnly({ home: join(env.MEX_HOME, ".mex") });
  try { expect(again?.setting("global", "learning.sessions")).toBe("off"); } finally { again?.close(); }
});
