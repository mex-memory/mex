import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { readHookErrors } from "../hook-errors.js";

let directory: string, file: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "mex-hook-errors-"));
  file = join(directory, "hook-errors.json");
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

const first = "2026-11-24T08:23:01.123456789Z";
const recent = [
  { at: first, agent: "claude-code", event: "Stop", kind: "busy", detail: "database is locked" },
  { at: "2026-11-25T10:42:00Z", agent: "codex", event: "Stop", kind: "panic", detail: "unexpected result" },
];
const counts = { busy: 1, panic: 1 };
const journal = { version: 1, counts, first, shown_at: "2026-11-25T11:00:00Z", recent };

it("reads sparse counts and keeps recent errors in their recorded order", () => {
  writeFileSync(file, JSON.stringify(journal));
  expect(readHookErrors(directory)).toEqual({ total: 2, announced: 1, counts, first, recent });
});

it("ignores missing files and paths that cannot be read as regular files", () => {
  expect(readHookErrors(directory)).toBeNull();
  mkdirSync(file);
  expect(readHookErrors(directory)).toBeNull();
});

it.each([
  ["malformed JSON", "{"],
  ["an unsupported version", JSON.stringify({ ...journal, version: 2 })],
  ["invalid counts", JSON.stringify({ ...journal, counts: { panic: -1 } })],
  ["an invalid date", JSON.stringify({ ...journal, first: "yesterday" })],
  ["more than 20 recent errors", JSON.stringify({ ...journal, recent: Array(21).fill(recent[0]) })],
])("ignores %s", (_name, text) => {
  writeFileSync(file, text);
  expect(readHookErrors(directory)).toBeNull();
});

it("accepts up to 64 KiB and ignores a file one byte over the limit", () => {
  const text = JSON.stringify(journal);
  writeFileSync(file, text.padEnd(64 << 10));
  expect(readHookErrors(directory)?.total).toBe(2);
  appendFileSync(file, " ");
  expect(readHookErrors(directory)).toBeNull();
});
