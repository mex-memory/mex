import { it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openRecord } from "../src/record/index.js";
it("switches learned sharing per project through the built CLI", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "mex-sharing-cli-"))), root = join(base, "repo"), home = join(base, ".mex"); mkdirSync(root);
  const writer = openRecord({ home, projectPath: root, isNetwork: () => false }), project = writer.checkout(root)!.project_id;
  const run = (...args: string[]) => spawnSync(process.execPath, [resolve("dist/cli.js"), "config", "set", "learning.sharing", ...args], { cwd: root, encoding: "utf8", env: { ...process.env, MEX_HOME: base, MEX_BACKGROUND: "0", MEX_TELEMETRY: "0", MEX_INSTALL_AUTO: "0" } });
  try {
    const manual = run("manual", "--project"); expect(manual.status, manual.stderr + manual.stdout).toBe(0); expect(writer.setting(project, "learning.sharing")).toBe("manual");
    expect(writer.setting("global", "learning.sharing")).toBeUndefined();
    expect(run("automatic", "--project").status).toBe(0); expect(writer.setting(project, "learning.sharing")).toBe("automatic");
    expect(run("invalid", "--project").status).toBe(1); expect(writer.setting(project, "learning.sharing")).toBe("automatic");
    expect(run("manual").status).toBe(1); expect(writer.setting(project, "learning.sharing")).toBe("automatic");
  } finally { writer.close(); rmSync(base, { recursive: true, force: true }); }
});
