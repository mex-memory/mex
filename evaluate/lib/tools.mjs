// Instrumented tool surface for the end-to-end eval. Exposes the same operations
// an agent has — graph scope/get/query/impact plus raw Read/Grep — and records,
// for every call, the number of tokens the result puts into the agent's context.
// Accumulated tokens (not first-response size) is the metric that decides the
// variant winner.

import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { approxTokens, enumerateSource } from "./corpus.mjs";
import { runCli, REPO_ROOT } from "./run-cli.mjs";

/**
 * Build a tool surface bound to `root` and a `variant` (which fixes the --detail
 * used by scope). The returned `log` accumulates one entry per call: the tool
 * name and the tokens its result contributed.
 */
export function makeTools(root = REPO_ROOT, variant = { detail: "minimal" }) {
  const log = [];
  const record = (tool, text) => {
    const tokens = approxTokens(text);
    log.push({ tool, tokens });
    return text;
  };

  const cli = (args) => runCli(args, root).stdout;

  return {
    log,
    scope: (task) => record("scope", cli(["graph", "scope", task, "--detail", variant.detail])),
    get: (ids) => record("get", cli(["graph", "get", ...ids])),
    query: (relation, target) => record("query", cli(["graph", "query", relation, target])),
    impact: (target) => record("impact", cli(["impact", target])),
    read: (path) => {
      try { return record("read", readFileSync(resolve(root, path), "utf-8")); }
      catch { return record("read", ""); }
    },
    // A deliberately simple grep: substring over source files, matching lines only.
    grep: (pattern) => {
      const needle = pattern.toLowerCase();
      const hits = [];
      for (const file of enumerateSource(root)) {
        const lines = readFileSync(file, "utf-8").split("\n");
        lines.forEach((line, i) => {
          if (line.toLowerCase().includes(needle)) hits.push(`${relative(root, file)}:${i + 1}:${line}`);
        });
      }
      return record("grep", hits.join("\n"));
    },
  };
}

/** Summarize a tool log into the metrics that decide the variant winner. */
export function summarizeLog(log) {
  const totalTokens = log.reduce((sum, e) => sum + e.tokens, 0);
  const count = (tool) => log.filter((e) => e.tool === tool).length;
  return {
    totalTokens,
    toolCalls: log.length,
    scopeCalls: count("scope"),
    getCalls: count("get"),
    readGrepFallbacks: count("read") + count("grep"),
  };
}
