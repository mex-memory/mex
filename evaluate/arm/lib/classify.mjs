// Classify agent tool calls into the categories of the agent-arm test.

export const CATEGORIES = Object.freeze([
  "mex:scope", "mex:exact", "mex:impact", "mex:timeline", "mex:wiki", "mex:maint",
  "knowledge-read", "knowledge-edit", "discovery", "source-read", "test", "edit", "other",
]);

const MEX_INVOCATION = /(?:^|[\s;&|(])(?:npx\s+(?:-y\s+)?mex-agent(?:@\S+)?|mex(?:\.cmd)?|node\s+\S*(?:mex|dist)[\\/]\S*cli\.js)\s+(\S+)(?:\s+(\S+))?/;
const NPX_MEX = /\bnpx\s+(?:-y\s+)?mex-agent\b/;
const TEST_COMMAND = /\b(?:vitest|jest|bun\s+(?:run\s+)?test|npm\s+(?:run\s+)?test|pnpm\s+(?:run\s+)?test|yarn\s+test|tsc)\b/;
const DISCOVERY_COMMAND = /^(?:rg|grep|egrep|find|ls|tree|fd|git\s+grep|git\s+ls-files|dir)\b/;
// A read names a file; a bare `head -20` after a pipe is only a filter.
const READ_COMMAND = /^(?:cat|head|tail|less|more|sed|awk|type|bat|nl|wc|git\s+show)\b(?:\s+-\S+(?:\s+\d+)?)*\s+[^-\s|]/;

const normalizePath = (value) => String(value ?? "").replaceAll("\\", "/");

export function isKnowledgePath(value) {
  return /(?:^|[/\s"'=])\.mex(?:[/\s"']|$)/.test(normalizePath(value));
}

function mexCategory(sub, second) {
  if (sub === "graph" && second === "scope") return "mex:scope";
  if (sub === "graph" && ["query", "get"].includes(second)) return "mex:exact";
  if (sub === "impact") return "mex:impact";
  if (sub === "timeline") return "mex:timeline";
  if (sub === "wiki") return "mex:wiki";
  return "mex:maint";
}

/** Split a shell line into its simple commands, ignoring operators inside quotes. */
export function shellSegments(command) {
  const segments = [];
  let current = "", quote = null;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; current += ch; continue; }
    if (ch === ";" || ch === "\n" || ch === "|" || ch === "&") {
      if (current.trim()) segments.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) segments.push(current.trim());
  return segments.map((segment) => segment.replace(/^(?:cd\s+\S+\s*$|env\s+\S+=\S+\s+|\S+=\S+\s+)+/, "").trim()).filter(Boolean);
}

/** One category per Bash call: the most informative segment wins. */
export function classifyBash(command) {
  const text = String(command ?? "");
  const mex = text.match(MEX_INVOCATION);
  if (mex) return { category: mexCategory(mex[1], mex[2]), npxMex: NPX_MEX.test(text) };
  if (TEST_COMMAND.test(text)) return { category: "test", npxMex: false };
  let best = "other";
  for (const segment of shellSegments(text)) {
    if (READ_COMMAND.test(segment) && !/\bsed\s+-i\b/.test(segment)) {
      return { category: isKnowledgePath(segment) ? "knowledge-read" : "source-read", npxMex: false };
    }
    if (/\bsed\s+-i\b/.test(segment) || /(?:^|\s)>{1,2}\s*\S/.test(segment)) {
      return { category: isKnowledgePath(segment) ? "knowledge-edit" : "edit", npxMex: false };
    }
    if (DISCOVERY_COMMAND.test(segment)) best = isKnowledgePath(segment) ? "knowledge-read" : "discovery";
  }
  return { category: best, npxMex: false };
}

/** Classify a parsed Claude tool call ({ name, input, output }). */
export function classifyCall(call) {
  const input = call.input ?? {};
  switch (call.name) {
    case "Read":
      return { category: isKnowledgePath(input.file_path) ? "knowledge-read" : "source-read", path: normalizePath(input.file_path) };
    case "Grep":
    case "Glob":
      return { category: isKnowledgePath(input.path) || isKnowledgePath(input.pattern) ? "knowledge-read" : "discovery", path: normalizePath(input.path ?? "") };
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit":
      return { category: isKnowledgePath(input.file_path ?? input.notebook_path) ? "knowledge-edit" : "edit", path: normalizePath(input.file_path ?? input.notebook_path) };
    case "Bash": {
      const result = classifyBash(input.command);
      return { ...result, command: String(input.command ?? "") };
    }
    default:
      return { category: "other" };
  }
}

const HASH_FIELD = /\b(?:bodyHash|codeHash|fingerprint)\s*:|\bmh2?:\d+:|\bch1:/;

/** True when an edit tool or shell edit writes grounding hashes by hand. */
export function isHandHashEdit(call) {
  const input = call.input ?? {};
  if (["Edit", "MultiEdit", "Write"].includes(call.name) && isKnowledgePath(input.file_path)) {
    const texts = [input.new_string, input.content, ...(input.edits ?? []).map((edit) => edit.new_string)];
    return texts.some((text) => typeof text === "string" && HASH_FIELD.test(text)
      && !(input.old_string && HASH_FIELD.test(input.old_string) && sameHashes(input.old_string, text)));
  }
  if (call.name === "Bash") {
    const command = String(input.command ?? "");
    return /\bsed\s+-i\b/.test(command) && isKnowledgePath(command) && /(?:bodyHash|codeHash|fingerprint|mh2?:|ch1:)/.test(command);
  }
  return false;
}

function sameHashes(before, after) {
  const pick = (text) => [...text.matchAll(/(?:bodyHash|codeHash|fingerprint)\s*:\s*\S+/g)].map((match) => match[0]).join("\n");
  return pick(before) === pick(after);
}

const OUTPUT_PATH = /(?:"filePath"\s*:\s*"|\b)((?:src|runtime-tests|benchmarks|test|docs)\/[\w./-]+\.\w+)/g;

/**
 * Per-session allocation and fallbacks. A fallback is a discovery call, or a
 * source read of a file no earlier MEX call returned, after the first MEX call.
 */
export function summarizeCalls(toolCalls, subjectRoot = "") {
  const root = normalizePath(subjectRoot).replace(/\/$/, "");
  const byCategory = Object.fromEntries(CATEGORIES.map((name) => [name, { calls: 0, outputChars: 0 }]));
  const classified = [];
  const mexPaths = new Set();
  let firstMexSeen = false;
  let fallbacks = 0, npxMex = 0, handHashEdits = 0, outsideRoot = 0;
  for (const call of toolCalls) {
    const result = classifyCall(call);
    const category = CATEGORIES.includes(result.category) ? result.category : "other";
    const outputChars = typeof call.output === "string" ? call.output.length : 0;
    byCategory[category].calls += 1;
    byCategory[category].outputChars += outputChars;
    let fallback = false;
    if (category.startsWith("mex:")) {
      firstMexSeen = true;
      for (const match of String(call.output ?? "").matchAll(OUTPUT_PATH)) mexPaths.add(match[1]);
    } else if (firstMexSeen && category === "discovery") fallback = true;
    else if (firstMexSeen && category === "source-read") {
      const relative = result.path && root ? normalizePath(result.path).replace(`${root}/`, "") : result.path;
      fallback = !relative || ![...mexPaths].some((path) => relative.endsWith(path));
    }
    if (fallback) fallbacks += 1;
    if (result.npxMex) npxMex += 1;
    const handHash = isHandHashEdit(call);
    if (handHash) handHashEdits += 1;
    const touched = result.path ?? "";
    const outside = Boolean(root && /^(?:[a-zA-Z]:|\/)/.test(touched) && !normalizePath(touched).toLowerCase().startsWith(root.toLowerCase()));
    if (outside) outsideRoot += 1;
    classified.push({ id: call.id ?? null, name: call.name, status: call.status, category, fallback, handHash, outside, path: result.path ?? null, command: result.command ?? null, outputChars });
  }
  const totalCalls = classified.length;
  const totalChars = classified.reduce((sum, entry) => sum + entry.outputChars, 0);
  const allocation = Object.fromEntries(Object.entries(byCategory).map(([name, value]) => [name, {
    ...value,
    callShare: totalCalls ? value.calls / totalCalls : 0,
    charShare: totalChars ? value.outputChars / totalChars : 0,
  }]));
  const mexCalls = classified.filter((entry) => entry.category.startsWith("mex:")).length;
  return { classified, allocation, totalCalls, mexCalls, fallbacks, npxMex, handHashEdits, outsideRoot };
}
