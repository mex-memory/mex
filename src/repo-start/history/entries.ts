/**
 * Code facts as entries (producer `code-facts`). What the code-facts job mined,
 * plus exact readings of declared files (.gitattributes, CI, CODEOWNERS, env and
 * Docker files), proposed through the producer gate inside the same job run.
 *
 * Delivery acts on these entries at reads and edits, so a vague entry is worse
 * than none: every entry carries a complete check that passes today, each fact
 * type is capped, and statistical facts are skipped in small repositories.
 */
import { execFileSync } from "node:child_process";
import { closeSync, lstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { globToRegExp } from "../../file-index/glob.js";
import { parseJsonc } from "../../jsonc.js";
import type { RecordLocation } from "../../record/location.js";
import type { GateContext, GateResult, Proposal, ProposedCheck } from "../../knowledge/gate.js";
import { ciMatch, disabledIf, isGenerateLine, linePurpose, packageFor } from "../recipes/ci.js";
import type { RecipesFile } from "../recipes/index.js";
import { scriptCommand } from "../recipes/node.js";
import { pointer, record, RepoFiles, strings } from "../recipes/source.js";
import type { CodeFactsFile } from "./job.js";
import { answeredHandEdits } from "../questions/answers.js";
import { attributeGenerated, attributeMatcher, generatedMarker, generatorTool, historyGenerators } from "./mine.js";

export const FACT_LIMITS = Object.freeze({
  /** Below either, statistical facts (layer rules, generated files known only from history) are skipped. */
  commits: 50,
  sourceFiles: 30,
  /** Entries per fact type, after grouping. */
  generated: 50,
  layer: 30,
  ci: 30,
  env: 30,
});

export type FactType = "generated" | "layer" | "ci" | "env";
const FACT_TYPES: readonly FactType[] = ["generated", "layer", "ci", "env"];
/** Each fact type owns its entry kinds, so one type's sweep never touches another's entries. */
const TYPE_KINDS: Readonly<Record<FactType, readonly string[]>> = { generated: ["pitfall"], layer: ["rule"], ci: ["procedure"], env: ["recipe", "fact"] };
const TYPE_NAMES: Readonly<Record<FactType, string>> = { generated: "generated", layer: "layer", ci: "CI", env: "env/owners" };

const MAX_TRACKED = 50_000;
const HEAD_BYTES = 1024;
const TEXT_BYTES = 256 << 10;
const SOURCE = /\.(?:[cm]?[jt]sx?|py|rs|cs|go|java|kts?|scala|rb|php|swift|c|cc|cpp|cxx|h|hh|hpp|m|mm|exs?|erl|hs|ml|fs|dart|lua|r|jl|clj|vue|svelte|zig|sol)$/iu;

export interface CodeFactEntriesInput {
  checkout: string;
  projectId: string;
  location: RecordLocation;
  facts: CodeFactsFile;
  /** The commits the job read, newest first; history-only generated files need them. */
  commits?: ReadonlyArray<{ files: string[] }>;
}
export interface CodeFactEntriesOptions {
  env?: NodeJS.ProcessEnv;
  now?: Date;
  progress?: (text: string) => void;
  validate?: GateContext["validate"];
  /** Tests: stand-ins for the native evaluator. */
  observeChecks?: GateContext["observeChecks"];
  observeVerdicts?: GateContext["observeVerdicts"];
}
export interface CodeFactEntriesResult {
  /** One line for the job summary. */
  summary: string;
  /** Every fact type was read and proposed in full; false leaves the job to try again. */
  complete: boolean;
  results: Partial<Record<FactType, GateResult[]>>;
}

/** A proposal before the file index has counted its patterns. */
interface Draft {
  proposal: Proposal;
  /** Pattern checks by index: a marker must occur, a banned import must not. */
  counts?: Array<{ index: number; want: "some" | "one" | "none" }>;
}
interface TypeDrafts { drafts: Draft[]; skipped: Map<string, number>; capped: boolean; }
const emptyType = (): TypeDrafts => ({ drafts: [], skipped: new Map(), capped: false });
const skip = (type: TypeDrafts, reason: string) => type.skipped.set(reason, (type.skipped.get(reason) ?? 0) + 1);

const code = (text: string) => `\`${text}\``;
const base = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const folder = (path: string) => path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
/** A display label of at most 80 characters, or the shorter fallback. */
function label(text: string, fallback: string): string { return text.length <= 80 ? text : fallback.slice(0, 80).trim(); }
function list(items: string[]): string {
  return items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}
function pattern(scope: string, literal: string): ProposedCheck {
  return { kind: "pattern", role: "complete", target: { scope, pattern: literal } };
}
function proposal(fields: Omit<Proposal, "producer" | "model">): Proposal {
  return { producer: "code-facts", model: "none", ...fields };
}

function git(root: string, args: string[]): string {
  return execFileSync("git", ["-C", root, "-c", "core.quotePath=off", ...args], {
    encoding: "utf8", timeout: 60_000, maxBuffer: 256 << 20, windowsHide: true, stdio: ["ignore", "pipe", "ignore"],
  });
}

/** A tracked file's text: never a link, never more than `limit` bytes. */
function readText(root: string, path: string, limit = TEXT_BYTES): string | undefined {
  const full = join(root, ...path.split("/"));
  let fd: number | undefined;
  try {
    const stat = lstatSync(full);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) return undefined;
    fd = openSync(full, "r");
    const buffer = Buffer.alloc(stat.size);
    const read = readSync(fd, buffer, 0, stat.size, 0);
    return buffer.subarray(0, read).toString("utf8");
  } catch { return undefined; }
  finally { if (fd !== undefined) closeSync(fd); }
}
function readHead(root: string, path: string): string {
  let fd: number | undefined;
  try {
    fd = openSync(join(root, ...path.split("/")), "r");
    const buffer = Buffer.alloc(HEAD_BYTES);
    return buffer.subarray(0, readSync(fd, buffer, 0, HEAD_BYTES, 0)).toString("utf8");
  } catch { return ""; }
  finally { if (fd !== undefined) closeSync(fd); }
}
const lines = (text: string) => text.replace(/\r\n/gu, "\n").split("\n");

/** Turn the job's facts into proposals and save them through the gate, one fact type at a time. */
export async function proposeCodeFacts(input: CodeFactEntriesInput, options: CodeFactEntriesOptions = {}): Promise<CodeFactEntriesResult> {
  const { facts, checkout, projectId, location } = input;
  if (facts.skipped) return { summary: "", complete: true, results: {} };
  const [{ nativeBinary, registerLiterals }, { propose, summarizeResults }, { readFactFile }] = await Promise.all([
    import("../../knowledge/check.js"), import("../../knowledge/gate.js"), import("../facts.js"),
  ]);
  if (!options.observeChecks && !nativeBinary(options.env)) {
    return { summary: "entries: none saved (no check evaluator)", complete: false, results: {} };
  }
  options.progress?.("turning code facts into entries");
  let tracked: string[];
  try { tracked = git(checkout, ["ls-files", "-z"]).split("\0").filter(Boolean).slice(0, MAX_TRACKED); }
  catch { return { summary: "entries: none saved (git ls-files failed)", complete: false, results: {} }; }
  const generated = new Set(facts.generated.map(item => item.path));
  const sourceFiles = tracked.filter(path => SOURCE.test(path) && !generated.has(path)).length;
  const small = facts.commits_read < FACT_LIMITS.commits || sourceFiles < FACT_LIMITS.sourceFiles;
  const recipes = readFactFile<RecipesFile>(location, projectId, "recipes.json");
  const notes: string[] = [];
  if (small) notes.push(`small repo: ${plural(facts.commits_read, "commit")}, ${plural(sourceFiles, "source file")}; mined facts skipped`);

  const types: Record<FactType, TypeDrafts> = {
    generated: generatedDrafts(checkout, tracked, facts, input.commits, small, answeredHandEdits(location, projectId)),
    layer: small ? emptyType() : layerDrafts(facts, recipes),
    ci: ciDrafts(checkout, recipes),
    env: envDrafts(checkout, tracked, recipes),
  };
  const complete: Record<FactType, boolean> = { generated: true, layer: true, ci: true, env: true };
  // Layer rules need the file index's imports; without them there is nothing to judge a sweep by.
  if (!small && facts.layers_skipped) complete.layer = false;
  // Package names and setup recipes come from recipes.json; until `mex` writes it, keep what exists.
  if (!recipes) {
    complete.layer = complete.ci = complete.env = false;
    notes.push("no recipes.json yet");
  }
  // The generated list is capped in the facts file; a full list can't prove an entry's file stopped being generated.
  if (facts.generated.length >= 5000) complete.generated = false;

  // Pattern checks need the file index to count their literal, in this run: register the
  // literals, refresh the index (only the counts are redone when just the literals changed),
  // then read the counts the evaluator will see.
  const literals = new Set<string>();
  for (const type of FACT_TYPES) for (const draft of types[type].drafts) {
    for (const check of draft.proposal.checks ?? []) if (check.kind === "pattern") literals.add(check.target.pattern);
    for (const trigger of draft.proposal.anchors?.when ?? []) if (trigger.match === "literal") literals.add(trigger.pattern);
  }
  if (literals.size) {
    const counted = await countedIndex(checkout, projectId, location, [...literals], registerLiterals);
    for (const type of FACT_TYPES) {
      const kept: Draft[] = [];
      for (const draft of types[type].drafts) {
        if (!draft.counts?.length) { kept.push(draft); continue; }
        if (!counted) { complete[type] = false; continue; }
        const reason = applyCounts(draft, counted);
        if (reason) skip(types[type], reason);
        else kept.push(draft);
      }
      types[type].drafts = kept;
    }
    counted?.close();
    if (!counted) notes.push("no file index for pattern checks");
  }

  const results: Partial<Record<FactType, GateResult[]>> = {};
  const parts: string[] = [];
  for (const type of FACT_TYPES) {
    const { drafts, skipped, capped } = types[type];
    const sweep = complete[type] ? { producer: "code-facts" as const, includes: (entry: { mex: { kind: string } }) => TYPE_KINDS[type].includes(entry.mex.kind) } : undefined;
    if (drafts.length || sweep) {
      results[type] = await propose(drafts.map(draft => draft.proposal), {
        projectPath: checkout, home: location.home, env: options.env, now: options.now, validate: options.validate,
        observeChecks: options.observeChecks, observeVerdicts: options.observeVerdicts, sweep,
      });
    }
    const extra = [...skipped].map(([reason, n]) => `${n} skipped: ${reason}`);
    if (capped) extra.push(`capped at ${FACT_LIMITS[type]}`);
    parts.push(`${TYPE_NAMES[type]} ${summarizeResults(results[type] ?? [])}${extra.length ? ` (${extra.join("; ")})` : ""}`);
  }
  return {
    summary: `entries: ${parts.join("; ")}${notes.length ? `; ${notes.join("; ")}` : ""}`,
    complete: FACT_TYPES.every(type => complete[type]), results,
  };
}

interface Counter { counts(scope: string, literal: string): number | undefined; close(): void; }
async function countedIndex(checkout: string, projectId: string, location: RecordLocation, literals: string[],
  registerLiterals: (directory: string, projectId: string, literals: readonly string[]) => boolean): Promise<Counter | undefined> {
  const [{ openIndex }, { buildIndex }, { patternId }] = await Promise.all([
    import("../../file-index/read.js"), import("../../file-index/build.js"), import("../../file-index/classify.js"),
  ]);
  const open = () => openIndex({ recordDirectory: location.directory, projectId, checkout });
  const before = open();
  if (!before) return undefined;
  before.close();
  try {
    registerLiterals(location.directory, projectId, literals);
    await buildIndex({ root: checkout, projectId, recordDirectory: location.directory });
  } catch { return undefined; }
  const index = open();
  if (!index) return undefined;
  return {
    counts: (scope, literal) => { const id = patternId(literal); return index.patternCounts(scope, [id])[id]; },
    close: () => index.close(),
  };
}

/** Fill in each pattern check's count, or say why the draft can't be proposed. */
function applyCounts(draft: Draft, counter: Counter): string | undefined {
  const checks = draft.proposal.checks!;
  for (const { index, want } of draft.counts ?? []) {
    const check = checks[index]!;
    if (check.kind !== "pattern") continue;
    const count = counter.counts(check.target.scope, check.target.pattern);
    if (count === undefined) return "pattern not counted";
    if (want === "some" && count === 0) return "marker not in the file index";
    // A literal that also occurs inside another line can't say which line it holds.
    if (want === "one" && count !== 1) return count ? "literal not unique" : "marker not in the file index";
    if (want === "none" && count > 0) return "import literal already in use";
    checks[index] = { ...check, saw: { count } };
  }
  return undefined;
}

// ── Generated files ──

/** A `.gitattributes` or CODEOWNERS pattern as a scope glob, or undefined when the dialects differ. */
export function ignoreStyleGlob(raw: string, directoryContents: boolean): string | undefined {
  const pattern = raw.trim();
  if (!pattern || /[[\]{}\\!\s]/u.test(pattern) || pattern.startsWith("#")) return undefined;
  const dir = pattern.endsWith("/");
  const body = pattern.replace(/^\//u, "").replace(/\/+$/u, "");
  if (!body) return undefined;
  const anchored = pattern.replace(/\/+$/u, "").includes("/");
  const segments = body.split("/");
  if (segments.some(part => part === "" || part === "." || part === ".." || (part.includes("**") && part !== "**"))) return undefined;
  let glob = anchored ? body : `**/${body}`;
  const last = segments.at(-1)!;
  if (dir || last === "**") glob = last === "**" ? glob : `${glob}/**`;
  else if (directoryContents && !/[*?]/u.test(last)) glob = `${glob}/**`;
  return glob;
}
const repoWide = (glob: string) => /^(?:\*\*\/)*(?:\*\*|\*|\*\*\/\*)$/u.test(glob);

function generatedDrafts(checkout: string, tracked: string[], facts: CodeFactsFile, commits: CodeFactEntriesInput["commits"], small: boolean,
  handEditsAllowed: ReadonlySet<string> = new Set()): TypeDrafts {
  const out = emptyType();
  const covered = new Set<string>();
  const add = (draft: Draft) => { if (out.drafts.length < FACT_LIMITS.generated) out.drafts.push(draft); else out.capped = true; };

  // Declared in .gitattributes: one entry per line, scoped by the line's own pattern.
  const attributes = tracked.includes(".gitattributes") ? readText(checkout, ".gitattributes") : undefined;
  if (attributes !== undefined) {
    const marked = new Set(attributeGenerated(attributes, tracked));
    for (const line of lines(attributes)) {
      const [raw, ...attrs] = line.trim().split(/\s+/u);
      if (!raw || raw.startsWith("#") || !attrs.some(a => a === "linguist-generated" || a === "linguist-generated=true")) continue;
      const glob = ignoreStyleGlob(raw, false);
      const matcher = attributeMatcher(raw);
      const matched = tracked.filter(matcher);
      if (!glob || repoWide(glob) || !matched.length || !matched.every(path => marked.has(path)) || !sameMatches(glob, tracked, matched)) {
        skip(out, "gitattributes pattern without an exact scope"); continue;
      }
      matched.forEach(path => covered.add(path));
      add({
        proposal: proposal({
          key: `generated\ngitattributes\n${raw}`, kind: "pitfall", anchors: { scope: [glob] },
          text: `Files matching ${code(glob)} are generated: \`.gitattributes\` marks them \`linguist-generated\`. Don't edit them by hand; change what generates them and regenerate.`,
          oneLine: `Files matching ${code(glob)} are generated; don't edit them by hand.`,
          label: label(`mined from code, ${matched.length} of ${matched.length} matching files marked generated`, "mined from code, marked generated in .gitattributes"),
          source: { type: "mined", ref: ".gitattributes" }, checks: [pattern(".gitattributes", line.trim())],
        }),
        counts: [{ index: 0, want: "some" }],
      });
    }
  }

  // Header markers: grouped by a folder or a file suffix that is all generated.
  const trackedSet = new Set(tracked);
  const markers = new Map<string, { literal: string; tool?: string }>();
  for (const item of facts.generated) {
    // A person said this file is edited by hand (setup questions): no pitfall says otherwise.
    if (item.signal !== "marker" || covered.has(item.path) || !trackedSet.has(item.path) || handEditsAllowed.has(item.path)) continue;
    const head = readHead(checkout, item.path);
    const literal = generatedMarker(head);
    if (literal) markers.set(item.path, { literal, tool: generatorTool(head) });
  }
  const groups = groupMarkers(tracked, markers);
  for (const group of groups) {
    const literals = new Map<string, number>();
    for (const path of group.paths) { const { literal } = markers.get(path)!; literals.set(literal, (literals.get(literal) ?? 0) + 1); }
    const literal = [...literals].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0];
    const tools = new Set(group.paths.map(path => markers.get(path)!.tool));
    const tool = tools.size === 1 ? [...tools][0] : undefined;
    const by = tool ? `, written by ${code(tool)}` : "";
    const n = group.paths.length;
    const what = group.kind === "file" ? code(group.scope) : group.kind === "folder" ? `Files under ${code(`${group.folder}/`)}` : `Files matching ${code(group.scope)}`;
    const verb = group.kind === "file" ? "is" : "are";
    const it = group.kind === "file" ? "it" : "them";
    add({
      proposal: proposal({
        key: `generated\nmarker\n${group.scope}`, kind: "pitfall", anchors: { scope: [group.scope] },
        // The marker in quotes, not a code span: the gate reads a span like `auto-generated by` as a command.
        text: `${what} ${verb} generated (${group.kind === "file" ? "it carries" : "each carries"} a "${literal}" header${by}). Don't edit ${it} by hand; change what generates ${it} and regenerate.`,
        oneLine: `${what} ${verb} generated; don't edit ${it} by hand.`,
        label: label(`mined from code, ${n} of ${n} ${n === 1 ? "file carries" : "files carry"} a generated header`, "mined from code, generated header"),
        source: { type: "mined", ref: group.scope }, checks: [pattern(group.scope, literal)],
      }),
      counts: [{ index: 0, want: "some" }],
    });
  }

  // Known only from history: a statistical fact, and only with one generator that changed every time.
  if (!small && commits) {
    const history = facts.generated.filter(item => item.signal === "history" && !covered.has(item.path) && trackedSet.has(item.path)).map(item => item.path);
    const found = historyGenerators(commits, new Set(history));
    for (const path of history) {
      const row = found.get(path);
      const generator = row?.generators.length === 1 ? row.generators[0]! : undefined;
      if (!row || !generator || row.commits < 2) { skip(out, "no single generator in history"); continue; }
      add({
        proposal: proposal({
          key: `generated\nhistory\n${path}`, kind: "pitfall", anchors: { scope: [path] },
          text: `${code(path)} is generated from ${code(generator)}: each of the last ${plural(row.commits, "commit")} that changed it also changed ${code(generator)}. Edit ${code(generator)} and regenerate instead of editing it by hand.`,
          oneLine: `${code(path)} is generated from ${code(generator)}; edit that and regenerate.`,
          label: label(`mined from code, ${row.commits} of ${row.commits} changes came with ${base(generator)}`, `mined from code, ${row.commits} of ${row.commits} changes came with its generator`),
          source: { type: "mined", ref: path }, checks: [{ kind: "source", role: "complete", target: { file: path } }],
        }),
      });
    }
  }
  return out;
}

function sameMatches(glob: string, tracked: string[], matched: string[]): boolean {
  const regex = globToRegExp(glob);
  const byGlob = tracked.filter(path => regex.test(path));
  return byGlob.length === matched.length && byGlob.every((path, i) => path === matched[i]);
}

interface MarkerGroup { kind: "folder" | "suffix" | "file"; scope: string; folder?: string; paths: string[]; }
/**
 * The largest folders whose tracked files all carry a marker, then file suffixes
 * (`.pb.go`, `_string.go`) whose tracked files all do, then single files. One
 * entry for a 400-file proto folder, not 400.
 */
function groupMarkers(tracked: string[], markers: ReadonlyMap<string, unknown>): MarkerGroup[] {
  const total = new Map<string, number>(), marked = new Map<string, number>();
  for (const path of tracked) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join("/");
      total.set(dir, (total.get(dir) ?? 0) + 1);
      if (markers.has(path)) marked.set(dir, (marked.get(dir) ?? 0) + 1);
    }
  }
  const folders = new Map<string, string[]>(), rest: string[] = [];
  for (const path of [...markers.keys()].sort()) {
    const parts = path.split("/");
    let group: string | undefined;
    for (let i = 1; i < parts.length && !group; i++) {
      const dir = parts.slice(0, i).join("/");
      if ((marked.get(dir) ?? 0) >= 2 && marked.get(dir) === total.get(dir)) group = dir;
    }
    if (group) folders.set(group, [...(folders.get(group) ?? []), path]);
    else rest.push(path);
  }
  const suffixOf = (path: string) => /^[^.]+(\.[^/]+\.[^./]+)$/u.exec(base(path))?.[1] ?? /[^/_]_([A-Za-z0-9]+\.[A-Za-z0-9]+)$/u.exec(base(path))?.[0].slice(1);
  const bySuffix = new Map<string, string[]>();
  for (const path of rest) { const suffix = suffixOf(path); if (suffix) bySuffix.set(suffix, [...(bySuffix.get(suffix) ?? []), path]); }
  const suffixes = new Map<string, string[]>();
  for (const [suffix, paths] of bySuffix) {
    if (paths.length < 3 || /[*?{}[\]]/u.test(suffix)) continue;
    const all = tracked.filter(path => base(path).endsWith(suffix) && base(path).length > suffix.length);
    if (all.length === paths.length) suffixes.set(suffix, paths);
  }
  const inSuffix = new Set([...suffixes.values()].flat());
  return [
    ...[...folders].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
      .map(([dir, paths]): MarkerGroup => ({ kind: "folder", scope: `${dir}/**`, folder: dir, paths })),
    ...[...suffixes].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
      .map(([suffix, paths]): MarkerGroup => ({ kind: "suffix", scope: `**/*${suffix}`, paths })),
    ...rest.filter(path => !inSuffix.has(path)).map((path): MarkerGroup => ({ kind: "file", scope: path, paths: [path] })),
  ];
}

// ── Layer rules ──

/** A package name precise enough to ban: scoped, or with a separator, so its quoted form never reads as a plain word. */
export const preciseName = (name: string) => /^@[a-z0-9][\w.-]*\/[\w.-]+$/iu.test(name) || /^[a-z0-9][\w-]*[-._][\w.-]+$/iu.test(name);

function layerDrafts(facts: CodeFactsFile, recipes: RecipesFile | undefined): TypeDrafts {
  const out = emptyType();
  const packages = recipes?.packages ?? [];
  for (const rule of facts.layer_rules) {
    const target = packages.find(pkg => pkg.path === rule.to && pkg.kind === "node" && pkg.name);
    if (!target || !preciseName(target.name)) {
      // A folder reached by relative paths has no literal that names only it, but the file
      // index resolves those imports to paths: a relation check counts them (0 today, which
      // the gate proves), and the speed bump stops an edit that adds one.
      if (out.drafts.length >= FACT_LIMITS.layer) { out.capped = true; break; }
      const scope = `${rule.from}/**`, from = base(rule.from), to = base(rule.to);
      out.drafts.push({
        proposal: proposal({
          key: `layer\n${rule.from}\n${rule.to}`, kind: "rule",
          anchors: { scope: [scope] },
          text: `${code(rule.from)} never imports ${code(rule.to)}: ${plural(rule.imports, "import")} go from ${code(rule.to)} into ${code(rule.from)} and none go back. Keep the dependency one-way.`,
          oneLine: `${code(rule.from)} never imports ${code(rule.to)}; keep the dependency one-way.`,
          label: label(`mined from code: ${rule.imports} imports go ${to}→${from}, none ${from}→${to}`, `mined from code: ${rule.imports} imports one way, none back`),
          source: { type: "mined", ref: scope },
          checks: [{ kind: "relation", role: "complete", target: { query: "imports", from: scope, to: `${rule.to}/**` }, saw: { count: 0 } }],
        }),
      });
      continue;
    }
    if (out.drafts.length >= FACT_LIMITS.layer) { out.capped = true; break; }
    const name = target.name, scope = `${rule.from}/**`;
    const literals = [`'${name}'`, `"${name}"`, `'${name}/`, `"${name}/`];
    const from = base(rule.from), to = base(rule.to);
    out.drafts.push({
      proposal: proposal({
        key: `layer\n${rule.from}\n${rule.to}`, kind: "rule",
        anchors: { scope: [scope], when: literals.map(literal => ({ type: "anti" as const, match: "literal" as const, pattern: literal })) },
        text: `${code(rule.from)} never imports ${code(name)} (${code(rule.to)}): ${plural(rule.imports, "import")} go from ${code(rule.to)} into ${code(rule.from)} and none go back. Keep the dependency one-way.`,
        oneLine: `${code(rule.from)} never imports ${code(name)}; keep the dependency one-way.`,
        label: label(`mined from code: ${rule.imports} imports go ${to}→${from}, none ${from}→${to}`, `mined from code: ${rule.imports} imports one way, none back`),
        source: { type: "mined", ref: scope }, checks: literals.map(literal => pattern(scope, literal)),
      }),
      counts: literals.map((_, index) => ({ index, want: "none" as const })),
    });
  }
  return out;
}

// ── CI path obligations ──

/** A GitHub Actions `paths` filter as a scope glob, or undefined when it can't be said exactly. */
export function actionsPathGlob(raw: string): string | undefined {
  const value = raw.trim();
  if (!value || value.startsWith("!") || value.startsWith("/") || /[?+[\]{}\\\s]/u.test(value)) return undefined;
  const segments: string[] = [];
  for (const part of value.replace(/\/+$/u, "/**").replace(/^\.\//u, "").split("/")) {
    if (part === "" || part === "." || part === "..") return undefined;
    if (part.includes("**") && part !== "**") {
      // `**.js`: any path ending in .js.
      if (!part.startsWith("**") || part.slice(2).includes("*")) return undefined;
      segments.push("**", `*${part.slice(2)}`);
    } else segments.push(part);
  }
  const glob = segments.join("/");
  return repoWide(glob) ? undefined : glob;
}

const OBLIGATIONS = new Set(["test", "build", "lint", "typecheck"]);

function ciDrafts(checkout: string, recipes: RecipesFile | undefined): TypeDrafts {
  const out = emptyType();
  const files = new RepoFiles(checkout);
  const directory = ".github/workflows";
  if (!files.isDirectory(directory)) return out;
  const packages = recipes?.packages ?? [];
  for (const name of files.filesIn(directory).filter(file => /\.ya?ml$/u.test(file)).slice(0, 64)) {
    const file = `${directory}/${name}`;
    const workflow = record(files.yaml(file));
    const on = record(workflow?.on);
    if (!workflow || !on) continue;
    const event = ["pull_request", "push"].find(key => Array.isArray(record(on[key])?.paths));
    // A `paths-ignore` filter alone names no area.
    if (!event) continue;
    const rawPaths = record(on[event])!.paths as unknown[];
    const globs = strings(rawPaths).map(actionsPathGlob);
    if (!rawPaths.length || rawPaths.length > 32 || globs.length !== rawPaths.length || globs.some(glob => !glob)) { skip(out, "paths filter without an exact scope"); continue; }
    const commands: string[] = [], checks: ProposedCheck[] = [];
    let steps = 0;
    for (const [jobName, rawJob] of Object.entries(record(workflow.jobs) ?? {})) {
      const job = record(rawJob);
      if (!job || disabledIf(job.if)) continue;
      const directoryDefault = record(record(job.defaults)?.run)?.["working-directory"];
      (Array.isArray(job.steps) ? job.steps : []).forEach((rawStep, index) => {
        const step = record(rawStep);
        if (!step || typeof step.run !== "string" || disabledIf(step.if)) return;
        let line: string | undefined, generate = false;
        for (const raw of lines(step.run)) {
          const text = raw.trim().replace(/\s+\\$/u, "");
          const purpose = linePurpose(text);
          if (purpose && OBLIGATIONS.has(purpose)) { line = text; break; }
          if (!purpose && isGenerateLine(text)) { line = text; generate = true; break; }
        }
        if (!line) return;
        const at = pointer("jobs", jobName, "steps", index, "run");
        // A setup recipe CI merged with this step names its own command.
        const recipe = generate ? undefined : recipeCommand(recipes, file, at);
        // Otherwise the step runs a package script or Makefile target in its working directory:
        // name that package in the command, or skip the step.
        const raw = step["working-directory"] ?? directoryDefault;
        const directory = typeof raw === "string" ? raw.trim().replace(/^\.(?:\/+|$)/u, "").replace(/\/+$/u, "") : "";
        if (!recipe && directory && packageFor(directory, packages) !== directory) { skip(out, "CI step in a folder that is not a package"); return; }
        // A step setup judged not to run on a laptop (secrets, services) is not an obligation.
        if (!recipe && !runsLocally(recipes, file, at, job, step)) { skip(out, "CI step needs secrets or services"); return; }
        steps++;
        const local = recipe ?? scriptCommandAt(files, recipes, line, directory, ciMatch(line, packages, directory));
        if (!local || commands.includes(local.command)) return;
        commands.push(local.command);
        checks.push(local.check);
      });
    }
    if (!commands.length) { if (steps) skip(out, "no local command for its CI steps"); continue; }
    if (out.drafts.length >= FACT_LIMITS.ci) { out.capped = true; break; }
    const scopes = [...new Set(globs as string[])];
    const shown = commands.slice(0, 6);
    const text = `After changes in ${list(scopes.map(code))}, run ${list(shown.map(code))} (CI runs ${shown.length === 1 ? "it" : "them"} in ${code(file)}).`;
    out.drafts.push({
      proposal: proposal({
        key: `ci\n${file}`, kind: "procedure", anchors: { scope: scopes }, text, oneLine: text,
        label: label(`mined from code, ${commands.length} of ${steps} CI steps in ${name} run locally`, `mined from code, ${commands.length} of ${steps} CI steps run locally`),
        source: { type: "ci", ref: file },
        checks: [{ kind: "key", role: "complete", target: { file, pointer: pointer("on", event, "paths") } }, ...checks.slice(0, 6)],
      }),
    });
  }
  return out;
}

/** The setup recipe a CI step runs: the command the person types, and its config check. */
function recipeCommand(recipes: RecipesFile | undefined, file: string, at: string): { command: string; check: ProposedCheck } | undefined {
  const recipe = recipes?.recipes.find(item => item.local === "yes" && item.entry.mex.source.type === "config" && OBLIGATIONS.has(item.purpose)
    && item.origin.some(origin => origin.file === file && origin.pointer === at));
  const origin = recipe?.origin[0];
  if (!recipe || !origin) return undefined;
  return { command: recipe.command, check: { kind: "command", role: "supporting", target: { run: recipe.command, file: origin.file, pointer: origin.pointer } } };
}

const SECRET_REFERENCE = /\$\{\{\s*secrets\./u;
/** No recipe for this step says it can't run locally, and its job starts no services or reads no secrets. */
function runsLocally(recipes: RecipesFile | undefined, file: string, at: string, job: Record<string, unknown>, step: Record<string, unknown>): boolean {
  const judged = recipes?.recipes.find(item => item.origin.some(origin => origin.file === file && origin.pointer === at));
  if (judged && judged.local !== "yes") return false;
  const services = record(job.services);
  if ((services && Object.keys(services).length) || record(job.container)?.credentials !== undefined) return false;
  return !SECRET_REFERENCE.test(JSON.stringify([step.run, step.env ?? null, step.with ?? null, job.env ?? null]));
}

/**
 * A CI step that runs a package script or a Makefile target the checkout defines. A script is
 * named the way setup recipes name it, so it runs from the root (`npm run -w packages/api
 * generate`); a Makefile target only from a step that runs at the root.
 */
function scriptCommandAt(files: RepoFiles, recipes: RecipesFile | undefined, line: string, directory: string, match: string | undefined): { command: string; check: ProposedCheck } | undefined {
  if (!match) return undefined;
  const script = /^script:([^:]*):(.+)$/u.exec(match);
  if (script) {
    const manifest = script[1] ? `${script[1]}/package.json` : "package.json";
    const scripts = record(files.json(manifest)?.scripts);
    const body = scripts?.[script[2]!];
    const manager = recipes?.manager;
    if (typeof body !== "string" || !body.trim() || !manager) return undefined;
    const pkg = recipes.packages.find(item => item.path === script[1]);
    // The gate verifies workspace scripts in the forms it knows; npm's `-w` form is the same
    // command, and bun's `--filter` form it can't verify (a drop would hold back the CI sweep).
    if (pkg?.path && manager === "bun") return undefined;
    const command = pkg?.path && manager === "npm" ? `npm run -w ${pkg.path} ${script[2]!}` : scriptCommand(manager, script[2]!, pkg);
    return { command, check: { kind: "command", role: "supporting", target: { run: command, file: manifest, pointer: pointer("scripts", script[2]!) } } };
  }
  const make = /^make::(.+)$/u.exec(match);
  if (directory) return undefined;
  const makefile = files.read("Makefile");
  if (make && makefile !== undefined && new RegExp(`^${make[1]!.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\s*:(?!=)`, "mu").test(makefile)) {
    return { command: line, check: { kind: "command", role: "supporting", target: { run: line, file: "Makefile", pointer: pointer(make[1]!) } } };
  }
  return undefined;
}

// ── Environment, Docker and owners ──

const RUNTIMES: Readonly<Record<string, string>> = {
  node: "Node.js", python: "Python", golang: "Go", ruby: "Ruby", rust: "Rust", php: "PHP", openjdk: "Java", "eclipse-temurin": "Java",
  amazoncorretto: "Java", gradle: "Gradle", maven: "Maven", elixir: "Elixir", deno: "Deno", bun: "Bun", sdk: ".NET SDK", aspnet: "ASP.NET", erlang: "Erlang", dart: "Dart", swift: "Swift",
};
const SERVICES = new Set(["postgres", "postgis", "mysql", "mariadb", "redis", "valkey", "mongo", "rabbitmq", "memcached", "elasticsearch", "opensearch",
  "minio", "localstack", "nats", "kafka", "cp-kafka", "zookeeper", "clickhouse-server", "cassandra", "mailhog", "mailpit", "dynamodb-local", "azurite", "keycloak"]);

/** `registry/org/name:tag` → name and tag; undefined for digests and variables. */
function image(text: string): { name: string; tag?: string } | undefined {
  if (!text || /[$@\s]/u.test(text)) return undefined;
  const colon = text.lastIndexOf(":");
  const tagged = colon > text.lastIndexOf("/");
  const path = tagged ? text.slice(0, colon) : text;
  return { name: path.slice(path.lastIndexOf("/") + 1).toLowerCase(), tag: tagged ? text.slice(colon + 1) : undefined };
}

function envDrafts(checkout: string, tracked: string[], recipes: RecipesFile | undefined): TypeDrafts {
  const out = emptyType();
  const add = (draft: Draft) => { if (out.drafts.length < FACT_LIMITS.env) out.drafts.push(draft); else out.capped = true; };
  const byDepth = (paths: string[]) => paths.sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));

  // .env.example: the variable names, never their values.
  for (const file of byDepth(tracked.filter(path => /(?:^|\/)\.env\.(?:example|sample)$/u.test(path))).slice(0, 10)) {
    const text = readText(checkout, file);
    if (text === undefined) continue;
    const names = [...new Set(lines(text).flatMap(line => /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/u.exec(line)?.[1] ?? []))];
    if (!names.length) { skip(out, "env file without variables"); continue; }
    const dir = folder(file), target = dir ? `${dir}/.env` : ".env";
    const shown = names.slice(0, 30);
    const more = names.length > shown.length ? ` and ${names.length - shown.length} more` : "";
    add({
      proposal: proposal({
        key: `env\n${file}`, kind: "recipe", anchors: { scope: dir ? [`${dir}/**`] : [file, ".env"] },
        text: `Local runs read these variables: ${shown.join(", ")}${more}. Copy ${code(file)} to ${code(target)} and fill in the values.`,
        oneLine: `Copy ${code(file)} to ${code(target)}; local runs read ${plural(names.length, "variable")} from it.`,
        label: label(`mined from code, ${shown.length} of ${names.length} variables in ${base(file)}`, "mined from code, variables in an env example"),
        source: { type: "mined", ref: file }, checks: [{ kind: "source", role: "complete", target: { file } }],
      }),
    });
  }

  // Dockerfiles: the runtime images they build on, with their versions.
  for (const file of byDepth(tracked.filter(path => /(?:^|\/)(?:Dockerfile(?:\.[\w.-]+)?|[\w.-]+\.Dockerfile)$/u.test(path))).slice(0, 10)) {
    const text = readText(checkout, file);
    if (text === undefined) continue;
    const stages = new Set<string>();
    const found: Array<{ line: string; runtime: string; version: string; image: string }> = [];
    let total = 0;
    for (const line of lines(text)) {
      const from = /^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?\s*$/iu.exec(line);
      if (!from) continue;
      const ref = from[1]!;
      // `FROM build` names an earlier stage, not an image.
      const stage = stages.has(ref.toLowerCase());
      if (from[2]) stages.add(from[2].toLowerCase());
      if (stage || ref.toLowerCase() === "scratch") continue;
      total++;
      const parsed = image(ref);
      const runtime = parsed && RUNTIMES[parsed.name];
      const version = parsed?.tag ? /^v?(\d+(?:\.\d+){0,2})(?:$|-)/u.exec(parsed.tag)?.[1] : undefined;
      if (!runtime || !version) continue;
      if (!found.some(item => item.image === ref)) found.push({ line: line.trim(), runtime, version, image: ref });
    }
    if (!found.length) { if (total) skip(out, "Dockerfile without a versioned runtime image"); continue; }
    const shown = found.slice(0, 4);
    add({
      proposal: proposal({
        key: `docker\n${file}`, kind: "fact", anchors: { scope: [file] },
        text: `${code(file)} builds on ${list(shown.map(item => `${item.runtime} ${item.version} (image ${code(item.image)})`))}. Use the same ${shown.length === 1 ? "version" : "versions"} locally.`,
        oneLine: `${code(file)} builds on ${list(shown.map(item => `${item.runtime} ${item.version}`))}.`,
        label: label(`mined from code, ${shown.length} of ${total} base images in ${base(file)}`, "mined from code, base images in a Dockerfile"),
        source: { type: "mined", ref: file }, checks: shown.map(item => pattern(file, item.line)),
      }),
      counts: shown.map((_, index) => ({ index, want: "some" as const })),
    });
  }

  // Compose files: the backing services they start.
  const files = new RepoFiles(checkout);
  for (const file of byDepth(tracked.filter(path => /(?:^|\/)(?:docker-)?compose(?:\.[\w-]+)?\.ya?ml$/u.test(path))).slice(0, 10)) {
    const services = record(record(files.yaml(file))?.services);
    if (!services) continue;
    const found: Array<{ service: string; name: string; image: string }> = [];
    for (const [service, raw] of Object.entries(services)) {
      const value = record(raw)?.image;
      const parsed = typeof value === "string" ? image(value) : undefined;
      if (parsed && SERVICES.has(parsed.name)) found.push({ service, name: parsed.name, image: value as string });
    }
    if (!found.length) continue;
    const shown = found.slice(0, 8);
    add({
      proposal: proposal({
        key: `compose\n${file}`, kind: "fact", anchors: { scope: [file] },
        text: `${code(file)} starts ${list(shown.map(item => `${item.name} (image ${code(item.image)})`))} for local runs.`,
        oneLine: `${code(file)} starts ${list(shown.map(item => item.name))} for local runs.`,
        label: label(`mined from code, ${shown.length} of ${Object.keys(services).length} services in ${base(file)}`, "mined from code, services in a compose file"),
        source: { type: "mined", ref: file },
        checks: shown.map(item => ({ kind: "key", role: "complete", target: { file, pointer: pointer("services", item.service, "image") } })),
      }),
    });
  }

  // A dev container that runs a setup recipe after it is created.
  for (const file of [".devcontainer/devcontainer.json", ".devcontainer.json"].filter(path => tracked.includes(path))) {
    const text = readText(checkout, file);
    let command: unknown;
    try { command = text === undefined ? undefined : record(parseJsonc(text))?.postCreateCommand; } catch { command = undefined; }
    if (typeof command !== "string") continue;
    const recipe = recipes?.recipes.find(item => item.local === "yes" && item.entry.mex.source.type === "config" && item.command === command.trim());
    const origin = recipe?.origin[0];
    if (!recipe || !origin) { skip(out, "dev container command without a setup recipe"); continue; }
    add({
      proposal: proposal({
        key: `devcontainer\n${file}`, kind: "recipe", anchors: { scope: ["**"] },
        text: `On a fresh checkout, run ${code(recipe.command)}: the dev container runs it after it is created (${code(file)}).`,
        oneLine: `On a fresh checkout, run ${code(recipe.command)}.`,
        label: label(`mined from code, 1 of 1 setup commands in ${base(file)}`, "mined from code, dev container setup"),
        source: { type: "mined", ref: file },
        checks: [
          { kind: "key", role: "complete", target: { file, pointer: "/postCreateCommand" } },
          { kind: "command", role: "supporting", target: { run: recipe.command, file: origin.file, pointer: origin.pointer } },
        ],
      }),
    });
  }

  // CODEOWNERS: one fact per owned area. Personal handles never reach the text.
  const owners = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"].find(path => tracked.includes(path));
  const ownersText = owners ? readText(checkout, owners) : undefined;
  if (owners && ownersText !== undefined) {
    const { rules, total } = ownerRules(ownersText);
    const kept: Array<OwnerRule & { glob: string }> = [];
    rules.forEach((rule, i) => {
      if (!rule.handles) return;
      if (!rule.glob) { skip(out, "CODEOWNERS pattern without an exact scope"); return; }
      if (repoWide(rule.glob)) { skip(out, "CODEOWNERS catch-all"); return; }
      const regex = rule.regex!;
      const matched = tracked.filter(path => regex.test(path));
      if (!matched.length) { skip(out, "CODEOWNERS pattern matches no tracked file"); return; }
      // The last matching line wins in CODEOWNERS, owners or none: a later line that matches any
      // of these files takes them over, so this line no longer says who reviews its whole area.
      const later = rules.slice(i + 1);
      if (later.some(next => !next.regex || matched.some(path => next.regex!.test(path)))) { skip(out, "CODEOWNERS rule overridden by a later line"); return; }
      kept.push({ ...rule, glob: rule.glob });
    });
    kept.sort((a, b) => a.glob.split("/").length - b.glob.split("/").length);
    for (const rule of kept) {
      const who = !rule.leadingTeams.length ? "its listed owners" : rule.leadingTeams.length === rule.handles ? list(rule.leadingTeams) : `${list(rule.leadingTeams)} and other listed owners`;
      add({
        proposal: proposal({
          key: `owners\n${owners}\n${rule.raw}`, kind: "fact", anchors: { scope: [rule.glob] },
          text: `Changes under ${code(rule.glob)} are reviewed by ${who} in ${code(owners)}.`,
          oneLine: `Changes under ${code(rule.glob)} are reviewed by ${who} in ${code(owners)}.`,
          label: label(`mined from code, 1 of ${total} rules in ${base(owners)}`, "mined from code, CODEOWNERS"),
          source: { type: "mined", ref: owners }, checks: [pattern(owners, rule.literal)],
        }),
        counts: [{ index: 0, want: "one" }],
      });
    }
  }
  return out;
}

interface OwnerRule {
  raw: string;
  glob?: string;
  regex?: RegExp;
  /** Owners listed on the line; 0 un-assigns the pattern. */
  handles: number;
  /** The teams (`@org/team`) the line lists before any personal handle or email. */
  leadingTeams: string[];
  /**
   * What the check counts: the line as written through its last leading team, so a change of
   * pattern or of a named team breaks it. A line that starts with a personal handle stores only
   * its pattern, so no handle is kept.
   */
  literal: string;
}
/** CODEOWNERS lines in file order, each with the files it can match. */
export function ownerRules(text: string): { rules: OwnerRule[]; total: number } {
  const rules: OwnerRule[] = [];
  let total = 0;
  for (const line of lines(text)) {
    const trimmed = line.trim();
    const words = [...trimmed.matchAll(/\S+/gu)];
    const raw = words[0]?.[0];
    if (!raw || raw.startsWith("#")) continue;
    const rest = words.slice(1);
    const comment = rest.findIndex(word => word[0].startsWith("#"));
    const handles = (comment < 0 ? rest : rest.slice(0, comment)).filter(word => word[0].includes("@"));
    if (handles.length) total++;
    const leading: RegExpExecArray[] = [];
    for (const handle of handles) { if (/^@[\w.-]+\/[\w.-]+$/u.test(handle[0])) leading.push(handle as RegExpExecArray); else break; }
    const last = leading.at(-1);
    const glob = ignoreStyleGlob(raw, true);
    rules.push({
      raw, glob, regex: glob ? globToRegExp(glob) : undefined, handles: handles.length,
      leadingTeams: leading.map(word => word[0]),
      literal: last ? trimmed.slice(0, last.index! + last[0].length) : raw,
    });
  }
  return { rules, total };
}
