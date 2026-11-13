import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildIndex } from "../build.js";
import { literalPattern } from "../classify.js";
import { openIndex } from "../read.js";
import { writeShift } from "../shifts.js";
import { checkoutKey, indexDirectory, writePatterns } from "../store.js";
import { realPath } from "../../record/project.js";
import type { OutlineAnswer } from "../read.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const TS = `import { readFile } from "node:fs";
import type { Options } from "./options";
export * from "./types";

export interface Shape {
  area(): number;
}

export class Circle implements Shape {
  radius = 1;
  constructor(radius: number) {
    this.radius = radius;
  }
  area(): number {
    return Math.PI * this.radius ** 2;
  }
}

export function makeCircle(radius: number): Circle {
  return new Circle(radius);
}

export const DEFAULT_RADIUS = 2;
const helper = () => readFile;
export type Size = "s" | "m";
export enum Color { Red, Blue }
namespace Inner {
  export function deep(): void {}
}
export default function main() {}
`;

const TEST_TS = `import { describe, expect, it } from "vitest";
import { makeCircle } from "../src/shapes";

describe("circles", () => {
  it("has an area", () => {
    expect(makeCircle(1).area()).toBeGreaterThan(3);
  });
  it.each([1, 2])("scales %i", (n) => {
    expect(n).toBe(n);
  });
});
`;

const PY = `import os
from typing import List, Optional as Opt

LIMIT = 3

@decorator
def handler(event):
    return event

class Store:
    def get(self, key):
        return key

    def _private(self):
        pass

def test_store():
    assert Store().get(1) == 1
`;

const RS = `use std::collections::{HashMap, HashSet};

pub struct Cache {
    map: HashMap<String, u32>,
}

impl Cache {
    pub fn new() -> Self {
        Cache { map: HashMap::new() }
    }
}

pub trait Store {
    fn get(&self, key: &str) -> Option<u32>;
}

#[test]
fn it_works() {
    assert_eq!(2 + 2, 4);
}
`;

const CS = `using System;
using System.Collections.Generic;

namespace Shop.Orders
{
    public class OrderService
    {
        private readonly int count;
        public string Name { get; set; }

        public OrderService(int count) { this.count = count; }

        public int Total(List<int> items)
        {
            return items.Count;
        }

        [Fact]
        public void Totals() { }
    }
}
`;

let root: string;
let checkout: string;
let records: string;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "mex-file-index-"));
  checkout = join(root, "repo");
  records = join(root, "home");
  mkdirSync(join(checkout, "src"), { recursive: true });
  mkdirSync(join(checkout, "test"), { recursive: true });
  git(root, "init", "-q", "repo");
  git(checkout, "config", "core.autocrlf", "false");
  writeFileSync(join(checkout, ".gitignore"), "ignored.ts\nbuild/\n");
  writeFileSync(join(checkout, "src", "shapes.ts"), TS);
  writeFileSync(join(checkout, "test", "shapes.test.ts"), TEST_TS);
  writeFileSync(join(checkout, "src", "store.py"), PY);
  writeFileSync(join(checkout, "src", "cache.rs"), RS);
  writeFileSync(join(checkout, "src", "Orders.cs"), CS);
  writeFileSync(join(checkout, "src", "index.ts"), "export { makeCircle } from './shapes';\n// moment\nimport moment from 'moment';\n");
  writeFileSync(join(checkout, "README.md"), "# Shapes\nUses moment. And moment again.\n");
  writeFileSync(join(checkout, "ignored.ts"), "export const hidden = 1;\n");
  mkdirSync(join(checkout, "build"));
  writeFileSync(join(checkout, "build", "out.js"), "var x = 1;\n");
  writeFileSync(join(checkout, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1]));
  writeFileSync(join(checkout, "package-lock.json"), "{}\n");
  writeFileSync(join(checkout, "broken.ts"), "export function (\n");
  const directory = indexDirectory(records, "g-test");
  writePatterns(directory, [literalPattern("moment")]);
  await buildIndex({ root: checkout, projectId: "g-test", recordDirectory: records, workers: 0 });
}, 60_000);

afterAll(() => { rmSync(root, { recursive: true, force: true }); });

function reader() {
  const index = openIndex({ recordDirectory: records, projectId: "g-test", checkout });
  if (!index) throw new Error("no index");
  return index;
}

describe("file index build and reads", () => {
  it("outlines TypeScript with exact spans, members, namespaces and exports", () => {
    const index = reader();
    try {
      const answer = index.outline("src/shapes.ts") as OutlineAnswer;
      const brief = answer.symbols.map((item) => `${item.kind} ${item.name} ${item.start}-${item.end}${item.parent === undefined ? "" : ` in ${answer.symbols[item.parent]!.name}`}`);
      expect(brief).toEqual([
        "interface Shape 5-7",
        "class Circle 9-17",
        "property radius 10-10 in Circle",
        "method constructor 11-13 in Circle",
        "method area 14-16 in Circle",
        "function makeCircle 19-21",
        "const DEFAULT_RADIUS 23-23",
        "function helper 24-24",
        "type Size 25-25",
        "enum Color 26-26",
        "namespace Inner 27-29",
        "function deep 28-28 in Inner",
        "function main 30-30",
      ]);
      expect(index.fileInfo("src/shapes.ts")).toMatchObject({ lang: "ts", is_test: false, lines: 30 });
    } finally { index.close(); }
  });

  it("nests describe and it blocks in a test file and flags it as a test", () => {
    const index = reader();
    try {
      const answer = index.outline("test/shapes.test.ts") as OutlineAnswer;
      expect(answer.symbols.map((item) => `${item.kind} ${item.name} ${item.start}-${item.end}`)).toEqual([
        "test circles 4-11", "test has an area 5-7", "test scales %i 8-10",
      ]);
      expect(index.fileInfo("test/shapes.test.ts")).toMatchObject({ is_test: true });
    } finally { index.close(); }
  });

  it("outlines Python, Rust and C#", () => {
    const index = reader();
    try {
      const brief = (path: string) => (index.outline(path) as OutlineAnswer).symbols.map((item) => `${item.kind} ${item.name} ${item.start}-${item.end}`);
      expect(brief("src/store.py")).toEqual([
        "const LIMIT 4-4", "function handler 6-8", "class Store 10-15", "method get 11-12", "method _private 14-15", "test test_store 17-18",
      ]);
      expect(brief("src/cache.rs")).toEqual([
        "struct Cache 3-5", "impl Cache 7-11", "method new 8-10", "trait Store 13-15", "method get 14-14", "test it_works 17-20",
      ]);
      expect(brief("src/Orders.cs")).toEqual([
        "namespace Shop.Orders 4-21", "class OrderService 6-20", "property count 8-8", "property Name 9-9",
        "method OrderService 11-11", "method Total 13-16", "test Totals 18-19",
      ]);
    } finally { index.close(); }
  });

  it("gives a reason for every file it lists but doesn't index, and leaves ignored files out", () => {
    const index = reader();
    try {
      expect(index.outline("logo.png")).toEqual({ path: "logo.png", not_indexed: "binary" });
      expect(index.outline("package-lock.json")).toEqual({ path: "package-lock.json", not_indexed: "ignored" });
      expect(index.outline("broken.ts")).toEqual({ path: "broken.ts", not_indexed: "parse failed" });
      expect(index.outline("ignored.ts")).toEqual({ path: "ignored.ts", not_indexed: "not in the index" });
      expect(index.outline("build/out.js")).toEqual({ path: "build/out.js", not_indexed: "not in the index" });
      expect(index.coverage("**")).toEqual({ files: 11, indexed: 8, not_indexed: { binary: 1, ignored: 1, "parse failed": 1 } });
      expect(index.coverage("src/")).toMatchObject({ files: 5, indexed: 5 });
      expect(index.coverage("nowhere.ts")).toEqual({ files: 0, indexed: 0, not_indexed: {} });
    } finally { index.close(); }
  });

  it("finds files by name, definitions by name, and counts literal patterns in a scope", () => {
    const index = reader();
    try {
      expect(index.filesNamed("shapes.ts")).toEqual(["src/shapes.ts"]);
      expect(index.symbolsNamed("makeCircle")).toEqual([{ path: "src/shapes.ts", start: 19, end: 21, kind: "function" }]);
      expect(index.symbolsNamed("get").map((hit) => hit.path)).toEqual(["src/cache.rs", "src/store.py"]);
      const moment = literalPattern("moment").id;
      expect(index.patternCounts("**", [moment, "punknown"])).toEqual({ [moment]: 5 });
      expect(index.patternCounts("src/**", [moment])).toEqual({ [moment]: 3 });
      expect(index.patternCounts("*.md", [moment])).toEqual({ [moment]: 2 });
    } finally { index.close(); }
  });

  it("accepts absolute paths inside the checkout and refuses ones outside it", () => {
    const index = reader();
    try {
      expect(index.outline(join(checkout, "src", "shapes.ts"))).toMatchObject({ path: "src/shapes.ts" });
      expect(index.outline(join(root, "elsewhere.ts"))).toMatchObject({ not_indexed: "not in the index" });
    } finally { index.close(); }
  });

  it("keeps spans exact through an edit, then drops the shift once the file is re-parsed", async () => {
    const directory = indexDirectory(records, "g-test");
    const key = checkoutKey(realPath(checkout));
    const file = join(checkout, "src", "shapes.ts");
    // Replace the body line of Circle.area (line 15) with two lines, and insert
    // three lines above makeCircle (old line 19). Spans below each change move.
    const lines = TS.split("\n");
    lines.splice(14, 1, "    const r = this.radius;", "    return Math.PI * r * r;");
    lines.splice(18 + 1, 0, "// one", "// two", "// three");
    writeFileSync(file, lines.join("\n"));
    const later = new Date(Date.now() + 5_000);
    utimesSync(file, later, later);
    const { statSync } = await import("node:fs");
    const mtime = statSync(file, { bigint: true }).mtimeNs.toString();
    writeShift(directory, key, { path: "src/shapes.ts", mtime_ns: mtime, ranges: [{ from: 15, to: 15, delta: 1 }, { from: 19, to: 18, delta: 3 }] });

    let index = reader();
    try {
      const answer = index.outline("src/shapes.ts") as OutlineAnswer;
      const spans = Object.fromEntries(answer.symbols.map((item) => [item.name, [item.start, item.end]]));
      expect(spans).toMatchObject({ Shape: [5, 7], Circle: [9, 18], constructor: [11, 13], makeCircle: [23, 25], main: [34, 34] });
      expect(spans.area).toEqual([14, 17]);
      expect(index.symbolsNamed("makeCircle")).toEqual([{ path: "src/shapes.ts", start: 23, end: 25, kind: "function" }]);
    } finally { index.close(); }

    const refreshed = await buildIndex({ root: checkout, projectId: "g-test", recordDirectory: records, workers: 0 });
    expect(refreshed).toMatchObject({ read: 1, parsed: 1, base: "kept", extras: 1 });
    index = reader();
    try {
      const answer = index.outline("src/shapes.ts") as OutlineAnswer;
      expect(answer.dropped).toBe(0);
      expect(answer.symbols.find((item) => item.name === "makeCircle")).toMatchObject({ start: 23, end: 25 });
    } finally { index.close(); }
    expect(readdirSync(join(directory, "shifts", key)).length).toBe(0);
  });

  it("an unknown edit makes the file read as changed until the re-parse", async () => {
    const directory = indexDirectory(records, "g-test");
    const key = checkoutKey(realPath(checkout));
    const file = join(checkout, "src", "store.py");
    writeFileSync(file, `${PY}\ndef more():\n    pass\n`);
    const later = new Date(Date.now() + 10_000);
    utimesSync(file, later, later);
    const { statSync } = await import("node:fs");
    writeShift(directory, key, { path: "src/store.py", mtime_ns: statSync(file, { bigint: true }).mtimeNs.toString(), ranges: [], unknown: true });
    let index = reader();
    try {
      expect(index.outline("src/store.py")).toEqual({ path: "src/store.py", not_indexed: "changed since the last parse" });
      expect(index.coverage("src/store.py")).toMatchObject({ indexed: 0, not_indexed: { "changed since the last parse": 1 } });
      expect(index.symbolsNamed("handler")).toEqual([]);
    } finally { index.close(); }
    await buildIndex({ root: checkout, projectId: "g-test", recordDirectory: records, workers: 0 });
    index = reader();
    try {
      expect((index.outline("src/store.py") as OutlineAnswer).symbols.at(-1)).toMatchObject({ name: "more", start: 20, end: 21 });
    } finally { index.close(); }
  });

  it("a refresh with nothing changed reads no file, and a second checkout reuses the records", async () => {
    const again = await buildIndex({ root: checkout, projectId: "g-test", recordDirectory: records, workers: 0 });
    expect(again).toMatchObject({ read: 0, parsed: 0 });
    const worktree = join(root, "worktree");
    git(checkout, "add", "-A");
    git(checkout, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "all");
    git(checkout, "worktree", "add", "-q", worktree);
    const second = await buildIndex({ root: worktree, projectId: "g-test", recordDirectory: records, workers: 0 });
    expect(second.parsed).toBe(0);
    expect(second.reused).toBeGreaterThan(5);
    const index = openIndex({ recordDirectory: records, projectId: "g-test", checkout: worktree });
    try { expect(index?.symbolsNamed("makeCircle")).toEqual([{ path: "src/shapes.ts", start: 23, end: 25, kind: "function" }]); }
    finally { index?.close(); }
  });

  it("has no answer for a checkout that was never indexed", () => {
    expect(openIndex({ recordDirectory: records, projectId: "g-test", checkout: root })).toBeUndefined();
  });
});

describe("discovery and refresh", () => {
  it("without git, walks the folder and applies every .gitignore below the root", async () => {
    const folder = join(root, "plain");
    mkdirSync(join(folder, "src", "gen"), { recursive: true });
    mkdirSync(join(folder, "node_modules", "dep"), { recursive: true });
    writeFileSync(join(folder, ".gitignore"), "*.log\n/dist/\n");
    writeFileSync(join(folder, "src", ".gitignore"), "gen/\n!keep.log\n");
    writeFileSync(join(folder, "src", "a.ts"), "export const a = 1;\n");
    writeFileSync(join(folder, "src", "keep.log"), "kept\n");
    writeFileSync(join(folder, "src", "gen", "out.ts"), "export const gen = 1;\n");
    writeFileSync(join(folder, "debug.log"), "x\n");
    mkdirSync(join(folder, "dist"));
    writeFileSync(join(folder, "dist", "bundle.js"), "x\n");
    writeFileSync(join(folder, "node_modules", "dep", "index.js"), "x\n");
    const { walk } = await import("../discover.js");
    expect(walk(folder)).toEqual([".gitignore", "src/.gitignore", "src/a.ts", "src/keep.log"]);
    const result = await buildIndex({ root: folder, projectId: "f-plain", recordDirectory: records, workers: 0 });
    expect(result).toMatchObject({ via: "walk", files: 4, indexed: 4 });
  });

  it("a branch switch reads only the files that differ", async () => {
    const repo = join(root, "branches");
    mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "core.autocrlf", "false");
    for (let n = 0; n < 20; n++) writeFileSync(join(repo, `f${n}.ts`), `export function f${n}() { return ${n}; }\n`);
    const commit = (message: string) => { git(repo, "add", "-A"); git(repo, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", message); };
    commit("main");
    git(repo, "checkout", "-q", "-b", "feature");
    writeFileSync(join(repo, "f3.ts"), "export function f3() { return 33; }\nexport const extra = 1;\n");
    writeFileSync(join(repo, "new.ts"), "export const fresh = true;\n");
    commit("feature");
    git(repo, "checkout", "-q", "main");
    const first = await buildIndex({ root: repo, projectId: "g-branches", recordDirectory: records, workers: 0 });
    expect(first).toMatchObject({ files: 20, parsed: 20 });
    git(repo, "checkout", "-q", "feature");
    const switched = await buildIndex({ root: repo, projectId: "g-branches", recordDirectory: records, workers: 0 });
    expect(switched).toMatchObject({ files: 21, read: 2, parsed: 2, unchanged: 19 });
    git(repo, "checkout", "-q", "main");
    const back = await buildIndex({ root: repo, projectId: "g-branches", recordDirectory: records, workers: 0 });
    // f3.ts changes back: read again, but its content is already indexed.
    expect(back).toMatchObject({ files: 20, read: 1, parsed: 0, reused: 1 });
  });
});
