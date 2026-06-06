import { execSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = join(repoRoot, "dist/cli.js");

/** Node built-ins that may appear as bare imports in the bundled CLI. */
const NODE_BUILTINS = new Set([
  "assert",
  "buffer",
  "child_process",
  "crypto",
  "events",
  "fs",
  "fs/promises",
  "module",
  "os",
  "path",
  "process",
  "readline",
  "readline/promises",
  "stream",
  "string_decoder",
  "tty",
  "url",
  "util",
]);

function writeMinimalScaffold(projectRoot: string, mexDir: string): void {
  const frontmatter = (name: string) => `---
name: ${name}
description: test
triggers: []
edges: []
last_updated: 2026-06-06
---
content
`;

  writeFileSync(join(mexDir, "ROUTER.md"), frontmatter("router"));
  writeFileSync(join(mexDir, "AGENTS.md"), "# Agents\n[Project Name]\n");
  for (const name of ["architecture", "stack", "conventions", "decisions", "setup"]) {
    writeFileSync(join(mexDir, "context", `${name}.md`), frontmatter(name));
  }
  writeFileSync(
    join(mexDir, "patterns", "INDEX.md"),
    `${frontmatter("index")}\n| Pattern | Description |\n|---------|-------------|\n`,
  );

  execSync("git init -q", { cwd: projectRoot });
  execSync("git add -A", { cwd: projectRoot });
  execSync('git -c user.email=test@test.com -c user.name=test commit -q -m init', {
    cwd: projectRoot,
  });
}

describe("bundled CLI (Windows/WSL issue #10)", () => {
  beforeAll(() => {
    execSync("npm run build", { cwd: repoRoot, stdio: "pipe" });
  }, 120_000);

  it("does not leave npm package imports in dist/cli.js", () => {
    const source = readFileSync(cliPath, "utf8");
    const externalImports = [
      ...source.matchAll(/^import\s+.+\s+from\s+["']([^./][^"']*)["']/gm),
    ]
      .map((match) => match[1])
      .filter((name) => !name.startsWith("node:") && !NODE_BUILTINS.has(name));

    expect(externalImports).toEqual([]);
  });

  it("runs --version without .mex/node_modules", () => {
    const tmp = mkdtempSync(join(tmpdir(), "mex-bundle-"));
    const mexDir = join(tmp, ".mex");
    mkdirSync(join(mexDir, "dist"), { recursive: true });
    copyFileSync(cliPath, join(mexDir, "dist/cli.js"));
    copyFileSync(join(repoRoot, "package.json"), join(mexDir, "package.json"));

    const out = execSync("node dist/cli.js --version", {
      cwd: mexDir,
      encoding: "utf8",
    });

    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
      version: string;
    };
    expect(out.trim()).toBe(pkg.version);
  });

  it("runs check --quiet on a minimal scaffold without node_modules", () => {
    const tmp = mkdtempSync(join(tmpdir(), "mex-bundle-check-"));
    const mexDir = join(tmp, ".mex");
    mkdirSync(join(mexDir, "dist"), { recursive: true });
    mkdirSync(join(mexDir, "context"), { recursive: true });
    mkdirSync(join(mexDir, "patterns"), { recursive: true });

    copyFileSync(cliPath, join(mexDir, "dist/cli.js"));
    copyFileSync(join(repoRoot, "package.json"), join(mexDir, "package.json"));
    writeMinimalScaffold(tmp, mexDir);

    const out = execSync("node .mex/dist/cli.js check --quiet", {
      cwd: tmp,
      encoding: "utf8",
    });

    expect(out.trim()).toMatch(/^mex: drift score \d+\/100/);
  });
});
