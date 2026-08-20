const SQLITE = /\b(?:sqlite3?|better-sqlite3|graph\.db(?:-wal|-shm)?)\b/i;
const EXECUTABLE_TOOLS = new Set(["Bash", "Read", "Grep", "Glob"]);
const FOLLOWUP_SCOPE_STATUSES = {
  "graph query": new Set(["partial", "degraded", "no-match"]),
  "graph get": new Set(["partial", "degraded"]),
};

export function shellQuote(word) {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
}

export function shellWords(command) {
  const words = [];
  let word = "", quote = null, escaped = false;
  for (const char of command.trim()) {
    if (escaped) { word += char; escaped = false; continue; }
    if (char === "\\" && quote !== "'") { escaped = true; continue; }
    if (quote) { if (char === quote) quote = null; else word += char; continue; }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (/\s/.test(char)) { if (word) { words.push(word); word = ""; } continue; }
    word += char;
  }
  if (quote || escaped) throw new Error("unterminated shell quoting");
  if (word) words.push(word);
  return words;
}

/** Detect shell composition without mistaking quoted/escaped search syntax for a pipe. */
function hasControlOperator(command) {
  let quote = null;
  let escaped = false;
  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    if (escaped) { escaped = false; continue; }
    if (char === "\\" && quote !== "'") { escaped = true; continue; }
    if (quote) {
      if (char === quote) { quote = null; continue; }
      // Command substitution remains active inside double quotes.
      if (quote === '"' && (char === "`" || (char === "$" && command[index + 1] === "("))) return true;
      continue;
    }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (char === "\r" || char === "\n" || char === ";" || char === "|" || char === "<" || char === ">" || char === "`") return true;
    if (char === "&") return true;
    if (char === "$" && command[index + 1] === "(") return true;
  }
  return false;
}

function startsWith(words, prefix) {
  return prefix.every((word, index) => words[index] === word);
}

function containsSequence(words, sequence) {
  if (sequence.length === 0 || sequence.length > words.length) return false;
  return words.some((_, start) => sequence.every((word, offset) => words[start + offset] === word));
}

function unwrapShell(words) {
  const executable = words[0]?.split("/").at(-1);
  if (["bash", "zsh", "sh"].includes(executable) && words[1] === "-lc" && words.length === 3) {
    return shellWords(words[2]);
  }
  return words;
}

const FILE_COMMANDS = new Set(["rg", "grep", "find", "fd", "cat", "head", "tail", "sed", "awk", "ls", "pwd", "wc"]);

function readOnlyFileComposition(command) {
  const segments = [];
  const operators = [];
  let segment = "", quote = null, escaped = false;
  const push = (operator = null) => {
    if (!segment.trim()) return false;
    segments.push(segment.trim());
    segment = "";
    if (operator) operators.push(operator);
    return true;
  };
  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    if (escaped) { segment += char; escaped = false; continue; }
    if (char === "\\" && quote !== "'") { segment += char; escaped = true; continue; }
    if (quote) {
      segment += char;
      if (char === quote) quote = null;
      else if (quote === '"' && (char === "`" || (char === "$" && command[index + 1] === "("))) return null;
      continue;
    }
    if (char === "'" || char === '"') { quote = char; segment += char; continue; }
    if (char === "`" || char === ";" || char === "<" || char === ">" || char === "\r" || char === "\n") return null;
    if (char === "$" && command[index + 1] === "(") return null;
    if (char === "&") {
      if (command[index + 1] !== "&" || !push("&&")) return null;
      index += 1;
      continue;
    }
    if (char === "|") {
      if (command[index + 1] === "|" || !push("|")) return null;
      continue;
    }
    segment += char;
  }
  if (quote || escaped || !push()) return null;
  let commands;
  try { commands = segments.map((value) => shellWords(value)); } catch { return null; }
  const valid = commands.every((words, index) => {
    const executable = words[0]?.split("/").at(-1);
    if (executable === "cd") return index === 0 && words.length === 2 && operators[0] === "&&";
    return FILE_COMMANDS.has(executable);
  });
  return valid ? commands : null;
}

export function isDeniedFileShellAttempt(call, armCommands) {
  if (call?.name !== "Bash" || call.status !== "denied") return false;
  const command = String(call.input?.command ?? "").trim();
  if (!command || SQLITE.test(command)) return false;
  if (hasControlOperator(command)) {
    const commands = readOnlyFileComposition(command);
    if (!commands) return false;
    if (commands.some((words) => Object.values(armCommands).some((prefix) => containsSequence(words, prefix)))) return false;
    return true;
  }
  let words;
  try { words = unwrapShell(shellWords(command)); } catch { return false; }
  if (Object.values(armCommands).some((prefix) => containsSequence(words, prefix))) return false;
  return FILE_COMMANDS.has(words[0]?.split("/").at(-1));
}

function scopeStatus(output) {
  const records = [];
  for (const line of String(output ?? "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch { return null; }
  }
  const terminal = records.at(-1);
  return terminal?.type === "summary" && typeof terminal.status === "string" ? terminal.status : null;
}

function scopeQuery(command) {
  const match = command.match(/\bgraph\s+scope\s+(?:"([^"]*)"|'([^']*)'|([^\n]+?))(?:\s+--|$)/);
  return (match?.[1] ?? match?.[2] ?? match?.[3] ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

export function validateTranscriptPolicy(toolCalls, armId, arm, armCommands, options = {}) {
  const violations = [];
  const graphCommandOwners = Object.entries(armCommands);
  const graphCalls = [];
  for (const call of toolCalls) {
    const serializedInput = JSON.stringify(call.input ?? {});
    // StructuredOutput is Claude's final answer transport, not an executable tool.
    // Prose may legitimately explain graph.db without attempting to inspect it.
    if (EXECUTABLE_TOOLS.has(call.name) && SQLITE.test(serializedInput)) violations.push(`raw SQLite access through ${call.name}`);
    if (isDeniedFileShellAttempt(call, armCommands)) continue;
    if (call.name !== "Bash") continue;
    const command = String(call.input?.command ?? "").trim();
    if (hasControlOperator(command)) { violations.push(`shell control operator: ${command}`); continue; }
    if (SQLITE.test(command)) { violations.push(`raw SQLite access: ${command}`); continue; }
    let words;
    try { words = unwrapShell(shellWords(command)); } catch (error) { violations.push(error.message); continue; }
    const executable = words[0]?.split("/").at(-1);
    const embeddedGraphBinary = graphCommandOwners.find(([, prefix]) => containsSequence(words, prefix) && !startsWith(words, prefix));
    if (embeddedGraphBinary) {
      const [owner] = embeddedGraphBinary;
      violations.push(owner === armId ? `indirect graph binary: ${command}` : `cross-arm binary (${owner}): ${command}`);
      continue;
    }
    if (options.allowFileShell && FILE_COMMANDS.has(executable)) continue;
    if (arm.kind === "grep") { violations.push("grep arm used non-file-search Bash"); continue; }
    const own = armCommands[armId];
    if (!startsWith(words, own)) {
      const crossArm = graphCommandOwners.find(([id, prefix]) => id !== armId && startsWith(words, prefix));
      violations.push(crossArm ? `cross-arm binary (${crossArm[0]}): ${command}` : `unrelated Bash command: ${command}`);
      continue;
    }
    const args = words.slice(own.length);
    const commandKey = args[0] === "impact" ? "impact" : `${args[0] ?? ""} ${args[1] ?? ""}`.trim();
    const allowed = new Set(["graph scope", "graph query", "graph get", "impact"]);
    if (!allowed.has(commandKey)) violations.push(`disallowed graph command: ${command}`);
    else graphCalls.push({ command: commandKey, invocation: command, status: call.status, output: call.output });
  }
  if (arm.kind === "graph" && options.requireGraphFirst !== false && graphCalls[0]?.command !== "graph scope") violations.push("graph arm did not start with graph scope");
  const candidate = arm.role === "patched";
  if (candidate) {
    let latestScopeStatus = null;
    for (const call of graphCalls) {
      if (call.command === "graph scope") {
        latestScopeStatus = call.status === "executed" ? scopeStatus(call.output) : null;
        continue;
      }
      const allowedStatuses = FOLLOWUP_SCOPE_STATUSES[call.command];
      if (allowedStatuses && !allowedStatuses.has(latestScopeStatus)) {
        violations.push(`${call.command} requires a preceding scope summary with status ${[...allowedStatuses].join(", ")} (got ${latestScopeStatus ?? "missing"})`);
      }
    }
    const distinctQueries = new Set(graphCalls.filter((call) => call.command === "graph scope")
      .map((call) => scopeQuery(call.invocation)).filter(Boolean));
    if (distinctQueries.size > 1) violations.push(`candidate used ${distinctQueries.size} distinct graph scope queries; maximum is 1`);
  }
  return violations;
}
