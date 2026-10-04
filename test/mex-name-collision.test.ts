import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { manageHook } from "../src/watch.js";
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

async function installHook(withLocalBuild = false): Promise<string> {
  const root = join(dir, "repo");
  mkdirSync(join(root, ".git", "hooks"), { recursive: true });
  mkdirSync(join(root, ".mex"));
  if (withLocalBuild) {
    mkdirSync(join(root, ".mex", "dist"));
    writeFileSync(join(root, ".mex", "dist", "cli.js"), "");
  }
  const config = { projectRoot: root, scaffoldRoot: join(root, ".mex") } as MexConfig;
  await manageHook(config, {});
  return join(root, ".git", "hooks", "post-commit");
}

function runHook(hook: string): { out: string; status: number | null } {
  const r = spawnSync("sh", [hook], {
    env: { PATH: `${fakeBin}:${SYSTEM_PATH}` },
    encoding: "utf8",
    timeout: 30_000,
  });
  return { out: `${r.stdout}${r.stderr}`, status: r.status };
}

describe.skipIf(process.platform === "win32")("post-commit hook", () => {
  it("falls back to the explicit npm package, never the ambiguous npx mex", async () => {
    const hook = readFileSync(await installHook(), "utf8");
    expect(hook).toContain("npx mex-agent check --quiet");
    expect(hook).not.toMatch(/npx mex check/);
  });

  it("ignores a foreign mex and falls back to npx mex-agent", async () => {
    installFakeMex("tex");
    installFakeNpx("ok");
    runHook(await installHook());
    expect(calls()).toContain("npx mex-agent check --quiet");
    expect(calls()).not.toContain("check --quiet");
  });

  it("uses a verified global mex without touching npm (works offline)", async () => {
    installFakeMex("mex");
    installFakeNpx("offline");
    const { status } = runHook(await installHook());
    expect(status).toBe(0);
    expect(calls()).toContain("check --quiet");
    expect(calls().some((c) => c.startsWith("npx"))).toBe(false);
  });

  it("uses the local build without probing PATH", async () => {
    installFakeMex("tex");
    installFakeNpx("offline");
    const content = readFileSync(await installHook(true), "utf8");
    expect(content).toContain('node "');
    expect(content).not.toContain("mex_is_agent");
  });

  it("never fails the commit when nothing works", async () => {
    installFakeNpx("offline");
    const { status } = runHook(await installHook());
    expect(status).toBe(0);
  });

  it("uninstall removes exactly the mex block and keeps other hook content", async () => {
    const hook = await installHook();
    writeFileSync(hook, `#!/bin/sh\necho before\n\n${readFileSync(hook, "utf8").replace("#!/bin/sh\n", "")}\necho after\n`);
    const root = resolve(hook, "..", "..", "..");
    await manageHook({ projectRoot: root, scaffoldRoot: join(root, ".mex") } as MexConfig, { uninstall: true });
    const left = readFileSync(hook, "utf8");
    expect(left).toContain("echo before");
    expect(left).toContain("echo after");
    expect(left).not.toMatch(/mex|SCORE|esac|MEX_BIN/);
  });

  it("still uninstalls a hook written by an earlier version (no end marker)", async () => {
    const hook = await installHook();
    writeFileSync(hook, `#!/bin/sh\n# mex-drift-check\n# Auto-installed by mex watch — runs drift check after each commit\nSCORE=$(npx mex check --quiet 2>&1) || true\n# Only show output if there are issues (not a perfect score)\ncase "$SCORE" in\n  *"100/100"*) ;;\n  *) echo "$SCORE" ;;\nesac\n`);
    const root = resolve(hook, "..", "..", "..");
    await manageHook({ projectRoot: root, scaffoldRoot: join(root, ".mex") } as MexConfig, { uninstall: true });
    expect(existsSync(hook)).toBe(false);
  });
});

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
