import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
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
    expect(result.stdout.trim()).toBe(`Learning from what you type is ${value}.`);
    const reader = openRecordReadOnly({ home: join(env.MEX_HOME, ".mex") });
    try { expect(reader?.setting("global", "learning.statements")).toBe(value); } finally { reader?.close(); }
  }
});
