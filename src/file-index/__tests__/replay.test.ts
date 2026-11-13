import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { rangesFromStructuredPatch, rangesFromUnifiedDiff, replayEdit } from "../replay.js";
import type { ShiftRange } from "../shifts.js";

/** A small seeded generator, so every run replays the same edits. */
function random(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Edit { after: string; ranges: ShiftRange[] }

/**
 * Edits an agent makes that keep the file parseable: comment lines inserted,
 * a blank line removed, a comment line turned into two. Each is applied in one
 * or two places at once, as a multi-hunk patch would be.
 */
function makeEdit(text: string, comment: string, next: () => number): Edit {
  const lines = text.split("\n");
  const changes: Array<{ at: number; remove: number; add: string[] }> = [];
  const count = next() < 0.25 ? 2 : 1;
  for (let attempt = 0; changes.length < count && attempt < 50; attempt++) {
    const at = Math.floor(next() * lines.length);
    if (changes.some((change) => Math.abs(change.at - at) < 3)) continue;
    const line = lines[at] ?? "";
    const kind = next();
    if (kind < 0.5) changes.push({ at, remove: 0, add: Array.from({ length: 1 + Math.floor(next() * 3) }, () => `${comment} replayed edit`) });
    else if (line.trim() === "") changes.push({ at, remove: 1, add: [] });
    else if (line.trim().startsWith(comment)) changes.push({ at, remove: 1, add: [line, `${line.match(/^\s*/)![0]}${comment} and one more`] });
  }
  changes.sort((a, b) => a.at - b.at);
  const ranges: ShiftRange[] = [];
  const out: string[] = [];
  let cursor = 0;
  for (const change of changes) {
    out.push(...lines.slice(cursor, change.at));
    out.push(...change.add);
    cursor = change.at + change.remove;
    const from = change.at + 1;
    // Turning one comment line into the same line plus another is an insertion after it.
    if (change.remove === 1 && change.add.length === 2 && change.add[0] === lines[change.at]) ranges.push({ from: from + 1, to: from, delta: 1 });
    else ranges.push({ from, to: from + change.remove - 1, delta: change.add.length - change.remove });
  }
  out.push(...lines.slice(cursor));
  return { after: out.join("\n"), ranges };
}

function sourceFiles(): string[] {
  const root = resolve("src");
  const found: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory).sort()) {
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) { if (entry !== "__tests__") walk(path); }
      else if (/\.tsx?$/.test(entry)) found.push(path);
    }
  };
  walk(root);
  return found.filter((_, index) => index % Math.max(1, Math.floor(found.length / 40)) === 0).slice(0, 40);
}

const PY = `import os

@decorator
def handler(event):
    # handle it
    return event


class Store:
    """A store."""

    def get(self, key):
        # look it up
        value = key

        return value

    def put(self, key, value):
        pass


def test_store():
    assert Store().get(1) == 1
`;

const RS = `use std::collections::HashMap;

// A cache.
pub struct Cache {
    map: HashMap<String, u32>,
}

impl Cache {
    // Make one.
    pub fn new() -> Self {
        Cache { map: HashMap::new() }
    }

    pub fn get(&self, key: &str) -> Option<u32> {
        // read
        self.map.get(key).copied()
    }
}

#[test]
fn it_works() {
    assert_eq!(2 + 2, 4);
}
`;

const CS = `using System;

namespace Shop
{
    // Orders.
    public class Orders
    {
        // count
        private int count;

        public int Total()
        {
            // sum
            return count;
        }

        [Fact]
        public void Totals() { }
    }
}
`;

describe("replaying edits keeps every span exact", () => {
  it("over seeded edits to real source files and to Python, Rust and C#", async () => {
    const next = random(20261113);
    const inputs: Array<{ path: string; text: string; comment: string }> = [
      ...sourceFiles().map((path) => ({ path: relative(resolve("."), path).split("\\").join("/"), text: readFileSync(path, "utf8").replace(/\r\n/g, "\n"), comment: "//" })),
      { path: "fixture/store.py", text: PY, comment: "#" },
      { path: "fixture/cache.rs", text: RS, comment: "//" },
      { path: "fixture/Orders.cs", text: CS, comment: "//" },
    ];
    let edits = 0, compared = 0, dropped = 0, skipped = 0;
    const mismatches: string[] = [];
    for (const input of inputs) {
      let text = input.text;
      for (let step = 0; step < 12; step++) {
        const edit = makeEdit(text, input.comment, next);
        if (edit.ranges.length === 0) continue;
        const result = await replayEdit(input.path, text, edit.after, edit.ranges);
        edits++;
        if (result.skipped) { skipped++; } else {
          compared += result.compared;
          dropped += result.dropped;
          for (const miss of result.mismatches) mismatches.push(`${input.path} step ${step}: ${miss.kind} ${miss.name} shifted ${miss.shifted} parsed ${miss.parsed}`);
        }
        text = edit.after;
      }
    }
    expect(mismatches).toEqual([]);
    expect(edits).toBeGreaterThan(400);
    expect(compared).toBeGreaterThan(5000);
    expect(skipped).toBe(0);
    // Comment and blank-line edits rarely touch a symbol's first or last line.
    expect(dropped / (compared + dropped)).toBeLessThan(0.05);
  }, 120_000);

  it("reads ranges from Claude Code's structured patch and from git's zero-context diff", () => {
    expect(rangesFromStructuredPatch([{ oldStart: 10, lines: [" a", " b", " c", "-d", "+e", "+f", " g", "+h", " i"] }])).toEqual([
      { from: 13, to: 13, delta: 1 }, { from: 15, to: 14, delta: 1 },
    ]);
    expect(rangesFromUnifiedDiff("@@ -3 +3,2 @@\n-x\n+y\n+z\n@@ -9,0 +11,2 @@\n+n\n+m\n@@ -20,2 +23,0 @@\n-p\n-q\n")).toEqual([
      { from: 3, to: 3, delta: 1 }, { from: 10, to: 9, delta: 2 }, { from: 20, to: 21, delta: -2 },
    ]);
  });
});
