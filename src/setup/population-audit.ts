import { existsSync, lstatSync, readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { basename, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { resolveSetupMode, setupTemplatesDirectory } from "./phases.js";
import { inventoryScaffold } from "../wiki/migration/inventory.js";

export const POPULATION_FILES = [
  "AGENTS.md",
  "ROUTER.md",
  "context/architecture.md",
  "context/stack.md",
  "context/conventions.md",
  "context/decisions.md",
  "context/setup.md",
] as const;

/** Seven fixed files, bounded reads, and no redirected scaffold directories. */
function populationFile(mexDir: string, file: string): string {
  const path = resolve(mexDir, file);
  let cursor = mexDir;
  for (const part of ["", ...file.split("/")]) {
    if (part) cursor = resolve(cursor, part);
    const stat = lstatSync(cursor);
    if (stat.isSymbolicLink() || (cursor === path
      ? !stat.isFile() || stat.size > 1_048_576 || stat.nlink > 1
      : !stat.isDirectory())) throw new Error(`Unsafe setup file: .mex/${file}`);
  }
  return path;
}

/** Compare knowledge, not template instructions, metadata or presentation. Older
 * releases changed all three without adding any project knowledge. */
function populationBody(file: typeof POPULATION_FILES[number], text: string): string {
  let body = text.replace(/\r\n/gu, "\n")
    .replace(/^---\n[\s\S]*?\n---(?:\n|$)/u, "")
    .replace(/<!--[\s\S]*?-->/gu, "");
  if (file === "AGENTS.md") {
    body = body.split(/^#{1,6}\s+(?:Project Knowledge|Code Graph|GROW|Scaffold Growth|Agent Logging|Heartbeat|Navigation)\s*$/mu)[0]!;
  } else if (file === "ROUTER.md") {
    const state = /^#{1,6}\s+Current (?:Project|Operational) State\s*\n([\s\S]*?)(?=^#{1,6}\s|$(?![\s\S]))/mu.exec(body);
    if (state) body = state[1]!;
  }
  return body.replace(/^\s*#{1,6}\s+.*$/gmu, "")
    .replace(/^\s*(?:last_updated|name):.*$/gmu, "")
    .replace(/\[(?:Project Name|YYYY-MM-DD|TO DETERMINE|Agent \/ Workspace Name)\]/gu, "")
    .replace(/\s+/gu, " ").trim();
}

/** Placeholder values and setup's Wiki stamps are not evidence of authored knowledge. */
export function isTemplatePopulationFile(mexDir: string, file: typeof POPULATION_FILES[number], text: string): boolean {
  const templates = setupTemplatesDirectory();
  const memory = resolve(templates, "agent-memory", file);
  const template = resolveSetupMode(mexDir) === "agent-memory" && existsSync(memory)
    ? memory : resolve(templates, file);
  const body = populationBody(file, text);
  return body.length === 0 || body === populationBody(file, readFileSync(template, "utf8"));
}

export function scaffoldIsAuthored(mexDir: string): boolean {
  return unpopulatedScaffoldFiles(mexDir).length === 0;
}

export function unpopulatedScaffoldFiles(mexDir: string): string[] {
  return POPULATION_FILES.filter(file => {
    try {
      const text = readFileSync(populationFile(mexDir, file), "utf8");
      return isTemplatePopulationFile(mexDir, file, text);
    } catch { return true; }
  });
}

export function populationPlaceholderFiles(mexDir: string): string[] {
  return POPULATION_FILES.filter(file => {
    const text = readFileSync(populationFile(mexDir, file), "utf8");
    return fillMetadataTokens(text, "2000-01-01", "Project") !== text;
  });
}

/** Only unambiguous template slots. Tokens in prose, examples, comments, nested
 * YAML and code are user content; their meaning cannot be inferred safely. */
function fillMetadataTokens(text: string, today: string, projectName: string): string {
  let after = text.replace(/^(---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))/u, (_match, open: string, yaml: string, close: string) =>
    open + yaml.replace(/^(last_updated:[ \t]*)(["']?)\[YYYY-MM-DD\]\2([ \t]*(?:#.*)?)(\r?)$/gmu,
      (_line, key: string, quote: string, suffix: string, cr: string) => `${key}${quote}${today}${quote}${suffix}${cr}`) + close);
  // The title slot occurs immediately after frontmatter, before any prose.
  after = after.replace(/^(---\r?\n[\s\S]*?\r?\n---\r?\n(?:[ \t]*\r?\n)*# )\[Project Name\]([ \t]*(?:\r?\n|$))/u,
    (_line, prefix: string, suffix: string) => prefix + projectName.replace(/[\r\n]/gu, " ") + suffix);
  return fillProseTokens(after, today, projectName);
}

/** A leftover token in an ordinary sentence ("last reviewed on [YYYY-MM-DD]") is a
 * missed template slot. Leave frontmatter, code, comments and any line that talks
 * about placeholders themselves, since there the token is literal text. */
function fillProseTokens(text: string, today: string, projectName: string): string {
  const head = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u.exec(text)?.[0] ?? "";
  const name = projectName.replace(/[\r\n]/gu, " ");
  let fence: string | null = null, comment = false;
  const body = text.slice(head.length).split(/(?<=\n)/u).map(line => {
    const bare = line.replace(/\r?\n$/u, "");
    const mark = /^ {0,3}(`{3,}|~{3,})/u.exec(bare)?.[1];
    if (fence !== null) { if (mark !== undefined && mark[0] === fence[0] && mark.length >= fence.length) fence = null; return line; }
    if (mark !== undefined) { fence = mark; return line; }
    if (comment) { if (bare.includes("-->")) comment = false; return line; }
    if (bare.includes("<!--")) { comment = !bare.includes("-->"); return line; }
    if (/^(?: {4}|\t)/u.test(bare) || /placeholder|literal|token|verbatim|template/iu.test(bare)) return line;
    return bare.split(/(`+[^`]*`+)/u).map((part, index) => index % 2 === 1 ? part
      : part.replaceAll("[YYYY-MM-DD]", today).replaceAll("[Project Name]", name)).join("") + line.slice(bare.length);
  }).join("");
  return head + body;
}

/** Explicit finalization only: replace known tokens, never ask an agent or create a plan. */
export function fillPopulationPlaceholders(projectRoot: string, mexDir: string, onMessage?: (message: string) => void): string[] {
  const today = new Date().toISOString().slice(0, 10);
  const projectName = basename(projectRoot);
  const messages: string[] = [];
  for (const file of POPULATION_FILES) {
    const path = populationFile(mexDir, file);
    const before = readFileSync(path, "utf8");
    if (isTemplatePopulationFile(mexDir, file, before)) continue;
    const after = fillMetadataTokens(before, today, projectName);
    if (after === before) continue;
    const temp = `${path}.setup-${randomUUID()}.tmp`;
    const stat = lstatSync(path);
    try {
      writeFileSync(temp, after, { flag: "wx", mode: stat.mode });
      populationFile(mexDir, file);
      if (readFileSync(path, "utf8") !== before) throw new Error(`Setup file changed: .mex/${file}`);
      renameSync(temp, path);
    } finally { rmSync(temp, { force: true }); }
    const message = `Filled setup placeholders in .mex/${file}.`;
    messages.push(message);
    onMessage?.(message);
  }
  return messages;
}

/** A bounded, parser-based post-population audit. Unsupported languages need no code facts. */
export function auditPopulation(
  mexDir: string,
  codeKnowledge: boolean,
): string[] {
  const inventory = inventoryScaffold({ scaffoldRoot: mexDir });
  if (
    inventory.diagnostics.some((entry) => entry.severity === "error") ||
    inventory.files.some((file) =>
      file.parsed.diagnostics.some((entry) => entry.severity === "error"),
    )
  )
    throw new Error("Population inventory is incomplete");
  const files = inventory.files;
  const entities = files.flatMap((file) =>
    file.parsed.entities.map((entry) => entry.entity),
  );
  const missing: string[] = [];
  if (
    !files.some(
      (file) =>
        file.path.startsWith("patterns/") &&
        !["patterns/README.md", "patterns/INDEX.md"].includes(file.path) &&
        populationBody("context/setup.md", file.text).length > 0,
    )
  )
    missing.push(
      "project patterns in .mex/patterns/ (README.md and INDEX.md do not count)",
    );
  if (
    codeKnowledge &&
    !entities.some(
      (entity) => entity.type === "fact" && entity.groundsTo.length > 0,
    )
  )
    missing.push("code-linked fact entities");
  const sections = files.flatMap((file) =>
    file.parsed.entities.filter((entry) => entry.metadataKind === "comment"),
  );
  if (
    codeKnowledge &&
    (sections.length === 0 ||
      sections.some(
        (entry) =>
          !entry.entity.relations.some(
            (relation) => relation.type === "refines",
          ),
      ))
  )
    missing.push("section-to-document refines links");
  return missing;
}

export async function populationWarning(
  projectRoot: string,
  mexDir: string,
  mode: "code-repo" | "agent-memory",
): Promise<string | null> {
  try {
    let codeKnowledge = false;
    if (mode === "code-repo") {
      const { inspectGraphStatus } = await import("../graph/status.js");
      const { parseHealth } = await inspectGraphStatus({ projectRoot });
      codeKnowledge = parseHealth.ok + parseHealth.partial > 0;
    }
    const missing = auditPopulation(mexDir, codeKnowledge);
    return missing.length
      ? `Warning: Population finished without ${missing.join("; ")}. Review the knowledge with mex check; setup will not repopulate it automatically.`
      : null;
  } catch {
    return "Warning: Population could not be audited. Run mex wiki validate to inspect the scaffold.";
  }
}
