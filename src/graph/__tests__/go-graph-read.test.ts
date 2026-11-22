/**
 * The Go graph reader against a graph Node built and published: callers,
 * callees, impact and tests; "no callers" only when every file is indexed;
 * a caller in a file that changed since the build is re-checked and dropped
 * when it no longer holds. Needs Go, like the file index parity test.
 */
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { openRecord } from "../../record/index.js";
import { buildIndex } from "../../file-index/build.js";
import { runGraph, runGraphRefresh } from "../cli-graph.js";
import { graphLocation, readGraphPointer } from "../storage.js";
import { askGraph, renderGraphAnswer } from "../cli-read.js";
import { recordCheck } from "../../knowledge/check.js";
import { parseEntry, serializeEntry, validateEntry, type EntryCheck } from "../../knowledge/entry.js";
import { containedDirectory, createEntryFile, readEntryFile } from "../../knowledge/files.js";
import { upgradeEntryChecks } from "../../knowledge/check-upgrade.js";

const enabled = process.env.MEX_TEST_REAL_HOOK_BINARY === "1" && spawnSync("go", ["version"], { encoding: "utf8" }).status === 0;
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const SHAPES = `export function area(radius: number): number {
  return Math.PI * radius ** 2;
}

export function unit(): number {
  return area(1);
}

export function twice(): number {
  return unit() + unit();
}

export function lonely(): number {
  return 0;
}
`;

const USE = `import { area } from "./shapes";

export function report(): string {
  return String(area(2));
}

export const handlers = [area];
`;

const TEST = `import { area, twice } from "../src/shapes";

export function checksArea(): boolean {
  return area(1) > 3;
}

export function checksTwice(): boolean {
  return twice() > 6;
}
`;

describe.skipIf(!enabled)("graph reads in Go", () => {
  let root: string, checkout: string, hook: string, projectId: string, records: string, home: string;
  const exe = process.platform === "win32" ? ".exe" : "";
  const ask = (question: Parameters<typeof askGraph>[0], name: string) => askGraph(question, name, { root: checkout, binary: hook });

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "mex-graph-read-"));
    vi.stubEnv("MEX_HOME", join(root, "home"));
    checkout = join(root, "repo");
    mkdirSync(join(checkout, "src"), { recursive: true });
    mkdirSync(join(checkout, "test"), { recursive: true });
    git(root, "init", "-q", "repo");
    git(checkout, "config", "core.autocrlf", "false");
    writeFileSync(join(checkout, "src", "shapes.ts"), SHAPES);
    writeFileSync(join(checkout, "src", "use.ts"), USE);
    writeFileSync(join(checkout, "test", "shapes.test.ts"), TEST);
    await runGraph({ root: checkout, json: true });
    // The file index marks test files and re-checks changed ones, as in a real checkout.
    const writer = openRecord({ projectPath: checkout });
    projectId = writer.checkout(checkout)!.project_id;
    records = writer.location.directory;
    home = writer.location.home;
    writer.close();
    await buildIndex({ root: checkout, projectId, recordDirectory: records, workers: 0 });

    hook = join(root, `mex-hook${exe}`);
    await promisify(execFile)("go", ["build", "-o", hook, "./cmd/mex-hook"], {
      cwd: resolve("native"), env: { ...process.env, CGO_ENABLED: "0" }, timeout: 240_000, windowsHide: true,
    });
  }, 300_000);

  afterAll(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("answers callers with real calls kept apart from functions passed as values", () => {
    const answer = ask("callers", "area");
    expect(answer.verdict).toBe("found");
    expect(answer.as_of).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(answer.symbol).toMatchObject({ name: "area", path: "src/shapes.ts", start: 1, end: 3 });
    const sites = answer.sites!.map((site) => `${site.in.name}:${site.kind}`).sort();
    expect(sites).toContain("unit:call");
    expect(sites).toContain("report:call");
  });

  it("answers callees, impact two levels up, and tests by how they reach the symbol", () => {
    expect(ask("callees", "unit").sites!.map((site) => site.in.name)).toEqual(["area"]);
    const impact = ask("impact", "area").sites!.map((site) => site.in.name);
    expect(impact).toEqual(expect.arrayContaining(["unit", "report", "twice"]));
    const tests = ask("tests", "area").tests!.map((t) => `${t.test.name}:${t.reach}`);
    expect(tests).toEqual(expect.arrayContaining(["checksArea:direct"]));
  });

  it("says no callers only when every file is indexed", () => {
    const answer = ask("callers", "lonely");
    expect(answer.verdict).toBe("none");
    expect(renderGraphAnswer(answer).join("\n")).toContain("No callers: every file is indexed and none changed since the build uses it.");
  });

  it("still says none when only docs or files of a kind the graph never builds name it", async () => {
    writeFileSync(join(checkout, "NOTES.md"), "Call `lonely()` once at start.\n");
    writeFileSync(join(checkout, "tool.py"), "lonely()\n");
    try {
      await buildIndex({ root: checkout, projectId, recordDirectory: records, workers: 0 });
      const answer = ask("callers", "lonely");
      expect(answer.verdict).toBe("none");
      expect(answer.changed).toBe(0);
    } finally {
      rmSync(join(checkout, "NOTES.md"));
      rmSync(join(checkout, "tool.py"));
      await buildIndex({ root: checkout, projectId, recordDirectory: records, workers: 0 });
    }
  });

  it("doesn't say none when a file added since the build calls the name", async () => {
    writeFileSync(join(checkout, "src", "late.ts"), `import { lonely } from "./shapes";\nexport const late = lonely();\n`);
    try {
      await buildIndex({ root: checkout, projectId, recordDirectory: records, workers: 0 });
      const answer = ask("callers", "lonely");
      expect(answer.verdict).toBe("unknown");
      expect(answer.changed).toBe(1);
      expect(renderGraphAnswer(answer).join("\n")).toContain("1 file changed since the build use the name");
    } finally {
      rmSync(join(checkout, "src", "late.ts"));
      await buildIndex({ root: checkout, projectId, recordDirectory: records, workers: 0 });
    }
  });

  it("drops a caller whose call is gone though its function is still there", async () => {
    writeFileSync(join(checkout, "src", "use.ts"), USE.replace("return String(area(2));", "return String(2);"));
    try {
      await buildIndex({ root: checkout, projectId, recordDirectory: records, workers: 0 });
      const answer = ask("callers", "area");
      const names = answer.sites!.map((site) => `${site.in.name}:${site.kind}`);
      expect(names).not.toContain("report:call");
      expect(names).toContain("unit:call");
      expect(answer.dropped).toBeGreaterThan(0);
    } finally {
      writeFileSync(join(checkout, "src", "use.ts"), USE);
      await buildIndex({ root: checkout, projectId, recordDirectory: records, workers: 0 });
    }
  });

  it("takes a file or an owner with the name", () => {
    expect(ask("callers", "src/shapes.ts:area").verdict).toBe("found");
    expect(ask("callers", "src/use.ts:area").verdict).toBe("missing");
  });

  it("re-checks a caller in a file changed since the build, and drops it when it no longer holds", () => {
    writeFileSync(join(checkout, "src", "use.ts"), "export const nothing = 1;\n");
    try {
      const answer = ask("callers", "area");
      expect(answer.sites!.map((site) => site.in.name)).not.toContain("report");
      expect(answer.sites!.map((site) => site.in.name)).toContain("unit");
      expect(answer.dropped).toBeGreaterThan(0);
    } finally {
      writeFileSync(join(checkout, "src", "use.ts"), USE);
    }
  });

  it("says a name is missing or names several definitions instead of guessing", () => {
    expect(ask("callers", "doesNotExist").verdict).toBe("missing");
  });

  it("upgrades a note's file-hash check to a fingerprint of the definition it names", () => {
    const options = { projectPath: checkout, env: { ...process.env, MEX_HOOK_BINARY: hook } };
    const source = recordCheck(hook, { checkout, project_id: projectId, record_directory: records, kind: "source", role: "supporting", target: { file: "src/shapes.ts" } }) as EntryCheck;
    const id = "mx_upgrade01";
    const entry = validateEntry({
      mex: { id, kind: "fact", scope: ["src/**"], source: { type: "observed", ref: "test" }, evidence: "observed",
        one_line: "`area` is the circle area.", checks: [source], status: "active", created: "2026-11-20" },
      text: "`area` returns the area of a circle; `unit` calls it with radius 1.",
    });
    const notes = containedDirectory(home, ["projects", projectId, "notes"], true)!;
    createEntryFile(notes, id, serializeEntry(entry));

    const report = upgradeEntryChecks(options);
    expect(report).toMatchObject({ upgraded: 1, checks: 1, fingerprints: 2 });
    const after = parseEntry(readEntryFile(join(notes, `${id}.md`))!);
    expect(after.mex.checks.map((check) => `${check.kind}:${"symbol" in check.target ? check.target.symbol : ""}`).sort()).toEqual(["symbol:area", "symbol:unit"]);
    expect(after.text).toBe(entry.text);
    // Nothing more to do the second time.
    expect(upgradeEntryChecks(options).upgraded).toBe(0);

    // A producer that wrote its checks through the gate keeps them: it re-derives them itself.
    const mined = "mx_fact" + "0".repeat(31) + "1";
    createEntryFile(notes, mined, serializeEntry(validateEntry({
      mex: { id: mined, kind: "pitfall", scope: ["src/**"], source: { type: "mined", ref: "src/shapes.ts", producer: "code-facts" }, evidence: "mined",
        one_line: "`area` is generated; regenerate it.", checks: [source], status: "active", created: "2026-11-20" },
      text: "`area` comes from the generator; edit the template, not `area`.",
    })));
    expect(upgradeEntryChecks(options).upgraded).toBe(0);
    expect(parseEntry(readEntryFile(join(notes, `${mined}.md`))!).mex.checks.map((check) => check.kind)).toEqual(["source"]);
  });

  it("records calls relations from the graph", () => {
    const calls = recordCheck(hook, { checkout, project_id: projectId, record_directory: records, kind: "relation", role: "complete",
      target: { query: "calls", from: "test/**", to: "src/**" } }) as { saw: { count: number } };
    // checksArea calls area; checksTwice calls twice.
    expect(calls.saw.count).toBe(2);
    const none = recordCheck(hook, { checkout, project_id: projectId, record_directory: records, kind: "relation", role: "complete",
      target: { query: "calls", from: "src/**", to: "test/**" } }) as { saw: { count: number } };
    expect(none.saw.count).toBe(0);
  });

  it("reads through an overlay: the edited file's rows replace the base's", async () => {
    writeFileSync(join(checkout, "src", "use.ts"), `${USE}\nexport function again(): number {\n  return area(3);\n}\n`);
    try {
      await runGraphRefresh({ root: checkout, json: true });
      await buildIndex({ root: checkout, projectId, recordDirectory: records, workers: 0 });
      expect(readGraphPointer(graphLocation(checkout))?.overlay).toMatch(/^graph-o-/);
      const callers = ask("callers", "area").sites!.map((site) => site.in.name);
      expect(callers).toEqual(expect.arrayContaining(["again", "report", "unit"]));
      // Each caller once: base rows of the shadowed file are not read as well.
      expect(callers.filter((name) => name === "report")).toHaveLength(1);
    } finally {
      writeFileSync(join(checkout, "src", "use.ts"), USE);
      await buildIndex({ root: checkout, projectId, recordDirectory: records, workers: 0 });
    }
  }, 120_000);
});
