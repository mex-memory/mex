#!/usr/bin/env node
// Cross-compiles mex-hook into npm/hook-<os>-<arch>/bin and syncs each
// platform package's version with the root package.
//
//   node scripts/build-hook-binaries.mjs            all six targets
//   node scripts/build-hook-binaries.mjs --host     only this machine's target
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  execFileSync("go", ["build", "-trimpath", "-ldflags", ldflags, "-o", out, "./cmd/mex-hook"], {
    cwd: join(root, "native"),
    env: { ...process.env, GOOS: goos, GOARCH: goarch, CGO_ENABLED: "0" },
    stdio: "inherit",
  });
  console.log(`built ${platform}-${arch} -> ${out}`);
}
