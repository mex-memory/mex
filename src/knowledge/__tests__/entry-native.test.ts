import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { KnowledgeError, parseEntry, serializeEntry, type EntryCheck, type KnowledgeEntry } from "../entry.js";
import { observeProposalChecks } from "../gate.js";
import type { ProposedCheck } from "../gate-types.js";

// An entry written here is read by the native hook with another YAML library: both must see the same text.
const failure = vi.hoisted(() => ({ code: "" as string, id: "" }));
vi.mock("../check.js", async load => {
  const real = await load<typeof import("../check.js")>();
  return { ...real, runNative: (binary: string, request: Record<string, unknown>, attempt?: number) => {
    if (failure.code && request.action === "evaluate-snapshot" && String(request.entry).includes(failure.id)) throw new KnowledgeError(failure.code, "fixture failure");
    return real.runNative(binary, request, attempt);
  } };
});

let base: string, binary: string;
beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "mex-entry-native-")));
  binary = join(base, process.platform === "win32" ? "mex-hook.exe" : "mex-hook");
  execFileSync("go", ["build", "-o", binary, "./cmd/mex-hook"], { cwd: resolve("native"), timeout: 240_000, stdio: "pipe" });
}, 300_000);
afterAll(() => rmSync(base, { recursive: true, force: true }));
beforeEach(() => { failure.code = ""; vi.stubEnv("MEX_HOOK_BINARY", binary); });

const region = (text: string) => ({ start: 1, end: text.split("\n").length, text, hash: `sha256:${createHash("sha256").update(text).digest("hex")}` });
function learned(text: string, id = "mx_deep0123456789abcdef0123456789abcdef"): { entry: KnowledgeEntry; check: Extract<ProposedCheck, { kind: "fixture" }> } {
  const check = { kind: "fixture", role: "complete", target: { proves: [0], pairs: [{ path: "a.go", commit: "a".repeat(40),
    before: region(`${text}\nforbidden(x)`), after: region(`${text}\nallowed(x)`) }] }, saw: { ok: true } } as Extract<ProposedCheck, { kind: "fixture" }>;
  const entry = { mex: { id, kind: "rule", status: "active", scope: ["a.go"], source: { type: "review", ref: "https://github.com/acme/app/pull/1", producer: "learn-deeper" },
    evidence: "review", one_line: "Use allowed.", created: "2026-11-23", when: [{ type: "anti", match: "literal", pattern: "forbidden(" }],
    checks: [{ ...check, files: {} } as EntryCheck] }, text: "Use allowed." } as KnowledgeEntry;
  return { entry, check };
}
const observe = (...items: Array<ReturnType<typeof learned>>) => observeProposalChecks(items.map(item => item.check),
  { checkout: base, project_id: "p", mex_home: base, record_directory: base }, process.env, new Map(items.map(item => [item.check, item.entry])));

it.each(Object.entries({
  "tab-indented code": "\tif err != nil {\n\t\treturn err\n\t}", "a blank line, then a tab": "\n\treturn nil", "a tab, then none": "\tx := 1\ny := 2", "a tab on a later line": "func f() {\n\tx()\n}",
  "spaces, then a tab": "  \ta\n  \tb", "leading spaces": "    a\n  b", "a blank line, then spaces": "\n    a\n  b", "trailing spaces and tabs": "a  \nb\t", "a line of tabs": "a\n\t\t\nb",
  "blank lines at the end": "a\n\n\n", "Unicode line breaks": "a b c\u0085d", "a byte-order mark": "﻿a\nb﻿c", "no-break spaces": "a b\nc", "a control character": "a\u0007b\nc", "a lone CR": "a\rb\nc",
  "a document marker": "---\na\n---\nb\n...", "YAML syntax": "- a: b\n# c\n*d\n&e\n!f\n%g\n@h\n|\n>", "quotes and backslashes": "\"a\" 'b' \\n \\\n`c`", "other scripts": "é “x” 日本 👍\nb", "a long line": `${"x".repeat(900)}\nb`,
}))("reads the same text on both sides: %s", (_what, text) => {
  const item = learned(text);
  const raw = serializeEntry(item.entry);
  expect(parseEntry(raw).mex.checks[0]).toEqual(item.entry.mex.checks[0]);
  // The evaluator compares each side's recorded hash and proves the pattern on it.
  expect(observe(item)).toEqual([{ check: expect.objectContaining({ kind: "fixture" }) }]);
});

it("keeps the other entries when the evaluator can't read one", () => {
  const good = learned("a"), bad = learned("b", "mx_deepbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  Object.assign(failure, { code: "CHECKS_FAILED", id: bad.entry.mex.id });
  expect(observe(good, bad)).toEqual([{ check: expect.anything() }, { reason: expect.any(String) }]);
  // An evaluator that gives no answer proves nothing for anyone.
  Object.assign(failure, { code: "CHECKS_UNAVAILABLE", id: bad.entry.mex.id });
  expect(observe(good, bad)).toBeUndefined();
});
