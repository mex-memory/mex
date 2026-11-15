/**
 * `mex handoff`: hand the work on a branch to a teammate (plan sheet 56).
 *
 * MEX writes `.mex/handoffs/<branch>.md` with no AI call: the continuity block
 * the hooks keep (branch, uncommitted files, last ask, last failing command,
 * next-session items) plus one optional line in the author's own words. It
 * passes the secret scan and the new-words check, and the author sees a
 * preview before it is written. The author commits it; MEX never commits or
 * pushes. The hook delivers it once at session start on that branch.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { knowledgeProject, type KnowledgeOptions } from "./context.js";
import { KnowledgeError } from "./contract.js";
import { hasSecret, stripHidden } from "./gates.js";

export const HANDOFF_DIR = ".mex/handoffs";
const MAX_LINE = 280;

/** Same rule as native/capture/handoff.go HandoffSlug. */
export function handoffSlug(branch: string): string {
  let slug = branch.replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^[-.]+|[-.]+$/gu, "");
  if (slug.length > 100) slug = slug.slice(0, 100).replace(/[-.]+$/u, "");
  return slug || "branch";
}
export function handoffPath(branch: string): string { return `${HANDOFF_DIR}/${handoffSlug(branch)}.md`; }

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" } });
}
function tryGit(root: string, ...args: string[]): string | undefined {
  try { return git(root, ...args); } catch { return undefined; }
}

/** The snapshot the hooks keep: native/capture/continuity.go Continuity. */
interface Continuity {
  version: number; branch: string; checkout: string; head?: string; updated: string;
  last_ask?: string; last_failure?: { command: string; exit: number }; next_session?: string[];
}
function readContinuity(recordDirectory: string, checkout: string, branch: string): Continuity | undefined {
  const name = createHash("sha256").update(`${checkout}\0${branch}`, "utf8").digest("hex").slice(0, 24);
  const path = join(recordDirectory, "continuity", `${name}.json`);
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > 256 * 1024) return undefined;
    const value = JSON.parse(readFileSync(path, "utf8")) as Continuity;
    return value.version === 1 && value.branch === branch && value.checkout === checkout ? value : undefined;
  } catch { return undefined; }
}

function uncommitted(root: string): string[] {
  const out = tryGit(root, "status", "--porcelain=v1", "-z", "--untracked-files=normal") ?? "";
  const parts = out.split("\0"), names: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part.length < 4) continue;
    if (part[0] === "R" || part[0] === "C") i++;
    const name = part.slice(3);
    if (!name.startsWith(`${HANDOFF_DIR}/`)) names.push(name);
  }
  return names;
}

const flat = (text: string, max: number) => {
  const line = stripHidden(text).split("\n").map(l => l.trim().replace(/\s+/gu, " ")).find(Boolean) ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/**
 * The new-words check: names of people, hosts and addresses that the repo
 * doesn't already contain are private details a teammate's agent mustn't
 * receive from a personal session. Plain words can't be told apart from
 * names, so this catches specific shapes only: emails, hosts, IP addresses
 * and @handles.
 */
export function newWords(text: string, root: string): string[] {
  const candidates = new Set<string>();
  for (const m of text.matchAll(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/gu)) candidates.add(m[0]);
  const withoutEmails = text.replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/gu, " ");
  for (const m of withoutEmails.matchAll(/\b[a-z][\w-]*:\/\/([^\s/:?#@"'`]+)/giu)) candidates.add(m[1]);
  for (const m of withoutEmails.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/gu)) candidates.add(m[0]);
  for (const m of withoutEmails.matchAll(/(?<![\w/.])(?:[a-z0-9-]+\.)+(?:com|net|org|io|dev|app|cloud|internal|corp|lan|local|intranet|ai|co|us|uk|de|in)\b/giu)) candidates.add(m[0]);
  for (const m of withoutEmails.matchAll(/(?<![\w@])@([A-Za-z][\w-]{1,38})\b/gu)) candidates.add(`@${m[1]}`);
  const unknown: string[] = [];
  for (const word of candidates) {
    // git grep exits 1 when nothing matches; that's the new word.
    if (tryGit(root, "grep", "-q", "-F", "-I", "-e", word) === undefined) unknown.push(word);
  }
  return unknown;
}

export interface HandoffDraft {
  branch: string; path: string; root: string; content: string; replaces: boolean;
  /** Lines left out because they failed a check, with the reason. */
  held: Array<{ line: string; reason: string }>;
  uncommitted: string[];
}

export interface HandoffInput { line?: string; to?: string; now?: Date; }

function check(text: string, root: string): string | undefined {
  if (hasSecret(text)) return "looks like a secret";
  const fresh = newWords(text, root);
  if (fresh.length) return `names something the repo doesn't: ${fresh.join(", ")}`;
  return undefined;
}

/** Build the handoff and its preview. Writes nothing. */
export function draftHandoff(input: HandoffInput, options: KnowledgeOptions): HandoffDraft {
  const project = knowledgeProject(options);
  const root = project.root;
  const branch = tryGit(root, "symbolic-ref", "--quiet", "--short", "HEAD")?.trim();
  if (!branch) throw new KnowledgeError("NO_BRANCH", "A handoff belongs to a branch; check one out first.");
  const line = input.line === undefined ? undefined : flat(input.line, MAX_LINE);
  if (input.line !== undefined && !line) throw new KnowledgeError("INVALID_INPUT", "The handoff line is empty.");
  const to = input.to?.trim();
  if (to !== undefined && !/^[\p{L}\p{N} ._-]{1,60}$/u.test(to)) throw new KnowledgeError("INVALID_INPUT", "Name the receiver with letters, digits, spaces, dots or dashes.");
  if (line) {
    const problem = check(line, root);
    if (problem) throw new KnowledgeError(problem.startsWith("looks") ? "SECRET_FOUND" : "PRIVATE_DETAIL", `Your line ${problem}; reword it and run mex handoff again.`);
  }
  const from = flat(tryGit(root, "config", "user.name") ?? "", 60) || "a teammate";
  const snapshot = readContinuity(project.location.directory, root, branch);
  const files = uncommitted(root);
  const held: HandoffDraft["held"] = [];
  const lines: string[] = [];
  const add = (text: string) => {
    const problem = check(text, root);
    if (problem) held.push({ line: text, reason: problem }); else lines.push(text);
  };
  const head = tryGit(root, "rev-parse", "--short", "HEAD")?.trim();
  lines.push(`- Branch: ${branch}${head ? ` (at ${head})` : ""}`);
  if (snapshot?.last_ask) add(`- Last ask: "${flat(snapshot.last_ask, 160)}"`);
  if (snapshot?.last_failure) add(`- Last failing command: \`${flat(snapshot.last_failure.command, 120)}\` (exit ${snapshot.last_failure.exit})`);
  if (files.length) add(`- Uncommitted when handed off: ${files.slice(0, 5).join(", ")}${files.length > 5 ? ` and ${files.length - 5} more` : ""}`);
  for (const item of (snapshot?.next_session ?? []).slice(0, 3)) add(`- Next session: ${flat(item, 160)}`);
  if (line) lines.push(`- From ${from}: ${line}`);
  const created = (input.now ?? new Date()).toISOString().slice(0, 10);
  const front = ["---", "mex: handoff", "version: 1", `branch: ${JSON.stringify(branch)}`, `from: ${JSON.stringify(from)}`, ...(to ? [`to: ${JSON.stringify(to)}`] : []), `created: ${created}`, "---"];
  const heading = `${from} handed off ${branch}${to ? ` to ${to}` : ""}:`;
  const content = `${front.join("\n")}\n${heading}\n${lines.join("\n")}\n`;
  if (hasSecret(content)) throw new KnowledgeError("SECRET_FOUND", "The handoff looks like it holds a secret and was not written.");
  const path = handoffPath(branch);
  let replaces = false;
  try { replaces = lstatSync(join(root, path)).isFile(); } catch { /* none yet */ }
  return { branch, path, root, content, replaces, held, uncommitted: files };
}

function safeHandoffDir(root: string, create: boolean): string {
  let dir = root;
  for (const part of HANDOFF_DIR.split("/")) {
    dir = join(dir, part);
    let stat;
    try { stat = lstatSync(dir); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !create) throw error;
      mkdirSync(dir); stat = lstatSync(dir);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new KnowledgeError("UNSAFE_PATH", `${HANDOFF_DIR} is not a plain folder.`);
  }
  return dir;
}

/** Write a previewed draft. Nothing is committed or pushed. */
export function writeHandoff(draft: HandoffDraft): string {
  const dir = safeHandoffDir(draft.root, true);
  const file = join(draft.root, draft.path);
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new KnowledgeError("UNSAFE_PATH", `${draft.path} is not a plain file.`);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const temp = join(dir, `.${handoffSlug(draft.branch)}.${process.pid}.tmp`);
  writeFileSync(temp, draft.content, { flag: "wx", mode: 0o644 });
  try { renameSync(temp, file); } catch (error) { try { unlinkSync(temp); } catch { /* gone */ } throw error; }
  return file;
}

/** `mex handoff done`: delete the branch's handoff from the working tree. */
export function closeHandoff(options: KnowledgeOptions, branch?: string): { branch: string; path: string; removed: boolean; tracked: boolean } {
  const project = knowledgeProject(options);
  const root = project.root;
  const name = branch ?? tryGit(root, "symbolic-ref", "--quiet", "--short", "HEAD")?.trim();
  if (!name) throw new KnowledgeError("NO_BRANCH", "Check out the handoff's branch, or name it with --branch.");
  const path = handoffPath(name);
  const file = join(root, path);
  let stat;
  try { stat = lstatSync(file); } catch { return { branch: name, path, removed: false, tracked: false }; }
  safeHandoffDir(root, false);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new KnowledgeError("UNSAFE_PATH", `${path} is not a plain file.`);
  const tracked = tryGit(root, "ls-files", "--error-unmatch", "--", path) !== undefined;
  unlinkSync(file);
  return { branch: name, path, removed: true, tracked };
}

/** The branch a pull request most likely targets: the remote's default, else main or master. */
export function isDefaultBranch(root: string, base: string): boolean {
  const remoteDefault = tryGit(root, "symbolic-ref", "--quiet", "refs/remotes/origin/HEAD")?.trim();
  const names = new Set(["main", "master", "origin/main", "origin/master", "refs/heads/main", "refs/heads/master", "refs/remotes/origin/main", "refs/remotes/origin/master"]);
  if (remoteDefault) {
    const short = remoteDefault.replace(/^refs\/remotes\/origin\//u, "");
    names.clear();
    for (const n of [short, `origin/${short}`, `refs/heads/${short}`, remoteDefault]) names.add(n);
  }
  return names.has(base);
}

/** Handoffs a branch adds or changes. Left in a pull request to the default branch, each one is a problem. */
export function handoffLeftovers(root: string, base: string): Array<{ path: string; proven: boolean }> {
  const out = tryGit(root, "diff", "--name-only", "--no-renames", "--diff-filter=AM", `${base}...HEAD`, "--", HANDOFF_DIR) ?? "";
  const proven = isDefaultBranch(root, base);
  return out.split("\n").filter(p => p.startsWith(`${HANDOFF_DIR}/`) && p.endsWith(".md")).map(path => ({ path, proven }));
}
