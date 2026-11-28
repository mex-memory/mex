import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { writeCheckout } from "../store.js";

const roots: string[] = [];
const key = "0123456789abcdef01234567";

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 });
});

function longIndex(): string {
  const root = mkdtempSync(join(tmpdir(), "mex-long-"));
  roots.push(root);
  // The shortest stamp still makes the journal path (file plus "-journal") cross the Windows limit.
  // The snapshot file itself stays short enough to open.
  const shortest = `c-${key}-${"s".repeat(10)}.db.tmp`;
  const extra = 252 - join(root, shortest).length;
  const dir = extra > 1 ? join(root, "d".repeat(extra - 1)) : root;
  mkdirSync(dir, { recursive: true });
  return dir;
}

it("writes a checkout snapshot when a journal beside it would exceed the Windows path limit", () => {
  const dir = longIndex();
  const pointer = writeCheckout(dir, key, {
    root: dir, via: "walk", paths: [{ path: "a.ts", hash: "abc", lang: "ts", is_test: false, size: 3, mtime_ns: "1", reason: null }],
    extras: [], base: "base-missing.db", patterns: [],
  });
  const file = join(dir, pointer.snapshot);
  expect(`${file}.tmp`.length).toBeGreaterThanOrEqual(252);
  expect(existsSync(file)).toBe(true);
  const db = new DatabaseSync(`${pathToFileURL(file).href}?immutable=1`, { readOnly: true });
  try { expect(db.prepare("SELECT path FROM paths").get()).toEqual({ path: "a.ts" }); }
  finally { db.close(); }
});
