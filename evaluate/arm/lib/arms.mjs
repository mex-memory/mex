import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, unlinkSync, chmodSync, writeFileSync } from "node:fs";
import { arch, platform, release } from "node:os";
import { basename, delimiter, join } from "node:path";
import { runTimed } from "../../compare/lib/process.mjs";

const START = "SessionStart";
const SYSTEM_ENV = new Set([
  "PATH", "PATHEXT", "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC", "PROGRAMFILES",
  "PROGRAMFILES(X86)", "PROGRAMDATA", "PROCESSOR_ARCHITECTURE", "LANG", "LC_ALL", "TZ",
  "GOCACHE", "GOMODCACHE",
]);
const RULE_PATHS = ["AGENTS.md", "CLAUDE.md", ".claude/CLAUDE.md", ".github/copilot-instructions.md"];
const RULE_DIRS = ["rules", ".claude/rules", ".github/instructions", ".cursor/rules"];
const MEX_BLOCK = /<!--\s*(?:mex[- :]|begin\s+mex\b|end\s+mex\b)/i;

export function makeArm(parent, arm, path) {
  const root = mkdtempSync(join(parent, arm + "-"));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => SYSTEM_ENV.has(key.toUpperCase())));
  for (const key of Object.keys(env)) if (key.toUpperCase() === "PATH") delete env[key];
  Object.assign(env, {
    PATH: path,
    HOME: join(root, "user"),
    USERPROFILE: join(root, "user"),
    MEX_HOME: join(root, "mex"),
    CLAUDE_CONFIG_DIR: join(root, "claude"),
    CODEX_HOME: join(root, "codex"),
    COPILOT_HOME: join(root, "copilot"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_STATE_HOME: join(root, "state"),
    LOCALAPPDATA: join(root, "local"),
    APPDATA: join(root, "app"),
    TMPDIR: join(root, "temp"),
    TMP: join(root, "temp"),
    TEMP: join(root, "temp"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(root, "user", ".gitconfig"),
    MEX_TELEMETRY: "0",
    MEX_INSTALL_AUTO: "0",
  });
  for (const key of ["HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "LOCALAPPDATA", "APPDATA", "TMPDIR"]) {
    mkdirSync(env[key], { mode: 0o700 });
  }
  return { arm, root, env, workspace: join(root, "checkout") };
}

export function isolatedPath() {
  const bins = process.platform === "win32" ? ["mex", "mex.exe", "mex.cmd", "mex.bat"] : ["mex"];
  return (process.env.PATH ?? "").split(delimiter).filter(part =>
    part && !bins.some(bin => existsSync(join(part, bin)))).join(delimiter);
}

const credentials = env => [
  join(env.CLAUDE_CONFIG_DIR, ".credentials.json"),
  join(env.CODEX_HOME, "auth.json"),
];

export function copyCredential(profile, agent, source) {
  if (!source) return;
  const dest = credentials(profile.env)[agent === "claude" ? 0 : 1];
  try {
    const file = lstatSync(source);
    if (!file.isFile() || file.isSymbolicLink() || basename(source) !== basename(dest)) throw new Error("invalid credential file");
    copyFileSync(source, dest, constants.COPYFILE_EXCL);
    chmodSync(dest, 0o600);
  } catch {
    throw new Error("Could not copy the " + agent + " credential file");
  }
}

export function clearCredentials(profile) {
  const failures = [];
  for (const file of credentials(profile.env)) {
    try { unlinkSync(file); }
    catch (error) { if (error.code !== "ENOENT") failures.push(basename(file)); }
  }
  if (failures.length) throw new Error("Could not remove arm credential copies: " + failures.join(", "));
}

export function checkBaseline({ env, workspace }) {
  const settings = [
    join(env.CLAUDE_CONFIG_DIR, "settings.json"),
    join(env.CODEX_HOME, "hooks.json"),
    join(env.HOME, ".mex"),
    join(env.HOME, ".claude", "settings.json"),
    join(env.HOME, ".codex", "hooks.json"),
    env.MEX_HOME,
  ];
  if (settings.some(path => existsSync(path))) throw new Error("Baseline has hook settings or a MEX home");
  for (const root of [env.HOME, env.CLAUDE_CONFIG_DIR, env.CODEX_HOME, workspace].filter(Boolean)) {
    const files = RULE_PATHS.map(file => join(root, file));
    for (const name of RULE_DIRS) {
      const directory = join(root, name);
      if (!existsSync(directory)) continue;
      for (const file of readdirSync(directory, { withFileTypes: true })) {
        if (file.isFile()) files.push(join(directory, file.name));
      }
    }
    for (const path of files) {
      if (existsSync(path) && MEX_BLOCK.test(readFileSync(path, "utf8"))) throw new Error("Baseline contains a MEX rule block");
    }
  }
  for (const file of [".claude/settings.json", ".claude/settings.local.json", ".codex/hooks.json"]) {
    const path = join(workspace, file);
    if (existsSync(path) && /mex[- ](?:hook|managed)/i.test(readFileSync(path, "utf8"))) {
      throw new Error("Baseline checkout contains a MEX hook");
    }
  }
}

const quoteSh = value => "'" + value.replaceAll("'", "'\\''") + "'";
const quotePs = value => "'" + value.replaceAll("'", "''") + "'";
const quoteCmd = value => '"' + value.replaceAll("%", "%%") + '"';

export function exposeMex(profile, cli) {
  const bin = join(profile.root, "bin");
  mkdirSync(bin, { mode: 0o700 });
  const windows = process.platform === "win32";
  const command = [process.execPath, cli].map(windows ? quoteCmd : quoteSh).join(" ");
  const source = windows ? "@echo off\r\n" + command + " %*\r\n" : "#!/bin/sh\nexec " + command + ' "$@"\n';
  writeFileSync(join(bin, windows ? "mex.cmd" : "mex"), source, { mode: 0o700, flag: "wx" });
  profile.env.PATH = bin + delimiter + profile.env.PATH;
}

export async function checkedRun(command, args, options, label) {
  const result = await runTimed(command, args, { maxOutputBytes: 16 * 1024 * 1024, ...options });
  if (result.timedOut || result.error || result.code !== 0) {
    throw new Error(label + (result.timedOut ? " timed out" : " failed (exit " + result.code + ")"));
  }
  return result;
}

/**
 * Install MEX in the arm and prove its SessionStart hook runs. `requireNative`
 * refuses the Node fallback: it only fails open and delivers nothing, so a MEX
 * arm on it would measure an arm without MEX.
 */
export async function preflightMex(profile, cli, id, { requireNative = false } = {}) {
  const { env, root } = profile;
  const result = await checkedRun(process.execPath, [cli, "install", "--json"], { cwd: root, env }, "MEX install");
  if (!JSON.parse(result.stdout).agents.includes(id)) throw new Error("MEX install did not register " + id);

  const settings = id === "codex" ? join(env.CODEX_HOME, "hooks.json") : join(env.CLAUDE_CONFIG_DIR, "settings.json");
  const bytes = readFileSync(settings);
  const hooks = JSON.parse(bytes).hooks;
  const native = join(env.MEX_HOME, ".mex", "bin", process.platform === "win32" ? "mex-hook.exe" : "mex-hook");
  const fallback = join(env.MEX_HOME, ".mex", "bin", "mex-hook.cjs");
  if (!hooks?.[START]) throw new Error("MEX SessionStart registration is missing");
  let startup;
  for (const [event, groups] of Object.entries(hooks)) {
    const list = groups.flatMap(group => group.hooks ?? []);
    const command = list[0];
    if (list.length !== 1 || command.type !== "command") throw new Error("MEX hook registration is ambiguous");
    const matches = vector => id === "claude-code"
      ? command.command === vector[0] && JSON.stringify(command.args) === JSON.stringify(vector.slice(1))
      : command.command === vector.map(quoteSh).join(" ")
        && (process.platform !== "win32" || command.commandWindows === "& " + vector.map(quotePs).join(" "));
    const invocation = [[native, id, event], ["node", fallback, id, event]].find(matches);
    if (!invocation) throw new Error("MEX hook points outside the expected runtime");
    if (event === START) startup = { command, invocation };
  }

  const input = JSON.stringify({ session_id: "harness-preflight", cwd: root, source: "startup", hook_event_name: START }) + "\n";
  const { command, invocation } = startup;
  const [executable, ...args] = invocation;
  if (requireNative && executable !== native) {
    throw new Error("MEX installed its fail-open Node fallback, which delivers nothing. Build the native hook (node scripts/build-hook-binaries.mjs --host) and make its platform package resolvable from the MEX CLI");
  }
  if (executable === native) {
    const nativeTest = await checkedRun(native, ["--self-test"], { cwd: root, env, timeoutMs: 5000 }, "MEX native self-test");
    if (JSON.parse(nativeTest.stdout).ok !== true) throw new Error("MEX native self-test did not report success");
  }
  const launch = id === "claude-code" ? [executable, ...args] : process.platform === "win32"
    ? ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", command.commandWindows]
    : ["sh", "-c", command.command];
  const reply = await checkedRun(launch[0], launch.slice(1), { cwd: root, env, stdin: input, timeoutMs: 12000 }, "MEX SessionStart self-test");
  // The arm root is not set up, so the native hook may tell the person MEX is
  // off here. Anything that would reach the model fails the check.
  const parsed = JSON.parse(reply.stdout);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
      || Object.keys(parsed).some(key => key !== "systemMessage")) {
    throw new Error("MEX SessionStart self-test returned model context: " + reply.stdout.trim().slice(0, 300));
  }
  return { settings, bytes, runtime: executable === native ? "native" : "node" };
}

export const platformPin = () => ({ node: process.version, os: platform(), osRelease: release(), arch: arch() });
