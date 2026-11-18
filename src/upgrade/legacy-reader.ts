/**
 * Read canonical 0.8 files for upgrade. Never reads wiki.db, maintains an
 * index, creates local/global state, or decides what knowledge to promote.
 * Only the legacy Markdown codec and discovery glob matcher are retained Wiki
 * dependencies; no engine, index/store, operations or migration service runs.
 */
import { parseWikiMarkdown, type ParsedFile } from "../wiki/markdown/contract.js";
import { parseDocument } from "../wiki/markdown/parse.js";
import { validateGrounding } from "../wiki/model/grounding.js";
import { rootContext } from "../wiki/model/validate.js";
import YAML from "yaml";
import { matchesAnyGlob } from "../wiki/index/discover.js";
import { LegacyFiles, LegacyReadError, LEGACY_LIMITS, type LegacySource } from "./legacy-files.js";

export interface LegacyDiagnostic {
  code: string;
  path: string;
  severity: "error" | "warning" | "info";
  /** A source line, when the problem belongs to a JSONL row. */
  line?: number;
}

export interface LegacyDocument extends LegacySource {
  kind: "instructions" | "router" | "context" | "pattern" | "wiki" | "obsolete";
  /** Codec paths are scaffold-relative. Source paths above are repo-relative. */
  parsed: ParsedFile;
}

export interface LegacyLogRow {
  line: number;
  /** Original fields, including any attribution: never replaced by the reader. */
  value: Readonly<Record<string, unknown>>;
}

export interface LegacySnapshot {
  present: boolean;
  /** False means conversion must refuse; partial evidence is for inspection. */
  complete: boolean;
  documents: LegacyDocument[];
  config?: LegacySource;
  log?: LegacySource;
  logRows: LegacyLogRow[];
  /** Preserved by beta.1. These are not Wiki conversion inputs. */
  retained: LegacySource[];
  /** Excluded documents remain on disk and are not conversion inputs. */
  excluded: string[];
  diagnostics: LegacyDiagnostic[];
}

const RESERVED = new Set(["team", "workstreams", "inbox", "relays", "playbooks"]);
const SKIP = new Set(["local", "eval-results", "diagrams", "learned", "node_modules", ".git"]);
const ROOT_INSTRUCTIONS = ["AGENTS.md", "CLAUDE.md"];

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function kind(path: string): LegacyDocument["kind"] {
  if (path === "AGENTS.md") return "instructions";
  if (path === "ROUTER.md") return "router";
  if (path === "SETUP.md" || path === "SYNC.md") return "obsolete";
  if (path.startsWith("context/")) return "context";
  if (path.startsWith("patterns/")) return "pattern";
  return "wiki";
}

/**
 * Returns original source and parsed entities/groundings, never a new baseline
 * or a freshness verdict. Works without Git, any database, or a MEX home.
 */
export function readLegacyScaffold(projectRoot: string): LegacySnapshot {
  const snapshot: LegacySnapshot = { present: false, complete: true, documents: [], logRows: [], retained: [], excluded: [], diagnostics: [] };
  let omitted = 0;
  const report = (code: string, path: string, line?: number, severity: LegacyDiagnostic["severity"] = "error"): void => {
    if (severity !== "info") snapshot.complete = false;
    if (snapshot.diagnostics.length < LEGACY_LIMITS.diagnostics - 1) snapshot.diagnostics.push({ code, path, severity, ...(line === undefined ? {} : { line }) });
    else omitted++;
  };
  const attempt = <T>(path: string, action: () => T): T | undefined => {
    try { return action(); }
    catch (error) {
      // Limits stop the whole scan, rather than continuing unbounded work.
      if (error instanceof LegacyReadError && error.code === "LEGACY_LIMIT") throw error;
      report(error instanceof LegacyReadError ? error.code : "LEGACY_UNREADABLE", path);
      return undefined;
    }
  };
  try {
    const files = new LegacyFiles(projectRoot);
    snapshot.present = files.directory(".mex");
    if (!snapshot.present) { files.verify(); return snapshot; }
    snapshot.config = files.read(".mex/config.json");
    let exclude = ["**/node_modules/**"];
    if (snapshot.config) {
      try {
        const config: unknown = JSON.parse(snapshot.config.text.replace(/^\uFEFF/u, ""));
        if (!record(config)) throw new Error();
        if (config.wiki !== undefined && !record(config.wiki)) throw new Error();
        const supplied = record(config.wiki) ? config.wiki.exclude : undefined;
        if (supplied !== undefined) {
          if (!Array.isArray(supplied) || supplied.length > LEGACY_LIMITS.excludePatterns
            || supplied.some(item => typeof item !== "string" || !item.trim() || Buffer.byteLength(item, "utf8") > LEGACY_LIMITS.patternBytes)) throw new Error();
          if (supplied.length) exclude = supplied;
        }
      } catch { report("LEGACY_INVALID_CONFIG", ".mex/config.json"); }
    }
    const ids = new Set<string>();
    const document = (source: LegacySource, path: string, type = kind(path)): void => {
      const parsed = parseWikiMarkdown({ path, text: source.text });
      // A document the parser can't read stays where it is for people and
      // yields no entries; it doesn't hold up every other document's upgrade.
      if (parsed.diagnostics.some(d => d.code === "WIKI_PARSE_ERROR")) {
        snapshot.retained.push(source);
        report("LEGACY_DOCUMENT_UNREADABLE", source.path, undefined, "info");
        return;
      }
      snapshot.documents.push({ ...source, kind: type, parsed });
      for (const diagnostic of parsed.diagnostics) {
        // Root-only groundings are the older 0.8 shape; the decoder already
        // reads them as the file entity's own, so they need no person.
        const severity = diagnostic.code === "GROUNDING_MIXED_SHAPE" && diagnostic.severity !== "warning" ? "info" : diagnostic.severity;
        // Codes and locations only. Parser messages can contain private prose.
        report(diagnostic.code, source.path, undefined, severity);
      }
      // Indexing tolerates malformed root groundings by skipping them. Upgrade
      // must not advertise a complete conversion input after losing evidence.
      // Use the existing AST and grounding validator, without assigning a root
      // grounding to a section or changing the decoder's legacy semantics.
      const frontmatter = parseDocument(source.text).frontmatter;
      if (frontmatter) {
        try {
          const yaml = YAML.parseDocument(frontmatter.text);
          if (yaml.errors.length === 0) {
            const root: unknown = yaml.toJS();
            if (record(root) && Object.hasOwn(root, "grounds_to")) {
              if (!Array.isArray(root.grounds_to)
                || root.grounds_to.some(value => !validateGrounding(value, rootContext({ file: path })).ok)) {
                report("LEGACY_INVALID_GROUNDING", source.path);
              }
            }
          }
        } catch { report("LEGACY_INVALID_GROUNDING", source.path); }
      }
      for (const { entity } of parsed.entities) {
        if (ids.has(entity.id)) report("LEGACY_DUPLICATE_ENTITY_ID", source.path);
        ids.add(entity.id);
      }
    };
    const walk = (directory: string): void => {
      const entries = attempt(directory, () => files.list(directory));
      for (const entry of entries ?? []) {
        const path = entry.path.slice(".mex/".length);
        const parts = path.split("/");
        if (SKIP.has(parts[0]) || parts.includes("node_modules") || parts.includes(".git")) continue;
        if (entry.unsafe) { report("LEGACY_UNSAFE_PATH", entry.path); continue; }
        const retained = RESERVED.has(parts[0]) || path.startsWith("events/activity/");
        const excluded = !retained && exclude.some(pattern => matchesAnyGlob(path, [pattern])
          || (entry.directory && pattern.endsWith("/**") && matchesAnyGlob(path, [pattern.slice(0, -3)])));
        if (excluded) { snapshot.excluded.push(entry.path); continue; }
        if (entry.directory) { walk(entry.path); continue; }
        if (!/\.mdx?$/iu.test(path) || path === "config.json") continue;
        const source = attempt(entry.path, () => files.read(entry.path));
        if (!source) continue;
        if (retained) snapshot.retained.push(source);
        else document(source, path);
      }
    };
    walk(".mex");
    for (const path of ROOT_INSTRUCTIONS) {
      const source = attempt(path, () => files.read(path));
      if (source) document(source, path, "instructions");
    }
    snapshot.log = attempt(".mex/events/decisions.jsonl", () => files.read(".mex/events/decisions.jsonl"));
    if (snapshot.log) {
      const content = snapshot.log.text.replace(/^\uFEFF/u, "");
      let offset = 0, line = 0;
      while (offset < content.length) {
        if (++line > LEGACY_LIMITS.logRows) { report("LEGACY_LIMIT", snapshot.log.path, line); break; }
        const newline = content.indexOf("\n", offset);
        const end = newline === -1 ? content.length : newline;
        const text = content.slice(offset, end).replace(/\r$/u, "");
        offset = newline === -1 ? content.length : newline + 1;
        if (!text.trim()) continue;
        try {
          if (Buffer.byteLength(text, "utf8") > LEGACY_LIMITS.logLineBytes) throw new Error();
          const value: unknown = JSON.parse(text);
          if (!record(value) || typeof value.kind !== "string" || typeof value.message !== "string"
            || typeof value.timestamp !== "string" || Number.isNaN(Date.parse(value.timestamp))) throw new Error();
          snapshot.logRows.push({ line, value });
        } catch { report("LEGACY_INVALID_LOG_ROW", snapshot.log.path, line); }
      }
    }
    files.verify();
  } catch (error) {
    report(error instanceof LegacyReadError ? error.code : "LEGACY_UNREADABLE", error instanceof LegacyReadError ? error.path : ".mex");
  }
  if (omitted) snapshot.diagnostics.push({ code: "LEGACY_DIAGNOSTICS_OMITTED", path: ".mex", severity: "info" });
  snapshot.documents.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return snapshot;
}
