#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { shellWords, validateTranscriptPolicy } from "./policy.mjs";

export const BASH_GUARD_DENIAL = "MEX_EVAL_BASH_DENIED";
export const BASH_GUARD_HOOK_NAME = "MEX eval Bash policy guard";

const ALLOWED_BASH_INPUT_FIELDS = new Set(["command", "description", "timeout"]);

function forbiddenInputFields(input) {
  return Object.keys(input).filter((field) => !ALLOWED_BASH_INPUT_FIELDS.has(field));
}

export function guardBashInput(input, command) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { allowed: false, violations: ["invalid PreToolUse input"] };
  }
  if (input.hook_event_name !== "PreToolUse" || input.tool_name !== "Bash") {
    return { allowed: false, violations: ["guard invoked outside Bash PreToolUse"] };
  }
  if (!Array.isArray(command) || command.length === 0 || command.some((part) => typeof part !== "string" || !part)) {
    return { allowed: false, violations: ["missing exact graph-wrapper command"] };
  }
  if (!input.tool_input || typeof input.tool_input !== "object" || Array.isArray(input.tool_input)) {
    return { allowed: false, violations: ["invalid Bash tool input"] };
  }
  const forbidden = forbiddenInputFields(input.tool_input);
  if (forbidden.length) {
    return { allowed: false, violations: [`forbidden Bash input field(s): ${forbidden.sort().join(", ")}`] };
  }
  if (typeof input.tool_input.command !== "string" || !input.tool_input.command.trim()) {
    return { allowed: false, violations: ["missing Bash command"] };
  }
  const call = {
    name: "Bash",
    status: "attempted",
    input: input.tool_input && typeof input.tool_input === "object" ? input.tool_input : {},
  };
  let words;
  try { words = shellWords(String(call.input.command ?? "")); }
  catch { return { allowed: false, violations: ["malformed shell command"] }; }
  if (!command.every((part, index) => words[index] === part)) {
    return { allowed: false, violations: ["graph wrapper must be invoked directly"] };
  }
  const violations = validateTranscriptPolicy(
    [call],
    "guard",
    { kind: "graph", role: "released" },
    { guard: command },
    { requireGraphFirst: false },
  );
  return { allowed: violations.length === 0, violations };
}

function deny(reason) {
  process.stdout.write(`${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `${BASH_GUARD_DENIAL}: ${reason}`,
    },
  })}\n`);
}

function allow() {
  process.stdout.write("{}\n");
}

async function main() {
  try {
    const configPath = process.argv[2];
    if (!configPath) return deny("guard configuration is missing");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    let raw = "";
    for await (const chunk of process.stdin) raw += chunk;
    const decision = guardBashInput(JSON.parse(raw), config.command);
    if (!decision.allowed) deny(decision.violations.join("; "));
    else allow();
  } catch (error) {
    deny(`guard failed closed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) await main();
