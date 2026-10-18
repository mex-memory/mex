// Regressions for what the 7-session pilot found in the harness (2026-10-18).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { summarizeContextLog } from "../lib/hooks.mjs";
import { agentDiff } from "../lib/session.mjs";
import { git } from "../lib/workspace.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "arm-pilot-"));

test("the session patch shows only real changes when the agent wrote a whole file back with CRLF", () => {
  // The pilot: an LF checkout (core.autocrlf=false) and a Python script that rewrote features.py with CRLF,
  // which made the patch one whole-file hunk (@@ -1,481 +1,485 @@).
  const root = tmp();
  try {
    git(root, ["init", "-q"]);
    git(root, ["config", "core.autocrlf", "false"]);
    const lines = Array.from({ length: 30 }, (_, i) => `x${i} = ${i}`);
    writeFileSync(join(root, "features.py"), `${lines.join("\n")}\n`);
    writeFileSync(join(root, "kept.txt"), "crlf\r\nfrom the start\r\n");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "base"]);
    lines.splice(10, 0, "has_native_boolean_field = False");
    writeFileSync(join(root, "features.py"), `${lines.join("\r\n")}\r\n`);
    writeFileSync(join(root, "kept.txt"), "crlf\r\nfrom the start\r\nand one more\r\n");
    // Old enough that git trusts the stat data and reads the worktree file instead of the staged blob,
    // which is how the real sessions hit it: that read must see the same line ends as the staging did.
    const past = new Date(Date.now() - 60_000);
    for (const name of ["features.py", "kept.txt"]) utimesSync(join(root, name), past, past);
    const diff = agentDiff(root);
    assert.deepEqual(diff.files.sort(), ["features.py", "kept.txt"]);
    const hunks = diff.patch.split("\n").filter((line) => line.startsWith("@@")).map((line) => line.replace(/ @@.*/, " @@"));
    assert.equal(hunks.length, 2, "one hunk per file, not the whole file");
    assert.match(hunks[0], /^@@ -\d+,\d+ \+\d+,\d+ @@$/);
    assert.ok(!hunks.some((h) => h.startsWith("@@ -1,30 ")), "never a whole-file hunk");
    const changed = diff.patch.split("\n").filter((line) => /^[+-](?![+-]{2} )/.test(line));
    assert.deepEqual(changed, ["+has_native_boolean_field = False", "+and one more\r"], "the agent's line ends are normalised; a CRLF file keeps its own");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the fake agent can report its fact edit as a shell script that names the file", () => {
  const root = tmp();
  try {
    git(root, ["init", "-q"]);
    mkdirSync(join(root, ".mex", "local"), { recursive: true });
    mkdirSync(join(root, ".claude"), { recursive: true });
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "a.py"), "def f():\n    x = 1\n    y = 2\n    z = 3\n    return x\n");
    writeFileSync(join(root, ".mex", "local", "context-index.json"), JSON.stringify({ entities: [{ id: "mx_A", type: "fact", code: ["src/a.py"], symbols: [{ file: "src/a.py", start: 1, end: 5, name: "f" }] }] }));
    // A recording hook stands in for mex-hook.
    writeFileSync(join(root, "record.mjs"), "import { appendFileSync, readFileSync } from 'node:fs'; appendFileSync('payloads.jsonl', readFileSync(0, 'utf8') + '\\n');\n");
    writeFileSync(join(root, ".claude", "settings.json"), JSON.stringify({ hooks: { PostToolUse: [{ matcher: "Edit|Bash", hooks: [{ type: "command", command: `"${process.execPath.replaceAll("\\", "/")}" record.mjs` }] }] } }));
    const agent = fileURLToPath(new URL("fake-hooks-agent.mjs", import.meta.url));
    const result = spawnSync(process.execPath, [agent, "-p", "Fix it. Do not commit."], { cwd: root, encoding: "utf8", env: { ...process.env, FAKE_AGENT_TOUCH_FACT: "1", FAKE_AGENT_SHELL_EDIT: "1" } });
    assert.equal(result.status, 0, result.stderr);
    const payloads = readFileSync(join(root, "payloads.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    assert.deepEqual(payloads.map((p) => p.tool_name), ["Bash"]);
    assert.match(payloads[0].tool_input.command, /p = 'src\/a\.py'/);
    assert.match(readFileSync(join(root, "src", "a.py"), "utf8"), /# fake agent edit inside a linked symbol/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a Stop block that is the session's last Stop is counted as undelivered, and refused regrounds say why", () => {
  const root = tmp();
  try {
    const path = join(root, "context-log.jsonl");
    const block = { event: "stop-block", ms: 150, touched: 2, eligible: [], flagged: ["mx_A", "mx_B"], blocked: true, settle: "started", chars: 200, text: "- mx_A ... - mx_B ..." };
    const settle = { event: "settle", loop: 0, ms: 9000, touched: 2, eligible: 1, flagged: 1, refresh: { code: 0, ms: 5000 }, reground: { ids: 1, ok: 0, failed: 1, ms: 900, refused: [{ id: "mx_A", error: "variable:x is unverified" }] } };
    // The pilot's R2w session: the agent's structured answer ended the session; the block never reached it.
    writeFileSync(path, [block, settle].map((line) => JSON.stringify(line)).join("\n"));
    let summary = summarizeContextLog(path);
    assert.equal(summary.stopBlocks.undelivered, 1);
    assert.equal(summary.settle.count, 1);
    assert.deepEqual(summary.failures[0].refused, [{ id: "mx_A", error: "variable:x is unverified" }]);
    // Answered: another Stop follows the block.
    writeFileSync(path, [block, { event: "stop", ms: 400, touched: 2, eligible: ["mx_A"], flagged: [], settle: "queued" }].map((line) => JSON.stringify(line)).join("\n"));
    summary = summarizeContextLog(path);
    assert.equal(summary.stopBlocks.undelivered, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a non-blocking Stop is never undelivered, and its flagged facts are still counted", () => {
  const root = tmp();
  try {
    const path = join(root, "context-log.jsonl");
    const stop = { event: "stop", ms: 160, touched: 2, eligible: [], flagged: ["mx_A", "mx_B"], settle: "started", blocked: false, unvouched: ["mx_A", "mx_B"] };
    writeFileSync(path, JSON.stringify(stop));
    const summary = summarizeContextLog(path);
    assert.equal(summary.stopBlocks.count, 0);
    assert.equal(summary.stopBlocks.undelivered, 0);
    assert.deepEqual(summary.stopFlagged, ["mx_A", "mx_B"]);
    assert.deepEqual(summary.stopUnvouched, ["mx_A", "mx_B"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
