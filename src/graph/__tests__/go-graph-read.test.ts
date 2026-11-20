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
  let root: string, checkout: string, hook: string, projectId: string, records: string;
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
    expect(renderGraphAnswer(answer).join("\n")).toContain("No callers: every file is indexed.");
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
