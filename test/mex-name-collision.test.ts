import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import type { MexConfig } from "../src/types.js";

const REPO = resolve(__dirname, "..");
const SYSTEM_PATH = "/usr/bin:/bin";

// Trimmed `mex --help`, same shape in v0.6.3 and current
const HELP = `Usage: mex [options] [command]

CLI engine for mex scaffold — drift detection, pre-analysis, and targeted sync

Options:
  -V, --version            output the version number
  -h, --help               display help for command

Commands:
  tui                      Open the interactive mex dashboard
  check [options]          Detect drift between scaffold files and codebase
                           reality
  sync [options]           Run drift check, then build targeted prompts for AI
                           to fix flagged files
`;

type Kind = "tex" | "mex";

let dir: string;
let fakeBin: string;
let log: string;

function script(body: string): string {
  return `#!/bin/sh\n${body}\n`;
}

function installFakeMex(kind: Kind): void {
  const record = `echo "$@" >> "${log}"`;
  const bodies: Record<Kind, string> = {
    tex: `${record}\necho "This is TeX mex"\nexit 1`,
    mex: `${record}
case "$1" in
  --help) cat <<'EOF'
${HELP}EOF
  ;;
  *) echo "100/100" ;;
esac`,
  };
  writeFileSync(join(fakeBin, "mex"), script(bodies[kind]));
  chmodSync(join(fakeBin, "mex"), 0o755);
}

function installFakeNpx(behavior: "offline" | "ok"): void {
  const body = behavior === "offline"
    ? `echo "npx $@" >> "${log}"\necho "npm error code ENOTCACHED" >&2\nexit 1`
    : `echo "npx $@" >> "${log}"\necho "100/100"`;
  writeFileSync(join(fakeBin, "npx"), script(body));
  chmodSync(join(fakeBin, "npx"), 0o755);
}

function calls(): string[] {
  return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : [];
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mex-collision-"));
  fakeBin = join(dir, "bin");
  log = join(dir, "calls.log");
  mkdirSync(fakeBin);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe.skipIf(process.platform === "win32")("setup.sh and sync.sh identity check", () => {
  function run(script: string): string {
    const project = join(dir, "proj");
    mkdirSync(join(project, ".mex"), { recursive: true });
    const r = spawnSync("bash", [join(REPO, script), ...(script === "setup.sh" ? ["--dry-run"] : [])], {
      cwd: project,
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` },
      encoding: "utf8",
      timeout: 60_000,
    });
    return `${r.stdout}${r.stderr}`;
  }

  it.each(["setup.sh", "sync.sh"])("%s warns about a foreign mex and does not use it", (script) => {
    installFakeMex("tex");
    const out = run(script);
    expect(out).toContain("is not mex-agent");
    expect(out).not.toContain("mex CLI found");
    expect(calls().every((c) => c === "--help")).toBe(true);
  });

  it.each(["setup.sh", "sync.sh"])(
    "%s accepts a genuine mex",
    (script) => {
      installFakeMex("mex");
      const out = run(script);
      expect(out).not.toContain("is not mex-agent");
      if (script === "setup.sh") expect(out).toContain("mex CLI found");
      else expect(calls().some((c) => c.startsWith("check"))).toBe(true);
    },
  );
});
