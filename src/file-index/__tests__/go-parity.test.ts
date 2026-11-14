/**
 * Go and Node answer every file-index read the same way, and the real hook
 * keeps outlines exact after an edit. Building Go is slow and CPU-heavy, so
 * this runs only when MEX_TEST_REAL_HOOK_BINARY=1 (the Go CI job sets it).
 */
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { openRecord } from "../../record/index.js";
import { buildIndex } from "../build.js";
import { indexPending, queuePendingRefreshes } from "../pending.js";
import { runPendingInForeground } from "../../record/background.js";
import { literalPattern } from "../classify.js";
import { openIndex, type IndexReader, type OutlineAnswer } from "../read.js";
import { writeShift } from "../shifts.js";
import { checkoutKey, indexDirectory, writePatterns } from "../store.js";
import { realPath, shortHash } from "../../record/project.js";

const enabled = process.env.MEX_TEST_REAL_HOOK_BINARY === "1" && spawnSync("go", ["version"], { encoding: "utf8" }).status === 0;
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const SHAPES = `export interface Shape {
  area(): number;
}

export class Circle implements Shape {
  constructor(private radius: number) {}
  area(): number {
    return Math.PI * this.radius ** 2;
  }
}

export function makeCircle(radius: number): Circle {
  return new Circle(radius);
}

export function unit(): Circle {
  return makeCircle(1);
}
`;

describe.skipIf(!enabled)("file index in Go and Node", () => {
  let root: string, base: string, checkout: string, records: string, projectId: string, peer: string, hook: string;
  const exe = process.platform === "win32" ? ".exe" : "";

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "mex-index-parity-"));
    base = join(root, "home");
    vi.stubEnv("MEX_HOME", base);
    checkout = join(root, "Repo");
    mkdirSync(join(checkout, "src", "Deep"), { recursive: true });
    git(root, "init", "-q", "Repo");
    git(checkout, "config", "core.autocrlf", "false");
    writeFileSync(join(checkout, "src", "Shapes.ts"), SHAPES);
    writeFileSync(join(checkout, "src", "Deep", "store.py"), "import os\n\nclass Store:\n    def get(self, key):\n        return key\n\ndef makeCircle():\n    pass\n");
    writeFileSync(join(checkout, "src", "Deep", "Shapes.ts"), "export const other = 1; // moment\n");
    writeFileSync(join(checkout, "README.md"), "moment and moment\n");
    writeFileSync(join(checkout, "logo.bin"), Buffer.from([1, 0, 2]));
    const writer = openRecord({ projectPath: checkout });
    projectId = writer.checkout(checkout)!.project_id;
    records = writer.location.directory;
    writer.close();
    writePatterns(indexDirectory(records, projectId), [literalPattern("moment"), literalPattern("Circle")]);
    await buildIndex({ root: checkout, projectId, recordDirectory: records, workers: 0 });

    const native = resolve("native");
    const env = { ...process.env, CGO_ENABLED: "0" };
    peer = join(root, `index.test${exe}`);
    hook = join(root, `mex-hook${exe}`);
    // Cold compilers may exceed the worker RPC deadline. Keep the worker's
    // event loop responsive while retaining both compiler timeouts.
    await promisify(execFile)("go", ["test", "-c", "-o", peer, "./index"], { cwd: native, env, timeout: 240_000, windowsHide: true });
    await promisify(execFile)("go", ["build", "-o", hook, "./cmd/mex-hook"], { cwd: native, env, timeout: 240_000, windowsHide: true });
  }, 300_000);

  afterAll(() => {
    vi.unstubAllEnvs();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  function reader(): IndexReader {
    const index = openIndex({ recordDirectory: records, projectId, checkout });
    if (!index) throw new Error("no index");
    return index;
  }

  type Query = { op: string; arg: string; args?: string[] };
  function nodeAnswer(index: IndexReader, query: Query): unknown {
    switch (query.op) {
      case "outline": return index.outline(query.arg);
      case "fileInfo": return index.fileInfo(query.arg);
      case "filesNamed": return index.filesNamed(query.arg);
      case "symbolsNamed": return index.symbolsNamed(query.arg);
      case "patternCounts": return index.patternCounts(query.arg, query.args ?? []);
      case "coverage": return index.coverage(query.arg);
      default: throw new Error(query.op);
    }
  }
  function goAnswers(queries: Query[]): unknown[] {
    const input = join(root, "queries.json"), output = join(root, "answers.json");
    writeFileSync(input, JSON.stringify({ record_directory: records, project_id: projectId, checkout, queries }));
    execFileSync(peer, ["-test.run=^TestPeer$"], { env: { ...process.env, MEX_INDEX_PEER_QUERIES: input, MEX_INDEX_PEER_OUT: output }, stdio: "pipe" });
    return JSON.parse(readFileSync(output, "utf8")) as unknown[];
  }

  it("gives the same answer to every read, with pending shifts applied", () => {
    const directory = indexDirectory(records, projectId);
    const key = checkoutKey(realPath(checkout));
    const mtime = (path: string) => (statSync(join(checkout, path), { bigint: true }).mtimeNs + 1n).toString();
    writeShift(directory, key, { path: "src/Shapes.ts", mtime_ns: mtime("src/Shapes.ts"), ranges: [{ from: 8, to: 8, delta: 2 }] });
    writeShift(directory, key, { path: "src/Deep/Shapes.ts", mtime_ns: mtime("src/Deep/Shapes.ts"), ranges: [], unknown: true });
    const moment = literalPattern("moment").id, circle = literalPattern("Circle").id;
    const queries: Query[] = [
      { op: "outline", arg: "src/Shapes.ts" },
      { op: "outline", arg: join(checkout, "src", "Shapes.ts") },
      { op: "outline", arg: "src/Deep/Shapes.ts" },
      { op: "outline", arg: "src/Deep/store.py" },
      { op: "outline", arg: "logo.bin" },
      { op: "outline", arg: "missing.ts" },
      { op: "outline", arg: join(root, "outside.ts") },
      { op: "fileInfo", arg: "src/Shapes.ts" },
      { op: "fileInfo", arg: "logo.bin" },
      { op: "filesNamed", arg: "Shapes.ts" },
      { op: "filesNamed", arg: "nothing.ts" },
      { op: "symbolsNamed", arg: "makeCircle" },
      { op: "symbolsNamed", arg: "other" },
      { op: "symbolsNamed", arg: "absent" },
      { op: "patternCounts", arg: "**", args: [moment, circle, "pnotcounted0000"] },
      { op: "patternCounts", arg: "src/**", args: [moment] },
      { op: "patternCounts", arg: "*.md", args: [moment, moment] },
      { op: "coverage", arg: "**" },
      { op: "coverage", arg: "src/" },
      { op: "coverage", arg: "src/Deep/Shapes.ts" },
      { op: "coverage", arg: "missing.ts" },
    ];
    const index = reader();
    let node: unknown[];
    try { node = queries.map((query) => nodeAnswer(index, query)); } finally { index.close(); }
    const go = goAnswers(queries);
    queries.forEach((query, at) => expect(go[at], `${query.op} ${query.arg}`).toEqual(JSON.parse(JSON.stringify(node[at]))));
    expect((node[0] as OutlineAnswer).symbols.find((item) => item.name === "makeCircle")).toMatchObject({ start: 14, end: 16 });
    // These shifts were only for this test; the next ones come from the hook.
    rmSync(join(directory, "shifts"), { recursive: true, force: true });
  });

  function runHook(payload: unknown): void {
    const result = spawnSync(hook, ["claude-code", "PostToolUse"], { input: JSON.stringify(payload), env: { ...process.env }, encoding: "utf8" });
    expect(result.status).toBe(0);
  }

  it("the real hook writes a shift from Claude Code's structured patch, and the spans move", () => {
    const file = join(checkout, "src", "Shapes.ts");
    // Two lines become four inside Circle.area's body (old lines 7-8).
    const edited = SHAPES.replace("  area(): number {\n    return Math.PI * this.radius ** 2;\n", "  area(): number {\n    const r = this.radius;\n    const squared = r * r;\n    return Math.PI * squared;\n");
    writeFileSync(file, edited);
    runHook({
      session_id: "s1", transcript_path: "", cwd: checkout, hook_event_name: "PostToolUse", tool_name: "Edit",
      tool_input: { file_path: file, old_string: "    return Math.PI * this.radius ** 2;\n", new_string: "    const r = this.radius;\n    const squared = r * r;\n    return Math.PI * squared;\n" },
      tool_response: { filePath: file, structuredPatch: [{ oldStart: 6, oldLines: 4, newStart: 6, newLines: 6, lines: ["   constructor(private radius: number) {}", "   area(): number {", "-    return Math.PI * this.radius ** 2;", "+    const r = this.radius;", "+    const squared = r * r;", "+    return Math.PI * squared;", "   }", " }"] }] },
    });
    const index = reader();
    try {
      const outline = index.outline("src/Shapes.ts") as OutlineAnswer;
      const spans = Object.fromEntries(outline.symbols.map((item) => [item.name, [item.start, item.end]]));
      expect(spans).toMatchObject({ Shape: [1, 3], Circle: [5, 12], area: [7, 11], makeCircle: [14, 16], unit: [18, 20] });
      expect(outline.dropped).toBe(0);
    } finally { index.close(); }
  });

  it("without a structured patch, the hook places the edit by its new text", () => {
    const file = join(checkout, "src", "Deep", "store.py");
    const before = readFileSync(file, "utf8");
    writeFileSync(file, before.replace("        return key\n", "        value = key\n        return value\n"));
    runHook({
      session_id: "s1", transcript_path: "", cwd: checkout, hook_event_name: "PostToolUse", tool_name: "Edit",
      tool_input: { file_path: file, old_string: "        return key\n", new_string: "        value = key\n        return value\n" },
      tool_response: { filePath: file },
    });
    const index = reader();
    try {
      // The edit changed the last line of Store and get, so their ends are unknown
      // until the re-parse: they are left out, and the function below moves.
      const outline = index.outline("src/Deep/store.py") as OutlineAnswer;
      expect(outline.symbols.map((item) => `${item.name} ${item.start}-${item.end}`)).toEqual(["makeCircle 8-9"]);
      expect(outline.dropped).toBe(2);
    } finally { index.close(); }
  });

  it("a Codex apply_patch is placed by its new text: a comment above unit moves it down one line", () => {
    const file = join(checkout, "src", "Shapes.ts");
    writeFileSync(file, readFileSync(file, "utf8").replace("export function unit(): Circle {\n", "// the unit circle\nexport function unit(): Circle {\n"));
    const patch = `*** Begin Patch\n*** Update File: ${file}\n@@\n-export function unit(): Circle {\n+// the unit circle\n+export function unit(): Circle {\n*** End Patch`;
    const response = "Exit code: 0\nWall time: 0.1 seconds\nOutput:\nSuccess. Updated the following files:\nM src/Shapes.ts\n";
    const result = spawnSync(hook, ["codex", "PostToolUse"], {
      input: JSON.stringify({ session_id: "c1", transcript_path: "", cwd: checkout, hook_event_name: "PostToolUse", tool_name: "apply_patch", tool_input: { command: patch }, tool_response: response }),
      env: { ...process.env }, encoding: "utf8",
    });
    expect(result.status).toBe(0);
    const index = reader();
    try {
      const spans = Object.fromEntries((index.outline("src/Shapes.ts") as OutlineAnswer).symbols.map((item) => [item.name, [item.start, item.end]]));
      expect(spans).toMatchObject({ Circle: [5, 12], makeCircle: [14, 16], unit: [19, 21] });
    } finally { index.close(); }
  });

  it("the background job re-parses the edited files: same spans, shifts cleared", async () => {
    expect(indexPending(records)).toBe(true);
    const writer = openRecord({ projectPath: checkout });
    try {
      expect(queuePendingRefreshes(writer)).toBe(1);
      expect(indexPending(records)).toBe(false);
      expect(await runPendingInForeground(writer, 120_000)).toBeGreaterThan(0);
    } finally { writer.close(); }
    expect(existsSync(join(indexDirectory(records, projectId), "shifts", checkoutKey(realPath(checkout)), shortHash("src/Shapes.ts")))).toBe(false);
    const index = reader();
    try {
      const outline = index.outline("src/Shapes.ts") as OutlineAnswer;
      expect(outline.dropped).toBe(0);
      expect(Object.fromEntries(outline.symbols.map((item) => [item.name, [item.start, item.end]]))).toMatchObject({ Circle: [5, 12], area: [7, 11], makeCircle: [14, 16], unit: [19, 21] });
      expect((index.outline("src/Deep/store.py") as OutlineAnswer).symbols.map((item) => `${item.name} ${item.start}-${item.end}`)).toEqual(["Store 3-6", "get 4-6", "makeCircle 8-9"]);
    } finally { index.close(); }
  });
});
