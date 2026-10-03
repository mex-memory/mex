import { describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { manageHook } from "../src/watch.js";
import type { MexConfig } from "../src/types.js";

// TeX Live ships its own `mex` binary; scripts must verify identity, not just the name (#223).
const REPO = resolve(__dirname, "..");

describe("git hook fallback", () => {
  it("falls back to npx mex-agent, never the ambiguous npx mex", async () => {
    const root = mkdtempSync(join(tmpdir(), "mex-hook-"));
    try {
      mkdirSync(join(root, ".git", "hooks"), { recursive: true });
      mkdirSync(join(root, ".mex"));
      const config = { projectRoot: root, scaffoldRoot: join(root, ".mex") } as MexConfig;
      await manageHook(config, {});
      const hook = readFileSync(join(root, ".git", "hooks", "post-commit"), "utf8");
      expect(hook).toContain("npx mex-agent check --quiet");
      expect(hook).not.toMatch(/npx mex check/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe.skipIf(process.platform === "win32")("shell scripts ignore a foreign mex on PATH", () => {
  it.each(["setup.sh", "sync.sh"])("%s warns and does not use it", (script) => {
    const dir = mkdtempSync(join(tmpdir(), "mex-collision-"));
    try {
      const fakeBin = join(dir, "bin");
      mkdirSync(fakeBin);
      const marker = join(dir, "fake-mex-ran-with-args");
      writeFileSync(join(fakeBin, "mex"), `#!/bin/sh\necho "$@" >> "${marker}"\necho "TeX mex"\nexit 1\n`);
      chmodSync(join(fakeBin, "mex"), 0o755);

      const project = join(dir, "proj");
      mkdirSync(join(project, ".mex"), { recursive: true });
      const result = spawnSync("bash", [join(REPO, script), ...(script === "setup.sh" ? ["--dry-run"] : [])], {
        cwd: project,
        env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` },
        encoding: "utf8",
        timeout: 60_000,
      });
      const out = `${result.stdout}${result.stderr}`;
      expect(out).toContain("is not mex-agent");
      expect(out).not.toContain("mex CLI found");
      // The only call the fake may receive is the identity probe.
      const calls = (() => { try { return readFileSync(marker, "utf8").trim().split("\n"); } catch { return []; } })();
      expect(calls.every((c) => c === "capabilities --json")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
