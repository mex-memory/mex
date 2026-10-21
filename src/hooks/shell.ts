/** Bounded shell evidence parsing. It never executes a command. */
import { isAbsolute, relative, resolve } from "node:path";

export function shellSegments(command: string): string[] {
  const out: string[] = [];
  let quote = "", start = 0, escaped = false;
  const bounded = command.slice(0, 64 * 1024);
  for (let i = 0; i < bounded.length; i++) {
    const c = bounded[i]!;
    if (escaped) { escaped = false; continue; }
    if (c === "\\" && quote !== "'") { escaped = true; continue; }
    if (quote) { if (c === quote) quote = ""; continue; }
    if (c === "'" || c === '"') { quote = c; continue; }
    if ("|;&\n".includes(c)) { out.push(bounded.slice(start, i).trim()); start = i + 1; }
  }
  out.push(bounded.slice(start).trim());
  return out.filter(Boolean);
}

export const shellWords = (segment: string): string[] =>
  (segment.match(/"[^"\n]*"|'[^'\n]*'|[^\s]+/g) ?? []).map(t => t.replace(/^["']|["']$/g, ""));

export function bashSearchSegment(command: string): string | null {
  return shellSegments(command).find(segment => /^(?:(?:rg|grep|egrep|fgrep|ag|ack)\s|git\s+grep\s)/.test(segment)) ?? null;
}

export function bashSearchCwd(command: string, root: string): string {
  let cwd = root;
  for (const segment of shellSegments(command)) {
    if (bashSearchSegment(segment) !== null) break;
    const words = shellWords(segment);
    if (words[0] === "cd" && words.length === 2) cwd = resolve(cwd, words[1]!.replace(/^\/([a-z])\//i, "$1:/"));
  }
  return cwd;
}

/** The first search owns the pattern, including when a later segment filters output. */
export function bashSearchPattern(command: string): string {
  const segment = bashSearchSegment(command);
  if (segment === null) return "";
  const tokens = shellWords(segment);
  if (tokens[0] === "git") tokens.shift();
  tokens.shift();
  while (tokens.length) {
    const token = tokens.shift()!;
    if (token === "--" || token === "-e" || token === "--regexp") return tokens.shift() ?? "";
    if (token.startsWith("--regexp=")) return token.slice(9);
    if (/^(--glob|--iglob|--type|--type-not|--max-count|--max-columns|-g|-t|-T|-A|-B|-C|-m|-f|--file)$/.test(token)) { tokens.shift(); continue; }
    if (token.startsWith("-")) continue;
    return token;
  }
  return "";
}

export function shellRelative(root: string, path: string): string | null {
  path = path.replace(/^\/([a-z])\//i, "$1:/");
  const file = relative(root, isAbsolute(path) ? path : resolve(root, path)).replace(/\\/g, "/");
  return file === "" || file === ".." || file.startsWith("../") || isAbsolute(file) || file === ".mex" || file.startsWith(".mex/") ? null : file;
}

export interface ShellRead { file: string; offset?: number; limit?: number; tail?: number }

/** Only explicit file reads; pipelines reading stdin do not invent source ranges. */
export function bashReads(command: string, root: string): ShellRead[] {
  const reads: ShellRead[] = [];
  let cwd = root;
  for (const segment of shellSegments(command)) {
    const words = shellWords(segment);
    const program = words.shift();
    if (program === "cd" && words.length === 1) { cwd = resolve(cwd, words[0]!.replace(/^\/([a-z])\//i, "$1:/")); continue; }
    if (!["sed", "head", "tail", "cat", "nl"].includes(program ?? "")) continue;
    if (/[<>`]|\$\(/.test(segment)) continue;
    let offset: number | undefined, limit: number | undefined, tail: number | undefined;
    if (program === "sed") {
      if (words[0] !== "-n") continue;
      words.shift();
      const range = /^(\d+)(?:,(\d+))?p$/.exec(words.shift() ?? "");
      if (!range) continue;
      offset = Number(range[1]); limit = Number(range[2] ?? range[1]) - offset + 1;
      if (offset < 1 || limit < 1) continue;
    } else if (program === "head" || program === "tail") {
      let count = 10;
      if (words[0] === "-n") { words.shift(); count = Number(words.shift()); }
      else if (/^-\d+$/.test(words[0] ?? "")) count = -Number(words.shift());
      else if (/^--lines=/.test(words[0] ?? "")) count = Number(words.shift()!.slice(8));
      else if (words[0]?.startsWith("-") && words[0] !== "--") continue;
      if (!Number.isSafeInteger(count) || count <= 0) continue;
      // Tail offsets need the source length; no guessed range is passed on.
      if (program === "head") { offset = 1; limit = count; }
      else tail = count;
    }
    for (let i = 0; i < words.length && reads.length < 20; i++) {
      const word = words[i]!;
      if (["-b", "-s", "-w", "-v", "-i"].includes(word) && program === "nl") { i++; continue; }
      if (word.startsWith("-")) continue;
      const file = shellRelative(root, resolve(cwd, word.replace(/^\/([a-z])\//i, "$1:/")));
      if (file !== null) reads.push({ file, ...(offset === undefined ? {} : { offset, limit }), ...(tail === undefined ? {} : { tail }) });
    }
  }
  return reads;
}
