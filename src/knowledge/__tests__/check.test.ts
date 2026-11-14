import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { formatCheck, recordCheck, runCheck, storeGates, type CheckReport } from "../check.js";
import { serializeEntry, type EntryCheck, type KnowledgeEntry } from "../entry.js";
import { references } from "../references.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); });
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

function repo(): { root: string; home: string } {
  const base = mkdtempSync(join(tmpdir(), "mex-check-"));
  roots.push(base);
  const root = join(base, "repo"), home = join(base, "home");
  mkdirSync(root);
  git(base, "init", "-q", "repo");
  git(root, "config", "user.email", "t@example.test"); git(root, "config", "user.name", "T"); git(root, "config", "core.autocrlf", "false");
  vi.stubEnv("MEX_HOME", home);
  return { root, home };
}

function entry(id: string, oneLine: string, checks: EntryCheck[] = [], extra: Partial<KnowledgeEntry["mex"]> = {}): KnowledgeEntry {
  return {
    mex: { id, kind: "fact", scope: ["**"], source: { type: "config", ref: "package.json" }, evidence: "mined", one_line: oneLine, checks, status: "active", created: "2026-11-14", ...extra },
    text: `${oneLine} Recorded for the check tests.`,
  };
}

function writeTeam(root: string, e: KnowledgeEntry): void {
  mkdirSync(join(root, ".mex", "learned"), { recursive: true });
  writeFileSync(join(root, ".mex", "learned", `${e.mex.id}.md`), serializeEntry(e));
}

describe("store gates", () => {
  it("flags secrets, hidden characters, duplicates and broken files; only proven ones count", () => {
    const { root } = repo();
    writeTeam(root, entry("mx_secret1", "The deploy key is configured."));
    const secretFile = join(root, ".mex", "learned", "mx_secret1.md");
    writeFileSync(secretFile, serializeEntry(entry("mx_secret1", "The deploy key is configured.")).replace("Recorded", "token: ghp_abcdefghijklmnopqrstuvwxyz123456 Recorded"));
    writeTeam(root, entry("mx_dupe0001", "Same claim."));
    writeTeam(root, entry("mx_dupe0002", "Same claim."));
    writeFileSync(join(root, ".mex", "learned", "mx_hidden1.md"), serializeEntry(entry("mx_hidden1", "Hidden.")).replace("Recorded", "Re​corded"));
    writeFileSync(join(root, ".mex", "learned", "mx_broken1.md"), "not an entry");
    const files = ["mx_secret1", "mx_dupe0001", "mx_dupe0002", "mx_hidden1", "mx_broken1"].map(id => ({ path: join(root, ".mex", "learned", `${id}.md`), level: "team" as const }));
    const findings = storeGates(files, references(root));
    const by = (text: string) => findings.find(f => f.message.includes(text));
    expect(by("secret")?.proven).toBe(true);
    expect(by("hidden")?.proven).toBe(true);
    expect(by("same as mx_dupe0001")?.proven).toBe(false);
    expect(by("not a valid entry")?.proven).toBe(true);
  });
});

describe("mex check without the native binary", () => {
  it("lists entries as unknown, says why, and passes a clean store", () => {
    const { root } = repo();
    writeTeam(root, entry("mx_plain01", "The API uses date-fns."));
    const report = runCheck({ projectPath: root, binary: null });
    expect(report.source).toBe("none");
    expect(report.entries.map(e => [e.id, e.verdict])).toEqual([["mx_plain01", "unknown"]]);
    expect(report.ok).toBe(true);
    expect(formatCheck(report, root)).toContain("native binary");
  });
  it("prints no score", () => {
    const report: CheckReport = { ok: true, source: "native", entries: [], counts: { held: 3, changed: 1, broken: 0, unknown: 0 }, findings: [], problems: 0 };
    report.entries.push({ id: "mx_a00001", level: "team", path: "x", kind: "fact", verdict: "held", one_line: "x", checks: [] });
    expect(formatCheck(report, "/")).toMatch(/^3 held, 1 being checked, 0 withheld, 0 unknown/u);
    expect(formatCheck(report, "/")).not.toMatch(/\/100|score/u);
  });
});

// The real evaluator. Building Go is slow, so this runs where the Go CI job
// sets MEX_TEST_REAL_HOOK_BINARY=1.
const enabled = process.env.MEX_TEST_REAL_HOOK_BINARY === "1" && spawnSync("go", ["version"], { encoding: "utf8" }).status === 0;
describe.skipIf(!enabled)("mex check with the native evaluator", () => {
  let binary: string;
  beforeAll(() => {
    const dir = mkdtempSync(join(tmpdir(), "mex-check-bin-"));
    roots.push(dir);
    binary = join(dir, `mex-hook${process.platform === "win32" ? ".exe" : ""}`);
    execFileSync("go", ["build", "-o", binary, "./cmd/mex-hook"], { cwd: resolve(__dirname, "../../../native"), timeout: 240_000, stdio: "pipe" });
  }, 300_000);

  const cors = "const defaults = {\n  allowMethods: ['GET', 'HEAD', 'PUT', 'POST', 'DELETE', 'PATCH'],\n}\nexport const cors = () => defaults\n";

  function setup() {
    const { root } = repo();
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "cors.ts"), cors);
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "tsc && vitest" } }, null, 2));
    const value = recordCheck(binary, { checkout: root, kind: "value", role: "complete", target: { file: "src/cors.ts", symbol: "defaults.allowMethods" } }) as EntryCheck;
    const key = recordCheck(binary, { checkout: root, kind: "key", role: "complete", target: { file: "package.json", pointer: "/scripts/test" } }) as EntryCheck;
    writeTeam(root, entry("mx_cors001", "cors() allows GET, HEAD, PUT, POST, DELETE and PATCH by default.", [value]));
    writeTeam(root, entry("mx_test001", "The test script type-checks, then runs vitest.", [key]));
    writeTeam(root, entry("mx_moment1", "Dates use date-fns, not moment.", [], { kind: "rule", scope: ["src/**"], when: [{ type: "anti", match: "literal", pattern: "from 'moment'" }] }));
    git(root, "add", "."); git(root, "commit", "-q", "-m", "base");
    return root;
  }

  it("the cors demo: a reformatted list stays held, a changed list is withheld and fails the run", () => {
    const root = setup();
    let report = runCheck({ projectPath: root, binary });
    expect(report.source).toBe("native");
    expect(report.counts).toMatchObject({ held: 2, unknown: 1, broken: 0 });
    expect(report.ok).toBe(true);

    writeFileSync(join(root, "src", "cors.ts"), cors.replace("['GET', 'HEAD', 'PUT', 'POST', 'DELETE', 'PATCH']", '[\n    "GET", "HEAD", "PUT",\n    "POST", "DELETE", "PATCH", // all of them\n  ]'));
    report = runCheck({ projectPath: root, binary });
    expect(report.entries.find(e => e.id === "mx_cors001")?.verdict).toBe("held");

    writeFileSync(join(root, "src", "cors.ts"), cors.replace("'PATCH']", "'PATCH', 'OPTIONS']"));
    report = runCheck({ projectPath: root, binary });
    const cors001 = report.entries.find(e => e.id === "mx_cors001")!;
    expect(cors001.verdict).toBe("broken");
    expect(cors001.checks[0]).toMatchObject({ status: "fail", now: ["GET", "HEAD", "PUT", "POST", "DELETE", "PATCH", "OPTIONS"] });
    expect(report.ok).toBe(false);
    expect(formatCheck(report, root)).toContain("withheld");
  });

  it("--diff flags a change that breaks a team entry or adds a ruled-out pattern, and stores nothing", () => {
    const root = setup();
    git(root, "checkout", "-q", "-b", "feature");
    expect(runCheck({ projectPath: root, binary, diff: "HEAD" }).ok).toBe(true);

    writeFileSync(join(root, "src", "dates.ts"), "import m from 'moment'\nexport const now = () => m()\n");
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "vitest" } }, null, 2));
    git(root, "add", "."); git(root, "commit", "-q", "-m", "change");
    const branchBase = git(root, "rev-parse", "HEAD~1").trim();
    const report = runCheck({ projectPath: root, binary, diff: branchBase });
    expect(report.ok).toBe(false);
    expect(report.findings.filter(f => f.proven).map(f => f.id).sort()).toEqual(["mx_moment1", "mx_test001"]);
  });

  it("--diff doesn't blame a branch for an entry it didn't touch", () => {
    const root = setup();
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "jest" } }, null, 2));
    git(root, "commit", "-qam", "already stale on the default branch");
    git(root, "checkout", "-q", "-b", "docs");
    writeFileSync(join(root, "README.md"), "Docs only.\n");
    git(root, "add", "."); git(root, "commit", "-q", "-m", "docs");
    const report = runCheck({ projectPath: root, binary, diff: "HEAD~1" });
    expect(report.entries.find(e => e.id === "mx_test001")?.verdict).toBe("broken");
    expect(report.ok).toBe(true);
  });

  it("refuses to record a check that doesn't pass today", () => {
    const root = setup();
    expect(() => recordCheck(binary, { checkout: root, kind: "key", role: "complete", target: { file: "package.json", pointer: "/scripts/lint" } })).toThrow(/scripts\/lint/u);
  });
});
