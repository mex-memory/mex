/**
 * The free pass that upgrades entries from file hashes to code fingerprints
 * once the graph is ready. Entries written before the graph existed link code
 * by a whole file's hash (a source check), or carry an 0.8 node link the new
 * evaluator can't renew (legacy-grounding). Where the graph says which
 * definition such a check is about, it becomes a symbol check: a fingerprint
 * of that definition only, recorded against today's code by the native
 * evaluator. Fingerprints are computed for those definitions and nothing else.
 *
 * Personal entries only: team entries live in git, and a rewrite there is a
 * change a person commits. A check the graph can't place is left as it is.
 * No model, no network; running it again finds nothing more to do.
 */
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { openCurrentGraph } from "../graph/storage.js";
import type { SqliteDatabase } from "../graph/db/sqlite.js";
import { CheckSchema, KNOWLEDGE_LIMITS, parseEntry, type EntryCheck, type KnowledgeEntry } from "./entry.js";
import { containedDirectory, readEntryFile } from "./files.js";
import { knowledgeProject, type KnowledgeOptions } from "./context.js";
import { nativeBinary } from "./check.js";
import { replacePersonalFields } from "./mutations.js";
import { symbolsIn } from "./note-checks.js";

/** The node kinds a symbol check can name: the graph reader's definitions. */
const DEFINITIONS = ["class", "struct", "interface", "trait", "protocol", "function", "method",
  "constant", "enum", "type_alias", "namespace", "component", "route", "variable"];
const MAX_SYMBOLS_PER_CHECK = 4;
const MAX_ITEMS = 256;
const MAX_CHECKS = 32;
const NATIVE_TIMEOUT_MS = 60_000;

export interface CheckUpgradeReport {
  /** Entries rewritten with symbol checks. */
  upgraded: number;
  /** Checks replaced, and fingerprints recorded for them. */
  checks: number;
  fingerprints: number;
  /** Why nothing ran, when nothing could. */
  skipped?: "no-graph" | "no-binary" | "no-notes";
}

type Item = { kind: "symbol"; role: "complete" | "supporting"; target: { file: string; symbol: string } };
type Plan = { id: string; content: string; entry: KnowledgeEntry; replace: Map<number, number[]> };

function definitionsIn(db: SqliteDatabase, file: string): Map<string, number> {
  const counts = new Map<string, number>();
  const rows = db.prepare(`SELECT name FROM nodes WHERE file_path=? AND kind IN (${DEFINITIONS.map(() => "?").join(",")})`)
    .all(file, ...DEFINITIONS) as Array<{ name: string }>;
  for (const row of rows) counts.set(row.name, (counts.get(row.name) ?? 0) + 1);
  return counts;
}

function nodeById(db: SqliteDatabase, id: string): { name: string; file: string } | undefined {
  const row = db.prepare(`SELECT name, file_path AS file FROM nodes WHERE id=? AND kind IN (${DEFINITIONS.map(() => "?").join(",")})`)
    .get(id, ...DEFINITIONS) as { name: string; file: string } | undefined;
  return row;
}

/** The symbol checks one stored check can become, from what the graph holds. */
function targetsFor(db: SqliteDatabase, entry: KnowledgeEntry, check: EntryCheck): Array<{ file: string; symbol: string }> {
  if (check.kind === "legacy-grounding") {
    const node = nodeById(db, check.target.node);
    if (!node || (check.target.file && check.target.file !== node.file)) return [];
    // Only a name the file defines once can be found again by name.
    return definitionsIn(db, node.file).get(node.name) === 1 ? [{ file: node.file, symbol: node.name }] : [];
  }
  if (check.kind === "source" && "file" in check.target) {
    const file = check.target.file;
    const defined = definitionsIn(db, file);
    if (defined.size === 0) return [];
    // The definitions the entry names, each defined once in the file.
    return symbolsIn(`${entry.mex.one_line}\n${entry.text}`)
      .map(name => name.split(".").at(-1)!)
      .filter((name, i, all) => all.indexOf(name) === i && defined.get(name) === 1)
      .slice(0, MAX_SYMBOLS_PER_CHECK)
      .map(symbol => ({ file, symbol }));
  }
  return [];
}

function personalEntries(directory: string): Array<{ id: string; content: string; entry: KnowledgeEntry }> {
  const out: Array<{ id: string; content: string; entry: KnowledgeEntry }> = [];
  const names = readdirSync(directory).filter(name => /^mx_[a-z0-9]{6,64}\.md$/u.test(name));
  if (names.length > KNOWLEDGE_LIMITS.entries) return out;
  for (const name of names) {
    try {
      const content = readEntryFile(join(directory, name));
      if (!content) continue;
      const entry = parseEntry(content);
      if (entry.mex.id !== name.slice(0, -3) || entry.mex.status === "retired") continue;
      out.push({ id: entry.mex.id, content, entry });
    } catch { /* an unreadable entry is the store gates' to report */ }
  }
  return out;
}

function recordSymbols(binary: string, project: ReturnType<typeof knowledgeProject>, items: Item[], env?: NodeJS.ProcessEnv): Array<EntryCheck | undefined> {
  const result = spawnSync(binary, ["--check-run"], {
    input: JSON.stringify({ action: "record-batch", checkout: project.root, project_id: project.projectId, record_directory: project.location.directory, items }),
    encoding: "utf8", timeout: NATIVE_TIMEOUT_MS, windowsHide: true, maxBuffer: 16 * 1024 * 1024,
    env: { ...(env ?? process.env), MEX_BACKGROUND: "1" },
  });
  let parsed: { ok?: boolean; results?: Array<{ ok?: boolean; check?: unknown }> };
  try { parsed = JSON.parse(result.stdout || "{}") as typeof parsed; } catch { return items.map(() => undefined); }
  if (!parsed.ok || !Array.isArray(parsed.results)) return items.map(() => undefined);
  return items.map((_, i) => {
    const r = parsed.results![i];
    const check = r?.ok ? CheckSchema.safeParse(r.check) : undefined;
    return check?.success && check.data.kind === "symbol" ? check.data : undefined;
  });
}

/** Run the pass for one checkout. Never throws: a failure leaves entries as they were. */
export function upgradeEntryChecks(options: KnowledgeOptions): CheckUpgradeReport {
  try { return upgrade(options); } catch { return { upgraded: 0, checks: 0, fingerprints: 0 }; }
}

function upgrade(options: KnowledgeOptions): CheckUpgradeReport {
  const report: CheckUpgradeReport = { upgraded: 0, checks: 0, fingerprints: 0 };
  let project: ReturnType<typeof knowledgeProject>;
  try { project = knowledgeProject(options); } catch { return { ...report, skipped: "no-notes" }; }
  const directory = containedDirectory(project.location.home, ["projects", project.projectId, "notes"]);
  if (!directory) return { ...report, skipped: "no-notes" };
  const binary = nativeBinary(options.env);
  if (!binary) return { ...report, skipped: "no-binary" };
  let db: SqliteDatabase | undefined;
  try { db = openCurrentGraph(project.root); } catch { db = undefined; }
  if (!db) return { ...report, skipped: "no-graph" };

  const items: Item[] = [];
  const plans: Plan[] = [];
  try {
    for (const { id, content, entry } of personalEntries(directory)) {
      const replace = new Map<number, number[]>();
      entry.mex.checks.forEach((check, index) => {
        if (items.length >= MAX_ITEMS) return;
        const targets = targetsFor(db!, entry, check);
        if (!targets.length) return;
        const role = check.kind === "legacy-grounding" ? "supporting" : check.role;
        replace.set(index, targets.map(target => items.push({ kind: "symbol", role, target }) - 1));
      });
      if (replace.size) plans.push({ id, content, entry, replace });
    }
  } finally { db.close(); }
  if (!items.length) return report;

  const recorded = recordSymbols(binary, project, items, options.env);
  for (const plan of plans) {
    const checks: EntryCheck[] = [];
    const keyOf = (check: EntryCheck) => `${check.kind}\0${JSON.stringify(check.target)}`;
    // A definition the entry already checks by fingerprint isn't added twice.
    const seen = new Set(plan.entry.mex.checks.filter(check => check.kind === "symbol").map(keyOf));
    let replaced = 0, fingerprints = 0;
    plan.entry.mex.checks.forEach((check, index) => {
      const made = (plan.replace.get(index) ?? []).map(i => recorded[i]).filter((c): c is EntryCheck => c !== undefined);
      // A check is replaced only when every definition it named was recorded.
      if (!made.length || made.length !== plan.replace.get(index)!.length) { checks.push(check); return; }
      replaced++;
      for (const symbol of made) {
        const key = keyOf(symbol);
        if (seen.has(key)) continue;
        seen.add(key);
        checks.push(symbol);
        fingerprints++;
      }
    });
    if (!replaced || checks.length > MAX_CHECKS) continue;
    try {
      replacePersonalFields(plan.id, entry => ({ ...entry, mex: { ...entry.mex, checks } }), options, plan.content);
      report.upgraded++;
      report.checks += replaced;
      report.fingerprints += fingerprints;
    } catch { /* changed meanwhile, or no longer valid: try again next time */ }
  }
  return report;
}
