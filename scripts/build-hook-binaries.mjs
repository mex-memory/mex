#!/usr/bin/env node
// Cross-compiles mex-hook into npm/hook-<os>-<arch>/bin and syncs each
// platform package's version with the root package.
//
//   node scripts/build-hook-binaries.mjs            all six targets
//   node scripts/build-hook-binaries.mjs --host     only this machine's target
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;

// npm platform/arch names mapped to Go's.
const targets = [
  ["linux", "x64", "linux", "amd64"],
  ["linux", "arm64", "linux", "arm64"],
  ["darwin", "x64", "darwin", "amd64"],
  ["darwin", "arm64", "darwin", "arm64"],
  ["win32", "x64", "windows", "amd64"],
  ["win32", "arm64", "windows", "arm64"],
];

const hostOnly = process.argv.includes("--host");
const selected = hostOnly
  ? targets.filter(([p, a]) => p === process.platform && a === process.arch)
  : targets;
if (selected.length === 0) {
  console.error(`no mex-hook target for ${process.platform}/${process.arch}`);
  process.exit(1);
}

const ldflags = `-s -w -X github.com/mex-memory/mex/native/internal/hook.Version=${version}`;

// The shim now links the already-pinned SQLite driver. Preserve the actual
// linked modules' license inventories beside every distributed binary.
function goLicense(goroot) {
  // Homebrew keeps the SDK under libexec and its license beside that folder.
  for (const path of [join(goroot, "LICENSE"), join(dirname(goroot), "LICENSE")]) {
    let info;
    try { info = statSync(path); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    if (!info.isFile() || info.size > 16 * 1024) throw new Error("Invalid Go license inventory");
    const text = readFileSync(path, "utf8");
    if (!text.startsWith("Copyright 2009 The Go Authors.")) throw new Error("Unrecognized Go license inventory");
    return text;
  }
  throw new Error("Missing Go standard library license inventory");
}

function dependencyNotices(env) {
  const cwd = join(root, "native");
  const format = '{{if .Module}}{{.Module.Path}}|{{.Module.Version}}|{{.Module.Dir}}{{end}}';
  const modules = new Map();
  const lines = execFileSync("go", ["list", "-deps", "-f", format, "./cmd/mex-hook"], { cwd, env, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  for (const line of lines.split("\n")) {
    const [name, revision, ...parts] = line.split("|");
    if (revision) modules.set(name, { revision, directory: parts.join("|") });
  }
  const goroot = execFileSync("go", ["env", "GOROOT"], { cwd, env, encoding: "utf8" }).trim();
  const notices = ["MEX hook dependency notices", "Upstream inventories may also describe components that are not linked.", "Go standard library", goLicense(goroot)];
  let total = 0;
  for (const [name, module] of [...modules].sort(([a], [b]) => a.localeCompare(b))) {
    const files = readdirSync(module.directory).filter((name) => /^(LICENSE(?:$|[-_.])|COPYING|NOTICE)/i.test(name)).sort();
    if (!files.length) throw new Error(`Missing license inventory: ${name}`);
    notices.push(`${name}@${module.revision}`);
    for (const file of files) {
      const path = join(module.directory, file), info = statSync(path);
      if (!info.isFile() || info.size > 1024 * 1024 || (total += info.size) > 4 * 1024 * 1024) throw new Error("Hook license inventory exceeds its bound");
      notices.push(file, readFileSync(path, "utf8"));
    }
  }
  return notices.join("\n\n") + "\n";
}

for (const [platform, arch, goos, goarch] of selected) {
  const pkgDir = join(root, "npm", `hook-${platform}-${arch}`);
  const pkgPath = join(pkgDir, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  if (pkg.version !== version) {
    pkg.version = version;
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  }

  const out = join(pkgDir, "bin", platform === "win32" ? "mex-hook.exe" : "mex-hook");
  mkdirSync(dirname(out), { recursive: true });
  const env = { ...process.env, GOOS: goos, GOARCH: goarch, CGO_ENABLED: "0" };
  execFileSync("go", ["build", "-trimpath", "-ldflags", ldflags, "-o", out, "./cmd/mex-hook"], {
    cwd: join(root, "native"),
    env,
    stdio: "inherit",
  });
  writeFileSync(join(pkgDir, "bin", "THIRD-PARTY-NOTICES.txt"), dependencyNotices(env));
  console.log(`built ${platform}-${arch} -> ${out}`);
}
