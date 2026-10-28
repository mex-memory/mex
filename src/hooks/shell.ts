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
  return shellSegments(command).find(segment => /^(?:(?:rg|grep|egrep|fgrep|ag|ack)\s|git\s+grep\s)/.test(segment) || /^(?:Select-String|sls)\s/i.test(segment)) ?? null;
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
  if (/^(?:Select-String|sls)$/i.test(tokens[0] ?? "")) {
    const at = tokens.findIndex(t => /^-Pattern$/i.test(t));
    if (at >= 0) return tokens[at + 1] ?? "";
    tokens.shift();
    while (tokens.length) {
      const token = tokens.shift()!;
      if (/^-(?:LiteralPath|Path|Encoding|Context)$/i.test(token)) { tokens.shift(); continue; }
      if (!token.startsWith("-")) return token;
    }
    return "";
  }
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
export function bashReads(command: string, root: string, precisePipes = false): ShellRead[] {
  // Codex commonly numbers a file before slicing it. Only this exact, single-file
  // pipeline proves a range; compound/multi-file pipelines keep the old parser.
  const slice = precisePipes ? /^(?:nl\s+-ba|cat)\s+("[^"\n]+"|'[^'\n]+'|[^\s|;]+)\s*\|\s*sed\s+-n\s+(['"]?)(\d+)(?:,(\d+))?p\2\s*$/.exec(command.trim()) : null;
  if (slice) {
    const offset = Number(slice[3]), end = Number(slice[4] ?? slice[3]);
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(end) || offset < 1 || end < offset) return [];
    const path = slice[1]!.replace(/^["']|["']$/g, "");
    const file = shellRelative(root, path);
    return file === null ? [] : [{ file, offset, limit: end - offset + 1 }];
  }
  const powershell = powershellReads(command, root);
  if (powershell !== null) return powershell;
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

/** Literal PowerShell reads only. No expansion, script blocks, globs or execution. */
export function powershellReads(command: string, root: string): ShellRead[] | null {
  if (!/(?:^|[;(\s])(?:Get-Content|gc|type)\s|(?:^|[;(\s])cat\s.*(?:-(?:Path|TotalCount|Head|First|Tail)\b|\|\s*Select-Object)|\bSelect-Object\s+-(?:First|Last)/i.test(command)) return null;
  const out: ShellRead[] = [];
  let cwd = root;
  const segments = shellSegments(command);
  for (let s = 0; s < segments.length && out.length < 20; s++) {
    let segment = segments[s]!;
    if (/[<>`$*?{}]/.test(segment)) continue;
    let offset: number | undefined, limit: number | undefined, tail: number | undefined;
    const indexed = /^\((.+)\)\[(\d+)\.\.(\d+)\]$/.exec(segment);
    if (indexed) {
      const a = Number(indexed[2]), b = Number(indexed[3]);
      if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || b < a) continue;
      segment = indexed[1]!; offset = a + 1; limit = b - a + 1;
    }
    const words = shellWords(segment);
    const program = words.shift() ?? "";
    if (/^(?:cd|Set-Location)$/i.test(program) && words.length === 1) { cwd = resolve(cwd, words[0]!); continue; }
    if (!/^(?:Get-Content|gc|cat|type)$/i.test(program)) continue;
    const files: string[] = [];
    let valid = true;
    for (let i = 0; i < words.length; i++) {
      const word = words[i]!;
      if (/^-(?:Path|LiteralPath)$/i.test(word)) {
        if (!words[i + 1] || words[i + 1]!.startsWith("-")) { valid = false; break; }
        files.push(words[++i]!);
      } else if (/^-(?:TotalCount|Head|First|Tail)$/i.test(word)) {
        const count = Number(words[++i]);
        if (!Number.isSafeInteger(count) || count <= 0 || offset !== undefined || tail !== undefined) { valid = false; break; }
        if (/^-Tail$/i.test(word)) tail = count;
        else { offset = 1; limit = count; }
      } else if (word.startsWith("-")) { valid = false; break; }
      else files.push(word);
    }
    const select = /^Select-Object\s+-(First|Last)\s+(\d+)$/i.exec(segments[s + 1] ?? "");
    if (select) {
      s++;
      const count = Number(select[2]);
      if (!Number.isSafeInteger(count) || count <= 0 || tail !== undefined) valid = false;
      else if (offset !== undefined && limit !== undefined) {
        if (select[1]!.toLowerCase() === "last") offset += Math.max(0, limit - count);
        limit = Math.min(limit, count);
      } else if (select[1]!.toLowerCase() === "first") { offset = 1; limit = count; }
      else tail = count;
    } else if (/^Select-Object\b/i.test(segments[s + 1] ?? "")) valid = false;
    if (!valid) continue;
    for (const path of files) {
      if (out.length >= 20) break;
      const file = shellRelative(root, resolve(cwd, path));
      if (file !== null) out.push({ file, ...(offset === undefined ? {} : { offset, limit }), ...(tail === undefined ? {} : { tail }) });
    }
  }
  return out;
}

/** Codex wraps some tool results; Claude's stdout object still uses the same body. */
export function shellOutput(response: unknown): string {
  const body = typeof response === "string" ? response : response && typeof response === "object" && "stdout" in response && typeof response.stdout === "string" ? response.stdout : "";
  return body.replace(/^Exit code: -?\d+\r?\nWall time: [^\r\n]*\r?\nOutput:\r?\n/, "");
}
