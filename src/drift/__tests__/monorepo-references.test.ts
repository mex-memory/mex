import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkPaths } from "../checkers/path.js";
import { checkCommands } from "../checkers/command.js";
import { checkDependencies } from "../checkers/dependency.js";
import { extractClaims } from "../claims.js";
import { RepositoryInventory } from "../repository.js";
import type { Claim } from "../../types.js";

let root: string;
const write = (file: string, content = "") => {
  const path = join(root, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
};
const pkg = (file: string, data: object) => write(file, JSON.stringify(data));
const claim = (value: string, kind: Claim["kind"] = "path"): Claim => ({ kind, value, source: ".mex/context/guide.md", line: 3, section: "Guide", negated: false });
const paths = (...values: string[]) => checkPaths(values.map((value) => claim(value)), root, join(root, ".mex"));
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "mex-monorepo-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe("repository references", () => {
  it.each(["ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "go", "rs"])("resolves extensionless tracked modules and index files (%s)", (extension) => {
    execFileSync("git", ["init", "-q"], { cwd: root });
    write(`apps/api/src/shared/framework/response.decorator.${extension}`);
    write(`apps/api/src/shared/commands/project.command.${extension}`);
    write(`libs/core/src/shared/commands/project.command.${extension}`);
    write(`apps/api/src/shared/services/index.${extension}`);
    execFileSync("git", ["add", "apps", "libs"], { cwd: root });
    expect(paths("shared/framework/response.decorator", "shared/commands/project.command", "shared/services", "apps/api/src/shared/services")).toEqual([]);
    expect(paths("shared/framework/respons.decorator", "apps/api/src/shared/servces")).toHaveLength(2);
    write(`output/untracked.command.${extension}`);
    expect(paths("untracked.command")).toHaveLength(1);
  });
  it("rejects deleted extensionless targets and does not strip non-source extensions", () => {
    execFileSync("git", ["init", "-q"], { cwd: root });
    write("src/deleted.command.ts"); write("src/config.json");
    execFileSync("git", ["add", "src"], { cwd: root });
    unlinkSync(join(root, "src/deleted.command.ts"));
    expect(paths("src/deleted.command", "src/config")).toHaveLength(2);
  });
  it("resolves deep unique bare filenames and partial suffixes without a depth cap", () => {
    write("apps/api/src/features/a/b/c/d/interceptors/access.ts");
    expect(paths("access.ts", "interceptors/access.ts")).toEqual([]);
    expect(paths("acces.ts")[0]).toMatchObject({ code: "MISSING_PATH", severity: "error" });
  });
  it("accepts a bare name or suffix that several files share", () => {
    for (const folder of ["one", "two", "three", "four"]) write(`apps/${folder}/src/view.tsx`);
    write("package.json", "{}"); write("apps/one/package.json", "{}");
    expect(paths("view.tsx", "src/view.tsx", "package.json")).toEqual([]);
    expect(paths("src/viw.tsx")[0]).toMatchObject({ code: "MISSING_PATH", severity: "error" });
  });
  it("resolves uncommitted scaffold filenames in a tracked repository", () => {
    execFileSync("git", ["init", "-q"], { cwd: root });
    write("src/app.ts"); execFileSync("git", ["add", "src"], { cwd: root });
    write(".mex/patterns/INDEX.md");
    expect(paths("INDEX.md")).toEqual([]);
  });
  it("uses tracked files and rejects a deleted file, ignored duplicates, and nested installed files", () => {
    execFileSync("git", ["init", "-q"], { cwd: root });
    write("apps/deep/src/present.ts"); write("apps/deep/src/deleted.ts");
    execFileSync("git", ["add", "apps"], { cwd: root });
    unlinkSync(join(root, "apps/deep/src/deleted.ts"));
    write("output/present.ts"); write("apps/node_modules/vendor/installed.ts");
    expect(paths("present.ts")).toEqual([]);
    expect(paths("deleted.ts", "installed.ts")).toHaveLength(2);
  });
  it("resolves JSONC tsconfig paths, relative extends, exact aliases and index modules", () => {
    write("tsconfig.base.json", '{ // base\n "compilerOptions": {"baseUrl":".","paths":{"@/*":["apps/web/src/*"],"settings":["apps/web/src/config.ts"]}}}');
    write("apps/web/tsconfig.json", '{"extends":"../../tsconfig.base"}');
    write("apps/web/src/config.ts"); write("apps/web/src/api/index.ts");
    expect(paths("@/config", "@/api", "settings")).toEqual([]);
    expect(paths("@/missing")[0]).toMatchObject({ code: "MISSING_PATH", severity: "error" });
  });
  it("does not escape the repository through alias targets", () => {
    write("tsconfig.json", '{"compilerOptions":{"paths":{"@/*":["../*"]}}}');
    expect(paths("@/missing")[0].code).toBe("MISSING_PATH");
  });
});

describe("workspace manifests", () => {
  it("checks placeholder script templates against all workspace manifests", () => {
    pkg("package.json", { workspaces: ["packages/*"], scripts: {} });
    pkg("packages/shared/package.json", { scripts: { "generate:chat-schema": "tool", "build:api:prod": "tool", "a.b:one": "tool" } });
    for (const value of ["pnpm --filter @sample/shared generate:<provider>-schema", "npm run build:<target>:<mode>", "yarn run a.b:<name>"]) {
      expect(checkCommands([claim(value, "command")], root), value).toEqual([]);
    }
    for (const script of ["generate:<provider>-missing", "build:<target>:qa", "a+b:<name>", "missing-script"]) {
      const issues = checkCommands([claim(`pnpm run ${script}`, "command")], root);
      expect(issues).toHaveLength(1);
      expect(issues[0].message).toContain(script);
      if (script.includes("<")) expect(issues[0].message).toContain("template");
    }
  });
  it("extracts package and library claims but excludes code identifiers and calls", () => {
    pkg("package.json", { dependencies: { react: "1", "@nestjs/core": "1", "socket.io": "1" } });
    write("doc.md", "# Key Libraries\n- **`safeOutboundRequest` / `HttpClientService({ enforceProtection: true })`** for outbound HTTP\n- **`React`** UI\n- **`NestJS`** framework\n- **`Socket.io`** transport\n- **`FastAPI`** server\n- **`absent-package`** dependency\n- **`@sample/missing`** dependency\n- **`missing`** dependency\n- **helpers `InputPipe`** validation\n");
    const claims = extractClaims(join(root, "doc.md"), "doc.md");
    expect(claims.filter((c) => c.kind === "dependency").map((c) => c.value)).toEqual(["React", "NestJS", "Socket.io", "FastAPI", "absent-package", "@sample/missing", "missing"]);
    expect(checkDependencies(claims, root).map((issue) => issue.claim?.value)).toEqual(["FastAPI", "absent-package", "@sample/missing", "missing"]);
  });
  const setup = () => {
    pkg("package.json", { workspaces: ["apps/*", "!apps/excluded"], scripts: {} });
    pkg("apps/api/package.json", { name: "@sample/api", nx: { targets: { deploy: {} } }, scripts: { "generate:client": "tool", lint: "tool" },
      dependencies: { "@sample/editor": "1", "@nestjs/common": "11", "@clickhouse/client": "1" }, devDependencies: { "@biomejs/biome": "2" } });
    pkg("apps/excluded/package.json", { scripts: { excluded: "tool" }, dependencies: { "excluded-dep": "1" } });
  };
  it("resolves declared package imports without installed dependencies", () => {
    setup(); expect(paths("@sample/editor", "@sample/editor/subpath")).toEqual([]);
    expect(paths("@sample/absent")).toEqual([]);
    expect(checkDependencies([claim("@sample/absent", "dependency")], root)[0].code).toBe("DEPENDENCY_MISSING");
  });
  it("checks scripts across workspaces, filtered and cd commands, and nx projects", () => {
    setup(); write("apps/api/project.json", '{"name":"api","targets":{"compile":{}}}');
    const commands = ["pnpm generate:client", "pnpm --filter @sample/api generate:client", "pnpm --filter=@sample/api run lint", "cd apps/api && pnpm run generate:client", "nx run api:compile", "nx run api:lint", "nx run api:deploy"];
    expect(checkCommands(commands.map((value) => claim(value, "command")), root)).toEqual([]);
    for (const value of ["pnpm absent", "pnpm --filter @sample/api run absent", "cd apps/api && pnpm run absent", "nx run api:absent", "pnpm excluded"]) {
      expect(checkCommands([claim(value, "command")], root), value).toHaveLength(1);
    }
  });
  it("recognizes display names but retains missing dependencies and workspace exclusions", () => {
    setup();
    expect(checkDependencies(["NestJS", "ClickHouse", "Biome"].map((value) => claim(value, "dependency")), root)).toEqual([]);
    expect(checkDependencies(["absent-dep", "excluded-dep"].map((value) => claim(value, "dependency")), root)).toHaveLength(2);
  });
  it.each(["pnpm", "yarn", "fallback"])("discovers %s manifests", (manager) => {
    pkg("package.json", manager === "yarn" ? { workspaces: { packages: ["services/**"] } } : {});
    if (manager === "pnpm") write("pnpm-workspace.yaml", "packages:\n  - services/**\n");
    pkg("services/deep/api/package.json", { scripts: { nested: "tool" }, optionalDependencies: { optional: "1" }, peerDependencies: { peer: "1" } });
    const repository = new RepositoryInventory(root);
    expect(checkCommands([claim("pnpm run nested", "command")], root, repository)).toEqual([]);
    expect(checkDependencies([claim("optional", "dependency"), claim("peer", "dependency")], root, repository)).toEqual([]);
  });
  it("reports a dependency absent from an empty manifest", () => {
    pkg("package.json", {});
    expect(checkDependencies([claim("absent-package", "dependency")], root)).toHaveLength(1);
  });
  it("extracts package-leading labels, not class names embedded in descriptions", () => {
    write("doc.md", "# Key Libraries\n- **class-validator + framework `InputPipe`** for input\n- **pino via `AppLogger`** for logs\n- **`@sample/actual` + decorators** for docs\n\n`pnpm --filter api run lint`\n`cd apps/api && pnpm run lint`\n`nx run api:lint`\n");
    const claims = extractClaims(join(root, "doc.md"), "doc.md");
    expect(claims.filter((c) => c.kind === "dependency").map((c) => c.value)).toEqual(["@sample/actual"]);
    expect(claims.filter((c) => c.kind === "command")).toHaveLength(3);
  });
});
