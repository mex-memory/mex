/**
 * Checks for a note written with `mex note`, derived at save time with no
 * model: when the note names a file and a symbol in it, and the symbol's
 * current value appears in the note ("port 3000, set by PORT in
 * src/config.ts"), the note gets a complete value check; a named symbol
 * without a matching value gets a supporting fingerprint; a named package
 * script gets a supporting key check. The native evaluator records each one
 * against today's code, so a later change makes the note changed or broken
 * and delivery holds it back. A note that names nothing checkable keeps no
 * checks and goes to the background filter as before.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { CheckSchema, type EntryCheck } from "./entry.js";
import { nativeBinary } from "./check.js";

const MAX_FILES = 3, MAX_SYMBOLS = 4, MAX_CHECKS = 4, MAX_FILE_BYTES = 512 * 1024;
const PATH = /(?:^|[\s`'"(])((?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]{1,6})(?=$|[\s`'"),.:;])/gu;
const SCRIPT = /\b(?:npm run|npm run-script|pnpm run|pnpm|yarn run|yarn|bun run)\s+([\w:.-]+)|\bnpm (test|start)\b/gu;
const WORDS = new Set(["the", "and", "for", "with", "this", "that", "because", "use", "run", "set", "from", "into", "when", "before", "after"]);

/** A word that reads as code: CONSTANT_CASE, camelCase, snake_case, dotted, or quoted in backticks. */
function codeLike(word: string, quoted: boolean): boolean {
  if (word.length < 3 || WORDS.has(word.toLowerCase())) return false;
  return quoted || /^[A-Z][A-Z0-9_]{2,}$/u.test(word) || /[a-z][A-Z]/u.test(word) || /[a-z]_[a-z]/iu.test(word) || /^[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$.]*$/u.test(word);
}

export function symbolsIn(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/`([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)`/gu)) if (codeLike(m[1], true)) out.add(m[1]);
  for (const m of text.matchAll(/\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\b/gu)) if (codeLike(m[1], false)) out.add(m[1]);
  return [...out];
}

function filesIn(text: string, root: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(PATH)) {
    const ref = m[1].replace(/^\.\//u, "");
    if (ref.includes("..") || out.includes(ref)) continue;
    try { if (statSync(join(root, ref)).isFile()) out.push(ref); } catch { /* not a file here */ }
    if (out.length >= MAX_FILES) break;
  }
  return out;
}

function scriptsIn(text: string, root: string): string[] {
  let scripts: Record<string, unknown> = {};
  try { scripts = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts?: Record<string, unknown> }).scripts ?? {}; } catch { return []; }
  const out = new Set<string>();
  for (const m of text.matchAll(SCRIPT)) {
    const name = m[1] ?? m[2];
    if (name && Object.prototype.hasOwnProperty.call(scripts, name)) out.add(name);
  }
  return [...out];
}

/** The value as the note would write it: `3000`, `"x"` or `x`. */
function valueText(value: unknown): string[] {
  if (typeof value === "number" || typeof value === "boolean") return [String(value)];
  if (typeof value === "string") return value.length >= 2 ? [value] : [];
  return [];
}

interface Item { kind: "value" | "symbol" | "key"; role: "complete" | "supporting"; target: Record<string, string>; }

export function deriveNoteChecks(text: string, root: string, options: { projectId?: string; recordDirectory?: string; env?: NodeJS.ProcessEnv } = {}): EntryCheck[] {
  const binary = nativeBinary(options.env);
  if (!binary) return [];
  const items: Item[] = [];
  const symbols = symbolsIn(text);
  for (const file of filesIn(text, root)) {
    let content = "";
    try { if (statSync(join(root, file)).size <= MAX_FILE_BYTES) content = readFileSync(join(root, file), "utf8"); } catch { continue; }
    for (const symbol of symbols.filter(s => new RegExp(`\\b${s.split(".").at(-1)!.replace(/\$/gu, "\\$")}\\b`, "u").test(content)).slice(0, MAX_SYMBOLS)) {
      items.push({ kind: "value", role: "complete", target: { file, symbol } }, { kind: "symbol", role: "supporting", target: { file, symbol } });
    }
  }
  for (const name of scriptsIn(text, root)) items.push({ kind: "key", role: "supporting", target: { file: "package.json", pointer: `/scripts/${name}` } });
  if (!items.length) return [];
  const result = spawnSync(binary, ["--check-run"], {
    input: JSON.stringify({ action: "record-batch", checkout: root, ...(options.projectId ? { project_id: options.projectId } : {}),
      ...(options.recordDirectory ? { record_directory: options.recordDirectory } : {}), items }),
    encoding: "utf8", timeout: 10_000, windowsHide: true, env: { ...(options.env ?? process.env), MEX_BACKGROUND: "1" },
  });
  let parsed: { ok?: boolean; results?: Array<{ ok?: boolean; check?: unknown }> };
  try { parsed = JSON.parse(result.stdout || "{}") as typeof parsed; } catch { return []; }
  if (!parsed.ok || !Array.isArray(parsed.results)) return [];
  const out: EntryCheck[] = [], valued = new Set<string>();
  parsed.results.forEach((r, i) => {
    const item = items[i]!;
    if (!r.ok || out.length >= MAX_CHECKS) return;
    const check = CheckSchema.safeParse(r.check);
    if (!check.success) return;
    const key = `${item.target.file}#${item.target.symbol ?? item.target.pointer}`;
    if (item.kind === "value") {
      // Complete only when the note states today's value: then a different value means the note is wrong.
      const saw = (check.data as { saw?: { value?: unknown } }).saw?.value;
      if (!valueText(saw).some(v => new RegExp(`(^|[^\\w.])${v.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}([^\\w.]|$)`, "u").test(text))) return;
      valued.add(key);
      out.push(check.data);
    } else if (item.kind === "symbol") {
      if (!valued.has(key)) out.push(check.data);
    } else out.push(check.data);
  });
  return out;
}
