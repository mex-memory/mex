import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MINIMUM_NODE_VERSION, unsupportedNodeMessage } from "../src/node-version.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = join(repoRoot, "dist", "cli.js");
const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { engines: { node: string } };

describe("Node.js version check (#275)", () => {
  it("matches the engines range published in package.json", () => {
    expect(pkg.engines.node).toBe(`>=${MINIMUM_NODE_VERSION}`);
  });

  it.each(["16.20.2", "18.20.4", "20.18.0", "22.0.0", "22.4.1"])("refuses Node.js %s and names both versions", (version) => {
    const message = unsupportedNodeMessage(version);
    expect(message).toContain(`requires Node.js ${MINIMUM_NODE_VERSION} or newer`);
    expect(message).toContain(`You are running Node.js ${version}.`);
    expect(message).toContain("https://nodejs.org");
  });

  it.each(["22.5.0", "22.22.0", "23.0.0", "24.0.0", "25.1.0"])("accepts Node.js %s", (version) => {
    expect(unsupportedNodeMessage(version)).toBeNull();
  });

  it("stops the built CLI before any command runs on an unsupported Node.js", () => {
    if (!existsSync(cliPath)) throw new Error("dist/cli.js is missing — run `npm run build` first.");
    const cwd = mkdtempSync(join(tmpdir(), "mex-node-version-"));
    try {
      // Report an old Node.js to the CLI; setup would otherwise create .mex/ here.
      const fakeOldNode = 'data:text/javascript,Object.defineProperty(process.versions,"node",{value:"20.18.0"})';
      const result = spawnSync(process.execPath, ["--import", fakeOldNode, cliPath, "setup", "--yes", "--tool", "none"], {
        cwd,
        encoding: "utf8",
        timeout: 10_000,
        env: { ...process.env, HOME: cwd, MEX_TELEMETRY: "0", DO_NOT_TRACK: "1", NO_COLOR: "1" },
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`mex requires Node.js ${MINIMUM_NODE_VERSION} or newer. You are running Node.js 20.18.0.`);
      expect(result.stdout).toBe("");
      expect(existsSync(join(cwd, ".mex"))).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
