import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { opendirSync } from "node:fs";
import { join } from "node:path";
import { projectIdentity } from "../record/project.js";
import { atomicCreateArtifact, atomicReplaceArtifact } from "../team/artifacts/filesystem.js";
import { revisionOf } from "../team/artifacts/revision.js";
import { canonicalFileDiff } from "../team/artifacts/unified-diff.js";
import type { RepoRelativePath } from "../team/contracts/shared.js";
import { ENTRY_KINDS, EntryIdSchema, KNOWLEDGE_LIMITS, KnowledgeError, assertPersonQuote, parseEntry, serializeEntry, type KnowledgeEntry } from "./entry.js";
import { containedDirectory, readEntryFile } from "./files.js";
import { gateEntry, sanitizeText } from "./gates.js";
import { entryLabel } from "./labels.js";
import { references, repoFile, type References } from "./references.js";
import type { KnowledgeOptions } from "./store.js";

export interface TeamEntry { level: "team"; label: string; branch: "default" | "branch" | "unknown"; entry: KnowledgeEntry; }
export interface TeamPreview { id: string; path: string; revision: string; before: string | null; after: string; diff: string; }
const ROOT = ".mex/learned";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const rootFor = (options: KnowledgeOptions) => projectIdentity(options.projectPath).rootPath;
function defaultEntries(root: string): Map<string, string> | undefined {
  for (const ref of ["refs/remotes/origin/HEAD", "refs/heads/main", "refs/heads/master"]) {
    try {
      const output = execFileSync("git", ["-C", root, "ls-tree", "-r", "-z", ref, "--", ROOT],
        { encoding: "utf8", timeout: 1500, maxBuffer: 2 * 1024 * 1024, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
      return new Map(output.split("\0").flatMap(line => {
        const match = /^\d+ blob ([a-f0-9]{40,64})\t(.+)$/u.exec(line);
        return match ? [[match[2], match[1]]] : [];
      }));
    } catch { /* Unknown default branch is explicitly labelled, never assumed. */ }
  }
  return undefined;
}
function branchStatus(path: string, content: string, baseline: Map<string, string> | undefined): TeamEntry["branch"] {
  if (!baseline) return "unknown";
  const expected = baseline.get(path);
  if (!expected) return "branch";
  const bytes = Buffer.from(content);
  const actual = createHash(expected.length === 64 ? "sha256" : "sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
  return actual === expected ? "default" : "branch";
}

function teamFiles(root: string): Array<{ id: string; path: string }> {
  const directory = containedDirectory(root, [".mex", "learned"]);
  if (!directory) return [];
  const files: Array<{ id: string; path: string }> = [], ids = new Set<string>();
  let seen = 0;
  const scan = (folder: string, prefix: string, nested = false) => {
    const handle = opendirSync(folder);
    try {
      let child;
      while ((child = handle.readSync())) {
        if (++seen > KNOWLEDGE_LIMITS.entries) throw new KnowledgeError("STORE_LIMIT", "Team entries exceed the directory scan limit.");
        if (child.isSymbolicLink()) throw new KnowledgeError("UNSAFE_STORE", "Team entry storage contains a redirected file or directory.");
        if (child.isDirectory() && !nested && (ENTRY_KINDS as readonly string[]).includes(child.name)) {
          const inner = containedDirectory(root, [".mex", "learned", child.name])!;
          scan(inner, `${prefix}/${child.name}`, true); continue;
        }
        if (!/^mx_[a-z0-9]{6,64}\.md$/u.test(child.name)) continue;
        const id = child.name.slice(0, -3);
        if (ids.has(id)) throw new KnowledgeError("DUPLICATE_ID", "A team entry id appears in more than one file.");
        ids.add(id); files.push({ id, path: `${prefix}/${child.name}` });
      }
    } finally { handle.closeSync(); }
  };
  scan(directory, ROOT);
  return files.sort((a, b) => a.id.localeCompare(b.id));
}

function verifyEvidence(entry: KnowledgeEntry, root: string, typedText?: string): void {
  const { source, evidence } = entry.mex;
  if (source.type === "person" && evidence === "person") {
    if (typedText !== undefined) assertPersonQuote(entry, typedText);
    return;
  }
  if ((source.type === "ci" && evidence === "ci")
    || (["docs", "config", "rule-file"].includes(source.type) && evidence === "docs")) {
    if (source.type === "ci" && !/^\.github\/workflows\/.+\.ya?ml$/u.test(source.ref)) throw new KnowledgeError("TEAM_EVIDENCE", "CI evidence must name a repository workflow.");
    if (!repoFile(root, source.ref)) throw new KnowledgeError("TEAM_EVIDENCE", "Team evidence must name an existing repository source.");
    return;
  }
  if (source.type === "review" && evidence === "review") {
    const pulls = new Set(entry.mex.checks.filter(check => check.kind === "source" && "url" in check.target)
      .map(check => check.kind === "source" && "url" in check.target ? /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/u.exec(check.target.url)?.[0] : undefined).filter(Boolean));
    if (pulls.size >= 2) return;
  }
  throw new KnowledgeError("TEAM_EVIDENCE", "Unconfirmed observations cannot become team entries; use person or repository evidence.");
}

function readAt(root: string, item: { id: string; path: string }): { entry: KnowledgeEntry; content: string } | undefined {
  const content = readEntryFile(join(root, item.path));
  if (content === undefined) return undefined;
  const entry = parseEntry(content);
  if (entry.mex.id !== item.id) throw new KnowledgeError("INVALID_ENTRY", "Team entry id does not match its filename.");
  return { entry, content };
}
export function teamEntries(options: KnowledgeOptions, source?: References): { entries: TeamEntry[]; withheld: number } {
  const root = rootFor(options), files = teamFiles(root);
  if (!files.length) return { entries: [], withheld: 0 };
  const context = source ?? references(root);
  const baseline = defaultEntries(root);
  const entries: TeamEntry[] = [];
  let bytes = 0, withheld = 0;
  for (const item of files) {
    const found = readAt(root, item);
    if (!found) continue;
    bytes += Buffer.byteLength(found.content);
    if (bytes > KNOWLEDGE_LIMITS.scanBytes) throw new KnowledgeError("STORE_LIMIT", "Team entries exceed the byte scan limit.");
    if (found.entry.mex.status === "retired") continue;
    try {
      verifyEvidence(found.entry, root);
      const entry = gateEntry(found.entry, context);
      entries.push({ level: "team", label: entryLabel(entry, "team"), branch: branchStatus(item.path, found.content, baseline), entry });
    } catch (error) {
      if (!(error instanceof KnowledgeError) || !["SECRET_FOUND", "TEAM_EVIDENCE", "UNVERIFIED_SOURCE"].includes(error.code)) throw error;
      withheld++;
    }
  }
  return { entries, withheld };
}
export function expandTeam(id: string, options: KnowledgeOptions): TeamEntry | undefined {
  if (!EntryIdSchema.safeParse(id).success) throw new KnowledgeError("INVALID_ID", "Invalid entry id.");
  const root = rootFor(options), item = teamFiles(root).find(item => item.id === id);
  const found = item && readAt(root, item);
  if (!found || found.entry.mex.status !== "active") return undefined;
  verifyEvidence(found.entry, root);
  const entry = gateEntry(found.entry, references(root));
  return { level: "team", label: entryLabel(entry, "team"), branch: branchStatus(item!.path, found.content, defaultEntries(root)), entry };
}

/** Pure preparation: callers must show the exact diff before applying it. */
export function prepareTeamWrite(input: KnowledgeEntry, options: KnowledgeOptions, typedText?: string): TeamPreview {
  const root = rootFor(options), context = references(root);
  const entry = gateEntry(input, context);
  verifyEvidence(entry, root, typedText === undefined ? undefined : sanitizeText(typedText, context));
  const existing = teamFiles(root).find(item => item.id === entry.mex.id);
  const path = existing?.path ?? `${ROOT}/${entry.mex.id}.md`;
  const before = existing ? readAt(root, existing)?.content ?? null : null;
  if (before && parseEntry(before).mex.status === "retired") throw new KnowledgeError("RETIRED_ENTRY", "A retired team entry cannot be restored.");
  if (!before && entry.mex.source.type === "person" && typedText === undefined) throw new KnowledgeError("UNVERIFIED_SOURCE", "A new person-sourced team entry requires the actual typed text.");
  const after = serializeEntry(entry);
  const revision = hash(JSON.stringify({ root, path, before, after }));
  return { id: entry.mex.id, path, revision, before, after, diff: canonicalFileDiff(path as RepoRelativePath, before, after) };
}

export function applyTeamWrite(preview: TeamPreview, expected: string, options: KnowledgeOptions, typedText?: string): TeamEntry {
  const root = rootFor(options);
  const fresh = prepareTeamWrite(parseEntry(preview.after), options, typedText);
  if (fresh.revision !== expected || preview.revision !== expected || fresh.path !== preview.path) throw new KnowledgeError("STALE_PREVIEW", "The entry or proposed change changed; preview it again.");
  try {
    if (fresh.before === null) atomicCreateArtifact(root, fresh.path as RepoRelativePath, fresh.after);
    else atomicReplaceArtifact(root, fresh.path as RepoRelativePath, revisionOf(fresh.before), fresh.after, KNOWLEDGE_LIMITS.entryBytes);
  } catch (error) {
    const code = (error as { problem?: { code?: string } }).problem?.code;
    if (code === "REVISION_CONFLICT") throw new KnowledgeError("STALE_PREVIEW", "The entry changed; preview it again.");
    throw error;
  }
  const entry = parseEntry(fresh.after);
  return { level: "team", label: entryLabel(entry, "team"), branch: branchStatus(fresh.path, fresh.after, defaultEntries(root)), entry };
}
