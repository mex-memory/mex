/**
 * `mex check`: per-entry verdicts from the native evaluator, store gates and
 * conformance. No score; it fails only on proven problems.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { findNativeBinary } from "../hooks/shim/binary.js";
import { patternId } from "../file-index/classify.js";
import { indexDirectory, readPatterns, writePatterns } from "../file-index/store.js";
import { openIndex } from "../file-index/read.js";
import { openHooksReadOnly } from "../record/index.js";
import { knowledgeProject, type KnowledgeOptions } from "./context.js";
import { KnowledgeError } from "./contract.js";
import { parseEntry, type KnowledgeEntry } from "./entry.js";
import { readEntryFile } from "./files.js";
import { hasSecret, sanitizeText, stripHidden } from "./gates.js";
import { references, type References } from "./references.js";
import { claimHash } from "./state.js";

export type Verdict = "held" | "changed" | "broken" | "unknown";
type Level = "team" | "personal" | "hint";

export interface CheckResult { index: number; kind: string; role: string; status: "pass" | "fail" | "gone" | "floor"; reason?: string; now?: unknown; files_changed?: string[]; }
interface NativeItem { id: string; level: Level; path: string; kind: string; status: string; verdict: Verdict; }
interface NativeReport {
  ok: true; stored: boolean; items: NativeItem[] | null;
  results: Array<{ entry_id: string; verdict: Verdict; checks: CheckResult[] }> | null;
  problems: Array<{ level: Level; path: string; error: string }> | null;
}

export interface CheckedEntry {
  id: string; level: Level; path: string; kind: string; verdict: Verdict; one_line: string;
  checks: CheckResult[];
}
export interface Finding { kind: "store" | "conformance" | "diff"; id?: string; path?: string; message: string; proven: boolean; }
export interface CheckReport {
  ok: boolean;
  /** "native" ran the checks now; "cache" read earlier verdicts; "none" had neither. */
  source: "native" | "cache" | "none";
  entries: CheckedEntry[];
  counts: Record<Verdict, number>;
  findings: Finding[];
  /** Proven problems: the exit code is 1 when there are any. */
  problems: number;
  note?: string;
}

export interface CheckOptions extends KnowledgeOptions {
  /** Compare with this git revision: only team entries, nothing stored. */
  diff?: string;
  /** Path to mex-hook; defaults to MEX_HOOK_BINARY, then the platform package. */
  binary?: string | null;
}

const NATIVE_TIMEOUT_MS = 60_000;

export function nativeBinary(env: NodeJS.ProcessEnv = process.env): string | null {
  const override = env.MEX_HOOK_BINARY;
  if (override) return existsSync(override) ? override : null;
  return findNativeBinary();
}

/** Ask the native evaluator. Throws KnowledgeError when it can't answer. */
export function runNative(binary: string, request: Record<string, unknown>): NativeReport {
  const result = spawnSync(binary, ["--check-run"], {
    input: JSON.stringify(request), encoding: "utf8", timeout: NATIVE_TIMEOUT_MS, windowsHide: true,
    maxBuffer: 64 * 1024 * 1024, env: { ...process.env, MEX_BACKGROUND: "1" },
  });
  if (result.error) throw new KnowledgeError("CHECKS_UNAVAILABLE", `The check evaluator didn't run: ${result.error.message}`);
  let parsed: { ok?: boolean; error?: string };
  try { parsed = JSON.parse(result.stdout.trim().split("\n").at(-1) ?? ""); }
  catch { throw new KnowledgeError("CHECKS_UNAVAILABLE", "The check evaluator gave no answer."); }
  if (!parsed.ok) throw new KnowledgeError("CHECKS_FAILED", parsed.error ?? "The check evaluator failed.");
  return parsed as NativeReport;
}

/** Record a check against today's code, through the evaluator. Writers use it. */
export function recordCheck(binary: string, request: { checkout: string; project_id?: string; record_directory?: string; kind: string; role: "complete" | "supporting"; target: Record<string, unknown> }): unknown {
  const result = spawnSync(binary, ["--check-run"], {
    input: JSON.stringify({ action: "record", ...request }), encoding: "utf8", timeout: NATIVE_TIMEOUT_MS, windowsHide: true,
    env: { ...process.env, MEX_BACKGROUND: "1" },
  });
  const parsed = JSON.parse(result.stdout || "{}") as { ok?: boolean; error?: string; check?: unknown };
  if (!parsed.ok) throw new KnowledgeError("CHECK_NOT_RECORDED", parsed.error ?? "The check could not be recorded.");
  return parsed.check;
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
}

function entryFiles(directory: string, depth: number): string[] {
  if (!existsSync(directory)) return [];
  const out: string[] = [];
  for (const child of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, child.name);
    if (child.isSymbolicLink()) continue;
    if (child.isDirectory()) { if (depth > 0) out.push(...entryFiles(full, depth - 1)); continue; }
    if (child.isFile() && child.name.endsWith(".md") && !child.name.startsWith(".")) out.push(full);
  }
  return out;
}

function readEntry(path: string): KnowledgeEntry | undefined {
  try { const text = readEntryFile(path); return text === undefined ? undefined : parseEntry(text); } catch { return undefined; }
}

/** Store gates over entry files: what they hold that MEX would refuse. */
export function storeGates(files: Array<{ path: string; level: Level }>, source: References): Finding[] {
  const findings: Finding[] = [];
  const claims = new Map<string, string>();
  for (const { path, level } of files) {
    const raw = (() => { try { return readEntryFile(path); } catch { return undefined; } })();
    const entry = readEntry(path);
    const team = level === "team";
    if (raw === undefined || !entry) {
      findings.push({ kind: "store", path, message: "not a valid entry file", proven: team });
      continue;
    }
    const id = entry.mex.id;
    if (hasSecret(raw)) findings.push({ kind: "store", id, path, message: "holds a possible secret", proven: true });
    if (stripHidden(raw) !== raw) findings.push({ kind: "store", id, path, message: "holds hidden characters", proven: team });
    if (team) {
      const removed = sanitizeText(entry.text, source) !== entry.text || sanitizeText(entry.mex.one_line, source) !== entry.mex.one_line;
      if (removed) findings.push({ kind: "store", id, path, message: "names a command or link the repo doesn't have", proven: false });
    }
    if (entry.mex.status === "active") {
      const hash = claimHash(entry.text);
      const other = claims.get(hash);
      if (other) findings.push({ kind: "store", id, path, message: `says the same as ${other}`, proven: false });
      else claims.set(hash, id);
    }
  }
  return findings;
}

/** List the literal patterns entries count, so the file index counts them. */
export function registerPatterns(recordDirectory: string, projectId: string, entries: KnowledgeEntry[]): boolean {
  const directory = indexDirectory(recordDirectory, projectId);
  if (!existsSync(directory)) return false;
  const known = readPatterns(directory);
  const ids = new Set(known.map(p => p.id));
  const add = [...known];
  for (const entry of entries) {
    const patterns = [
      ...entry.mex.checks.flatMap(c => c.kind === "pattern" && (c.target.match ?? "literal") === "literal" ? [c.target.pattern] : []),
      ...(entry.mex.when ?? []).flatMap(w => w.match === "literal" ? [w.pattern] : []),
    ];
    for (const pattern of patterns) {
      const id = patternId(pattern);
      if (!ids.has(id)) { ids.add(id); add.push({ id, match: "literal", pattern }); }
    }
  }
  return add.length !== known.length && writePatterns(directory, add);
}

/** Rules whose anti-pattern occurs in their scope, from the file index. */
function conformance(recordDirectory: string, projectId: string, root: string, entries: Array<{ entry: KnowledgeEntry; path: string }>): Finding[] {
  const index = openIndex({ recordDirectory, projectId, checkout: root });
  if (!index) return [];
  const findings: Finding[] = [];
  try {
    for (const { entry, path } of entries) {
      if (entry.mex.status !== "active") continue;
      for (const when of entry.mex.when ?? []) {
        if (when.type !== "anti" || when.match !== "literal") continue;
        const id = patternId(when.pattern);
        for (const scope of entry.mex.scope) {
          const count = index.patternCounts(scope, [id])[id];
          if (count) findings.push({ kind: "conformance", id: entry.mex.id, path, message: `"${when.pattern}" occurs ${count} times in ${scope}`, proven: false });
        }
      }
    }
  } finally { index.close(); }
  return findings;
}

/** Lines a diff adds, per file. */
function addedLines(root: string, base: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let file = "";
  for (const line of git(root, "diff", "--unified=0", "--no-color", "--no-ext-diff", `${base}...HEAD`).split("\n")) {
    if (line.startsWith("+++ ")) { file = line.startsWith("+++ b/") ? line.slice(6) : ""; continue; }
    if (file && line.startsWith("+") && !line.startsWith("+++")) {
      if (!out.has(file)) out.set(file, []);
      out.get(file)!.push(line.slice(1));
    }
  }
  return out;
}

function globMatch(glob: string, path: string): boolean {
  const source = glob.replace(/[.+^$()|\\]/gu, "\\$&").replace(/\*\*\/?/gu, "\u0000").replace(/\*/gu, "[^/]*").replace(/\?/gu, "[^/]").replace(/\u0000/gu, ".*");
  return new RegExp(`^${source}${glob.endsWith("/") ? ".*" : ""}$`, "u").test(path);
}

export function runCheck(options: CheckOptions): CheckReport {
  const project = knowledgeProject(options);
  const root = project.root;
  const binary = options.binary === undefined ? nativeBinary(options.env) : options.binary;
  const homeExists = existsSync(project.location.home);
  const diff = options.diff;
  if (diff) git(root, "rev-parse", "--verify", `${diff}^{commit}`);

  const teamDir = join(root, ".mex", "learned");
  const files: Array<{ path: string; level: Level }> = entryFiles(teamDir, 1).map(path => ({ path, level: "team" }));
  if (!diff && homeExists) {
    const project_dir = join(project.location.home, "projects", project.projectId);
    files.push(...entryFiles(join(project_dir, "notes"), 0).map(path => ({ path, level: "personal" as const })));
    files.push(...entryFiles(join(project_dir, "hints"), 0).map(path => ({ path, level: "hint" as const })));
  }
  const parsed = new Map<string, KnowledgeEntry>();
  for (const f of files) { const e = readEntry(f.path); if (e) parsed.set(f.path, e); }

  const report: CheckReport = { ok: true, source: "none", entries: [], counts: { held: 0, changed: 0, broken: 0, unknown: 0 }, findings: [], problems: 0 };
  if (!diff && homeExists) registerPatterns(project.location.directory, project.projectId, [...parsed.values()]);

  if (binary) {
    const native = runNative(binary, {
      action: "evaluate", checkout: root, project_id: project.projectId, mex_home: project.location.home,
      record_directory: project.location.directory, store: !diff && homeExists && existsSync(project.location.hooks), team_only: !!diff,
    });
    report.source = "native";
    const checks = new Map((native.results ?? []).map(r => [r.entry_id, r.checks]));
    for (const item of native.items ?? []) {
      report.entries.push({ ...item, one_line: parsed.get(item.path)?.mex.one_line ?? "", checks: checks.get(item.id) ?? [] });
    }
  } else {
    report.note = "Live checks need MEX's native binary for this platform; showing the last verdicts saved on this machine.";
    const cached = cachedVerdicts(options, project.projectId, root);
    if (cached) report.source = "cache";
    for (const f of files) {
      const entry = parsed.get(f.path);
      if (!entry) continue;
      report.entries.push({ id: entry.mex.id, level: f.level, path: f.path, kind: entry.mex.kind, verdict: cached?.get(entry.mex.id) ?? "unknown", one_line: entry.mex.one_line, checks: [] });
    }
  }
  for (const e of report.entries) report.counts[e.verdict]++;

  // A broken team entry is a proven problem: a complete check failed. With
  // --diff, only entries the branch touched: their file, or a file they read.
  const touched = diff ? new Set(git(root, "diff", "--name-only", "--no-renames", `${diff}...HEAD`).split("\n").filter(Boolean)) : undefined;
  const touches = (path: string, entry: KnowledgeEntry | undefined) => !touched || touched.has(relative(root, path).split(sep).join("/"))
    || !!entry?.mex.checks.some(c => Object.keys(c.files).some(f => touched.has(f)) || ("file" in c.target && touched.has(String(c.target.file))));
  for (const e of report.entries) {
    const parsedEntry = parsed.get(e.path);
    if (e.verdict === "broken" && e.level === "team" && parsedEntry?.mex.status === "active" && touches(e.path, parsedEntry)) {
      const why = e.checks.find(c => c.role === "complete" && (c.status === "fail" || c.status === "gone"))?.reason;
      report.findings.push({ kind: diff ? "diff" : "store", id: e.id, path: e.path, message: `no longer true${why ? `: ${why}` : ""}`, proven: true });
    }
  }
  report.findings.push(...storeGates(files, references(root)));
  const withEntries = [...parsed.entries()].map(([path, entry]) => ({ path, entry }));
  if (!diff && homeExists) report.findings.push(...conformance(project.location.directory, project.projectId, root, withEntries));
  if (diff) report.findings.push(...diffConformance(root, diff, withEntries));

  report.problems = report.findings.filter(f => f.proven).length;
  report.ok = report.problems === 0;
  return report;
}

/** In a diff: an anti-pattern a team rule names, newly added in its scope. */
function diffConformance(root: string, base: string, entries: Array<{ entry: KnowledgeEntry; path: string }>): Finding[] {
  const added = addedLines(root, base);
  const findings: Finding[] = [];
  for (const { entry, path } of entries) {
    if (entry.mex.status !== "active") continue;
    for (const when of entry.mex.when ?? []) {
      if (when.type !== "anti" || when.match !== "literal") continue;
      for (const [file, lines] of added) {
        if (!entry.mex.scope.some(scope => scope === "**" || globMatch(scope, file))) continue;
        const count = lines.filter(line => line.includes(when.pattern)).length;
        if (count) findings.push({ kind: "diff", id: entry.mex.id, path, message: `${file} adds "${when.pattern}", which "${entry.mex.one_line}" rules out`, proven: true });
      }
    }
  }
  return findings;
}

function cachedVerdicts(options: KnowledgeOptions, projectId: string, root: string): Map<string, Verdict> | undefined {
  let reader;
  try { reader = openHooksReadOnly(options); } catch { return undefined; }
  if (!reader) return undefined;
  try {
    if (reader.diagnostic) return undefined;
    const rows = reader.all<{ entry_id: string; verdict: Verdict; checkout: string }>("SELECT entry_id, verdict, checkout FROM verdicts WHERE project_id=?", projectId);
    // Go folds Windows paths to lower case in checkout keys.
    const key = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);
    return new Map(rows.filter(r => key(r.checkout) === key(root)).map(r => [r.entry_id, r.verdict]));
  } catch { return undefined; } finally { reader.close(); }
}

const MARK: Record<Verdict, string> = { held: "held", changed: "being checked", broken: "withheld", unknown: "unknown" };

export function formatCheck(report: CheckReport, root: string): string {
  const lines: string[] = [];
  const shown = (p: string) => relative(root, p).split(sep).join("/") || p;
  if (!report.entries.length) lines.push("No knowledge entries here yet.");
  else lines.push(`${report.counts.held} held, ${report.counts.changed} being checked, ${report.counts.broken} withheld, ${report.counts.unknown} unknown`);
  for (const e of report.entries.filter(e => e.verdict !== "held").sort((a, b) => a.verdict.localeCompare(b.verdict))) {
    lines.push(`  ${MARK[e.verdict].padEnd(13)} ${e.id} [${e.level}] ${e.one_line}`);
    for (const c of e.checks.filter(c => c.status !== "pass" && c.reason)) lines.push(`      ${c.role} ${c.kind}: ${c.reason}`);
  }
  for (const kind of ["store", "conformance", "diff"] as const) {
    const items = report.findings.filter(f => f.kind === kind);
    if (!items.length) continue;
    lines.push("", kind === "store" ? "Store" : kind === "conformance" ? "Conformance" : "This change");
    for (const f of items) lines.push(`  ${f.proven ? "problem" : "note   "} ${f.id ?? shown(f.path ?? "")}: ${f.message}`);
  }
  if (report.note && report.entries.length) lines.push("", report.note);
  return lines.join("\n");
}

/** True when the repo still has a 0.8 scaffold, for the --legacy hint. */
export function hasLegacyScaffold(root: string): boolean {
  return existsSync(join(root, ".mex", "ROUTER.md")) || existsSync(join(root, ".mex", "context"));
}
