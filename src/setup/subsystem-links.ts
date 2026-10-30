/** Serial, replayable reconciliation of setup navigation; agents return data, never edit indexes. */
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseDocument } from "yaml";
import { SHARED_CONTEXT_FILES } from "./prompts.js";
import { subsystemWikiFile, unitBatchFile, type SetupPlanState } from "./subsystem-state.js";

interface Link { target: string; condition: string }
interface Pattern { file: string; content: string }
interface Navigation { links: Link[]; patterns: Pattern[] }
const MAX_BATCH_BYTES = 8 * 1024 * 1024;

/** The optional setup property belongs to the transport, not the Wiki operation schema. */
export function readSetupBatch(path: string): { operations: unknown[]; navigation: Navigation; extended: boolean } {
  try { return parseSetupBatch(path); }
  catch (error) { throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`); }
}

function parseSetupBatch(path: string): { operations: unknown[]; navigation: Navigation; extended: boolean } {
  if (statSync(path).size > MAX_BATCH_BYTES) throw new Error("Setup batch exceeds 8 MB; split or shorten the batch and rerun mex setup.");
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  const operations = Array.isArray(raw) ? raw : [raw];
  const navigation: Navigation = { links: [], patterns: [] };
  let extended = false;
  const clean = operations.map((entry) => {
    if (!entry || typeof entry !== "object" || !("setup" in entry)) return entry;
    extended = true;
    const { setup, ...operation } = entry as Record<string, unknown>;
    if (!setup || typeof setup !== "object" || Array.isArray(setup)) throw new Error("setup must contain links and patterns arrays");
    const data = setup as Record<string, unknown>;
    if (data.links !== undefined) {
      if (!Array.isArray(data.links) || data.links.length > 32) throw new Error("setup.links must hold at most 32 links");
      for (const link of data.links) {
        if (!link || typeof link.target !== "string" || !/^(context|patterns)\/[a-z0-9][a-z0-9-]*\.md$/u.test(link.target)
          || typeof link.condition !== "string" || !link.condition.trim() || link.condition.length > 300) throw new Error("Each setup link needs a scaffold target and a short condition");
        navigation.links.push({ target: link.target, condition: link.condition.trim() });
      }
    }
    if (data.patterns !== undefined) {
      if (!Array.isArray(data.patterns) || data.patterns.length > 3) throw new Error("setup.patterns must hold at most 3 patterns");
      for (const pattern of data.patterns) {
        if (!pattern || typeof pattern.file !== "string" || !/^patterns\/[a-z0-9][a-z0-9-]*\.md$/u.test(pattern.file)
          || ["patterns/index.md", "patterns/readme.md"].includes(pattern.file) || typeof pattern.content !== "string" || pattern.content.length > 40_000) throw new Error("Invalid setup pattern file or content");
        const parsed = frontmatter(pattern.content);
        if (!parsed || typeof parsed.doc.get("name") !== "string" || typeof parsed.doc.get("description") !== "string"
          || !["Context", "Steps", "Gotchas", "Verify", "Debug", "Update Scaffold"].every((heading) => pattern.content.includes(`## ${heading}`))) throw new Error("Setup pattern must follow patterns/README.md, including frontmatter and task sections");
        navigation.patterns.push(pattern);
      }
    }
    return Object.keys(operation).length === 0 ? undefined : operation;
  });
  if (navigation.links.length > 32 || navigation.patterns.length > 3) throw new Error("Put setup metadata on the first operation only");
  return { operations: clean.filter((entry) => entry !== undefined), navigation, extended };
}

/** Split transport metadata before the shared Wiki applier validates operations. */
export function setupOperationsFile(projectRoot: string, batchFile: string): string {
  const path = resolve(projectRoot, batchFile);
  if (!existsSync(path)) return batchFile;
  const batch = readSetupBatch(path);
  if (!batch.extended) return batchFile;
  const operationsFile = batchFile.replace(/\.json$/u, ".operations.json");
  writeFileSync(resolve(projectRoot, operationsFile), JSON.stringify(batch.operations));
  return operationsFile;
}

function frontmatter(text: string, file?: string) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(text);
  if (!match) return null;
  const doc = parseDocument(match[1]);
  if (doc.errors.length || !doc.contents || !doc.toJS() || Array.isArray(doc.toJS()) || typeof doc.toJS() !== "object") throw new Error(`Invalid setup frontmatter${file ? ` in .mex/${file}` : ""}`);
  return { doc, body: text.slice(match[0].length) };
}

/** Refuse symlink destinations even if an agent or user substituted them during setup. */
function safeFile(root: string, file: string): string {
  if (lstatSync(root).isSymbolicLink()) throw new Error("Setup cannot write through a symlinked .mex directory; replace it and rerun mex setup.");
  let path = root;
  for (const part of file.split("/")) {
    path = resolve(path, part);
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error(`Setup cannot write through symlink ${file}; replace it with a regular file and rerun mex setup.`);
  }
  return path;
}

function addEdges(root: string, file: string, links: readonly Link[]) {
  const path = safeFile(root, file);
  if (!existsSync(path)) return;
  const text = readFileSync(path, "utf8");
  const parsed = frontmatter(text, file);
  if (!parsed) return;
  const prior: unknown = parsed.doc.toJS().edges;
  const edges = new Map<string, Link>();
  for (const link of [...(Array.isArray(prior) ? prior : []), ...links]) {
    if (link && typeof link.target === "string" && /^(context|patterns)\/[a-z0-9][a-z0-9-]*\.md$/u.test(link.target)
      && typeof link.condition === "string" && link.target !== file && existsSync(safeFile(root, link.target))) edges.set(link.target, link);
  }
  parsed.doc.set("edges", [...edges.values()].sort((a, b) => a.target.localeCompare(b.target)));
  const next = `---\n${String(parsed.doc)}---\n${parsed.body}`;
  if (next !== text) writeFileSync(path, next);
}

function rows(root: string, file: string, title: string, values: readonly string[]) {
  const path = safeFile(root, file);
  if (!existsSync(path)) return;
  const text = readFileSync(path, "utf8");
  const start = `<!-- mex:setup-${title}:start -->`;
  const end = `<!-- mex:setup-${title}:end -->`;
  const from = text.indexOf(start), to = text.indexOf(end);
  const authored = from >= 0 && to >= from ? text.slice(0, from) + text.slice(to + end.length) : text;
  const missing = values.filter((value) => {
    const file = /`([^`]+\.md)`/u.exec(value)?.[1];
    return file === undefined || !authored.split(/\r?\n/u).some((line) => line.startsWith("|") && line.includes(`\`${file}\``));
  });
  const block = `${start}\n${missing.join("\n")}\n${end}`;
  const next = from >= 0 && to >= from ? text.slice(0, from) + block + text.slice(to + end.length) : `${text.trimEnd()}\n\n${block}\n`;
  if (next !== text) writeFileSync(path, next);
}

const cell = (text: string) => text.replace(/[|\r\n]/gu, " ").slice(0, 300);

export function reconcileSetupNavigation(projectRoot: string, state: SetupPlanState): void {
  const root = resolve(projectRoot, ".mex");
  const links = new Map<string, Link[]>();
  const routeRows: string[] = [];
  let patternCount = existsSync(resolve(root, "patterns")) ? readdirSync(resolve(root, "patterns")).filter((file) => file.endsWith(".md") && !["README.md", "INDEX.md"].includes(file)).length : 0;
  const units = [{ slug: "shared", state: state.shared.state }, ...state.subsystems];
  for (const unit of units) {
    if (unit.state !== "done") continue;
    const batch = resolve(projectRoot, unitBatchFile(unit.slug));
    const navigation = existsSync(batch) ? readSetupBatch(batch).navigation : { links: [], patterns: [] };
    for (const pattern of navigation.patterns.slice(0, unit.slug === "shared" ? 3 : 1)) {
      const path = safeFile(root, pattern.file);
      if (existsSync(path) || patternCount >= 5) continue;
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, pattern.content);
      patternCount += 1;
    }
    if (unit.slug === "shared") continue;
    const file = subsystemWikiFile(unit.slug);
    if (!existsSync(safeFile(root, file))) continue;
    links.set(file, navigation.links.length ? navigation.links : [
      { target: SHARED_CONTEXT_FILES[0], condition: "when understanding this subsystem in the overall architecture" },
      { target: SHARED_CONTEXT_FILES[2], condition: "when changing code in this subsystem" },
    ]);
    const subsystem = state.subsystems.find((entry) => entry.slug === unit.slug)!;
    routeRows.push(`| Working in ${cell(subsystem.path)}/ | \`${file}\` |`);
  }
  // A reverse edge carries the same authored condition: it does not invent a new dependency.
  for (const [source, targets] of [...links]) for (const link of targets) {
    if (!existsSync(safeFile(root, link.target))) continue;
    const reverse = links.get(link.target) ?? [];
    if (!reverse.some((entry) => entry.target === source)) reverse.push({ target: source, condition: link.condition });
    links.set(link.target, reverse);
  }
  for (const [file, targets] of links) addEdges(root, file, targets);
  const patterns = existsSync(resolve(root, "patterns")) ? readdirSync(resolve(root, "patterns")).filter((file) => /^[a-z0-9][a-z0-9-]*\.md$/u.test(file)).sort() : [];
  const patternRows: string[] = [];
  for (const file of patterns) {
    const pattern = `patterns/${file}`;
    addEdges(root, pattern, [{ target: "context/architecture.md", condition: "when orienting this task in the overall architecture" }]);
    const parsed = frontmatter(readFileSync(safeFile(root, pattern), "utf8"));
    const description = String(parsed?.doc.get("description") ?? "Recurring project task");
    patternRows.push(`| [\`${file}\`](${file}) | ${cell(description)} |`);
    // Every context file a pattern relies on points back to it, so the pattern is reachable from context.
    const edges = (parsed?.doc.toJS() as { edges?: Array<{ target?: unknown }> } | null)?.edges ?? [];
    for (const edge of edges) {
      if (typeof edge?.target !== "string" || !/^context\/[a-z0-9][a-z0-9-]*\.md$/u.test(edge.target) || !existsSync(safeFile(root, edge.target))) continue;
      // An authored edge to the pattern keeps its own condition.
      const existing = (frontmatter(readFileSync(safeFile(root, edge.target), "utf8"))?.doc.toJS() as { edges?: Array<{ target?: unknown }> } | null)?.edges ?? [];
      if (existing.some((entry) => entry?.target === pattern)) continue;
      addEdges(root, edge.target, [{ target: pattern, condition: `when doing this task: ${cell(description).slice(0, 120)}` }]);
    }
  }
  rows(root, "ROUTER.md", "routes", ["| Task type | Load |", "|-----------|------|", ...routeRows]);
  rows(root, "patterns/INDEX.md", "patterns", ["| Pattern | Use when |", "|---------|----------|", ...patternRows]);
}
