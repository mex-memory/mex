/**
 * A scripted population agent behind `claude` and `codex` shims (#292).
 *
 * Deterministic, but a real separate process: setup finds it on PATH,
 * launches it with each tool's real headless arguments, decodes its stream
 * and cancels it by killing its process tree. It populates the way the setup
 * prompt asks, through the built CLI: it edits the scaffold, reads a
 * fingerprint with `mex graph scope --fingerprint`, and creates one
 * code-linked fact with `mex wiki apply`. `MEX_E2E_AGENT_STOP` makes it stop
 * and wait to be killed after a named step.
 *
 * Imports nothing from `src`, so the Vitest and Playwright suites share it.
 */
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const SCRIPTED_FACT_TITLE = "Checkout total adds tax to the item sum";
export const SCRIPTED_PATTERN = "patterns/checkout-total.md";
export type ScriptedAgentStop = "placeholders" | "pattern" | "usage-limit";

/** Write the agent and its two shims under `root`; returns the directory to put first on PATH. */
export function installScriptedAgent(root: string, cli: string): string {
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const script = join(root, "agent.mjs");
  writeFileSync(script, agentScript(cli), "utf8");
  for (const provider of ["claude", "codex"] as const) {
    if (process.platform === "win32") {
      writeFileSync(
        join(bin, `${provider}.cmd`),
        `@"${process.execPath}" "${script}" ${provider} %*
`,
        "utf8",
      );
    } else {
      const executable = join(bin, provider);
      writeFileSync(
        executable,
        `#!/bin/sh
exec '${process.execPath}' '${script}' ${provider} "$@"
`,
        "utf8",
      );
      chmodSync(executable, 0o755);
    }
  }
  return bin;
}

/**
 * The agent itself. Plain Node, no dependencies. It logs to
 * `.mex/local/e2e-agent.log` (setup's Git-ignored checkout-local directory)
 * so a test can observe it.
 */
function agentScript(cli: string): string {
  return String.raw`
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const provider = process.argv[2];
const args = process.argv.slice(3);
if (args.includes("--version")) { process.stdout.write("scripted-agent 1.0\n"); process.exit(0); }
const instruction = args.find((value) => /^Read the full .* prompt from /u.test(value));
const expectedFlag = provider === "codex" ? "--json" : "stream-json";
if (!instruction || !args.includes(expectedFlag)) process.exit(2);
const prompt = readFileSync(instruction.split(String.fromCharCode(96))[1], "utf8");
const cli = ${JSON.stringify(cli)};
const mexDir = join(process.cwd(), ".mex");
mkdirSync(join(mexDir, "local"), { recursive: true });
const log = (line) => appendFileSync(join(mexDir, "local", "e2e-agent.log"), line + "\n");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const mex = (...command) => execFileSync(process.execPath, [cli, ...command], { encoding: "utf8", windowsHide: true });
const stop = process.env.MEX_E2E_AGENT_STOP ?? null;
const hangIf = (step) => {
  if (stop !== step) return false;
  log("stopped:" + step);
  // Preserve one unfinished marker so this interrupted unit remains resumable.
  appendFileSync(join(mexDir, "context", "architecture.md"), "\n[YYYY-MM-DD]\n");
  // Setup's cancellation kills this process tree; the deadline only bounds a
  // fixture left behind by a failed assertion.
  setInterval(() => {}, 1000);
  setTimeout(() => process.exit(3), 60_000);
  return true;
};

log("start:" + provider);
log("prompt:" + (/only what is missing|still owes|remaining/iu.test(prompt) ? "resume" : "full"));
if (provider === "codex") {
  send({ type: "thread.started", thread_id: "e2e" });
  send({ type: "turn.started" });
} else {
  send({ type: "system", subtype: "init", cwd: process.cwd(), session_id: "e2e" });
}

function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory() && entry.name !== "local") walk(path);
    else if (entry.isFile() && entry.name.endsWith(".md")) {
      const before = readFileSync(path, "utf8");
      const after = before.replaceAll("[Project Name]", "Checkout").replaceAll("[YYYY-MM-DD]", "2026-10-25");
      if (after !== before) writeFileSync(path, after, "utf8");
    }
  }
}

// A finished setup needs authored knowledge in all seven population files,
// not only filled-in tokens (#304); the agent writes one real sentence each, last of all.
const KNOWLEDGE = "Checkout is a small cart calculator that sums prices and adds 18 percent tax.";
function author(file, anchor) {
  const path = join(mexDir, file);
  const text = readFileSync(path, "utf8");
  if (text.includes(KNOWLEDGE)) return;
  const heading = anchor ? new RegExp("^" + anchor + "[ \t]*\r?\n", "mu").exec(text) : null;
  const next = heading
    ? text.slice(0, heading.index + heading[0].length) + KNOWLEDGE + "\n" + text.slice(heading.index + heading[0].length)
    : text.replace(/\s*$/u, "\n\n" + KNOWLEDGE + "\n");
  writeFileSync(path, next, "utf8");
}

function main() {
  walk(mexDir);
  log("done:placeholders");
  if (stop === "usage-limit") {
    send({ type: "result", subtype: "error_during_execution", is_error: true, result: "You've hit your limit · resets 3pm (UTC)" });
    process.exitCode = 1;
    return false;
  }
  if (hangIf("placeholders")) return false;

  const pattern = join(mexDir, "patterns", "checkout-total.md");
  if (!existsSync(pattern)) {
    writeFileSync(pattern, "---\nname: checkout-total\ndescription: Change how the checkout total is computed.\ntriggers:\n  - \"checkout total\"\nlast_updated: 2026-10-25\n---\n\n# Checkout total\n\nEdit calculateCheckoutTotal() in src/checkout.ts and keep cartTotal() delegating to it.\n", "utf8");
  }
  log("done:pattern");
  if (hangIf("pattern")) return false;

  const architecture = readFileSync(join(mexDir, "context", "architecture.md"), "utf8");
  if (!architecture.includes(${JSON.stringify(SCRIPTED_FACT_TITLE)})) {
    const fact = mex("graph", "scope", "calculateCheckoutTotal", "--fingerprint").split("\n")
      .filter(Boolean).map((line) => JSON.parse(line))
      .find((row) => row.type === "fact" && row.name === "calculateCheckoutTotal");
    const parent = /^mex:\r?\n {2}id: (mx_\w+)/mu.exec(architecture)?.[1];
    const operation = {
      opId: "setup_checkout_total", type: "create-entry",
      actor: { kind: "agent", id: provider }, timestamp: new Date().toISOString(),
      reason: "one entity per code-linked claim",
      payload: {
        file: "context/architecture.md", insertAt: { at: "end-of-file" },
        type: "fact", title: ${JSON.stringify(SCRIPTED_FACT_TITLE)},
        body: "calculateCheckoutTotal() sums the items and adds 0.18 tax.",
        headingDepth: 2, status: "promoted",
        ...(parent ? { relations: [{ type: "refines", target: parent }] } : {}),
        groundsTo: [{ node: fact.id, fingerprint: fact.fingerprint }],
      },
    };
    const file = join(mkdtempSync(join(tmpdir(), "mex-e2e-op-")), "op.json");
    writeFileSync(file, JSON.stringify(operation), "utf8");
    mex("wiki", "apply", file, "--apply");
  }
  log("done:fact");
  // Written last: an agent stopped earlier leaves the files unauthored, so setup must run it again.
  author("AGENTS.md", "## What This Is");
  author("ROUTER.md", "## Current Project State");
  for (const file of ["architecture", "stack", "conventions", "decisions", "setup"]) author("context/" + file + ".md");
  const receipt = /write exactly ([a-f0-9-]+) to (\.mex\/local\/setup-next\/[^ ]+\.done)/u.exec(prompt);
  if (receipt) writeFileSync(join(process.cwd(), receipt[2]), receipt[1]);
  return true;
}

if (main()) {
  if (provider === "codex") send({ type: "turn.completed", usage: {} });
  else send({ type: "result", subtype: "success", is_error: false });
  log("exit:" + provider);
}
`;
}
