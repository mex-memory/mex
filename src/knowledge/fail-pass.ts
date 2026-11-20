/**
 * Fail→pass capture: a command that failed and then passed in one session
 * becomes a recipe. Three transitions count, each strict:
 *  - variant: C fails, then C with other environment assignments passes, with
 *    nothing but reads between;
 *  - prep: C fails, then one to three safe preparation commands succeed (install,
 *    build, generate, migrate), then exactly C passes, with no edit between;
 *  - edit: C fails, files are edited, then exactly C passes; C verifies (test,
 *    build, lint, typecheck).
 * The wording comes from templates, so the command in an entry is exactly the
 * command that passed, without its shell's assignment syntax: leading
 * environment assignments (`TZ=UTC cmd`, PowerShell `$env:TZ='UTC'; cmd`) are
 * given as data, so an agent in any shell can follow the recipe. No model
 * call: the commands and exit codes are the evidence.
 */
import { linePurpose } from "../repo-start/recipes/ci.js";
import type { Proposal } from "./gate-types.js";
import { hasSecret } from "./gates.js";

export interface JournalRow {
  id: number; kind: "typed" | "command" | "edit"; text: string; exit_code: number | null;
  /** One segment of a `;` chain before its last: it ran, but its outcome is unknown. */
  ran?: boolean;
}
export type Transition =
  | { type: "variant"; fail: JournalRow; pass: JournalRow }
  | { type: "prep"; fail: JournalRow; preps: JournalRow[]; pass: JournalRow }
  | { type: "edit"; fail: JournalRow; edits: JournalRow[]; pass: JournalRow };

/** Longer commands are not recipes; a row cut at the journal's limit is never exact. */
export const MAX_RECIPE_COMMAND = 300;
const MAX_PREPS = 3;
const MAX_EDIT_EVIDENCE = 16;

const POSIX_ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=('[^']*'|"[^"$`\\]*"|[^\s'"`$;&|<>()\\]*)(?=\s)/u;
const POWERSHELL_ASSIGNMENT = /^\$env:([A-Za-z_][A-Za-z0-9_]*)\s*=\s*('[^']*'|"[^"$`]*"|[^\s;'"`$]+)\s*;/iu;
const unquote = (value: string) => /^(['"]).*\1$/u.test(value) ? value.slice(1, -1) : value;

interface Split { assignments: Array<{ text: string; canonical: string }>; rest: string; }
/** Leading environment assignments: `A=1 B=2 cmd`, `env A=1 cmd`, PowerShell `$env:A='1'; cmd`. */
export function splitEnvironment(command: string): Split {
  const assignments: Split["assignments"] = [];
  let rest = command.trim();
  if (/^env\s+[A-Za-z_][A-Za-z0-9_]*=/u.test(rest)) rest = rest.slice(3).trimStart();
  for (;;) {
    const match = POWERSHELL_ASSIGNMENT.exec(rest) ?? POSIX_ASSIGNMENT.exec(rest);
    if (!match) break;
    assignments.push({ text: match[0].replace(/\s*;$/u, "").trim(), canonical: `${match[1]}=${unquote(match[2]!)}` });
    rest = rest.slice(match[0].length).trimStart();
  }
  return { assignments, rest };
}

/** Trimmed, whitespace collapsed, leading environment assignments removed. */
export function normalizeCommand(command: string): string {
  return splitEnvironment(command).rest.replace(/\s+/gu, " ").trim();
}

const SECRET_NAME = /(?:^|_)(?:TOKEN|SECRETS?|KEY|CREDENTIALS?|AUTH|COOKIE|SESSION|PAT|PWD)(?:_|$)|PASS(?:WORD|WD)/iu;
const URL_PASSWORD = /[a-z][a-z0-9+.-]*:\/\/[^\s/@:]*:[^\s/@]+@/iu;
/** An absolute or home path names one machine's checkout, not the repository. */
const ABSOLUTE_PATH = /(?:^|[\s='"(])(?:\/|~[\\/]|[A-Za-z]:[\\/]|\\\\)/u;

/**
 * An environment assignment that may carry a credential, by its name
 * (DB_PASSWORD, STRIPE_API_KEY, GITHUB_TOKEN) or by a password in a URL value.
 * Capture's redaction can miss one; a recipe must never repeat it.
 */
export function secretAssignment(canonical: string): boolean {
  const at = canonical.indexOf("=");
  return SECRET_NAME.test(canonical.slice(0, at)) || URL_PASSWORD.test(canonical.slice(at + 1)) || hasSecret(canonical);
}

/**
 * One plain command we can hand back exactly: no chains, pipes, redirects or
 * expansions, no absolute path (it names this machine's checkout), and no
 * environment assignment or text that may hold a secret.
 */
export function replayable(command: string): boolean {
  const text = command.trim();
  if (!text || text !== command || text.length > MAX_RECIPE_COMMAND || /[\x00-\x1f\x7f`]/u.test(text) || text.includes("[secret removed]")) return false;
  if (ABSOLUTE_PATH.test(text) || URL_PASSWORD.test(text) || hasSecret(text)) return false;
  const { assignments, rest } = splitEnvironment(text);
  if (assignments.some(a => secretAssignment(a.canonical))) return false;
  return !!rest && !/^env(?:\s|$)/u.test(rest) && !/[;&|<>$]/u.test(rest);
}

/** Changes the folder or detaches: later segments of the chain don't run as a plain command would. */
const CHAIN_BREAKER = /^(?:cd|chdir|pushd|popd|set-location|sl|push-location|pop-location|nohup|start|start-process|start-job|exec)(?:\s|$)/iu;
const EXPORT = /^export\s+([A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"$`\\]*"|[^\s'"`$;&|<>()\\]+))$/u;
const POWERSHELL_SET = /^\$env:[A-Za-z_][A-Za-z0-9_]*\s*=\s*(?:'[^']*'|"[^"$`]*"|[^\s;'"`$]+)$/iu;

/**
 * A plain chain split at its top-level separators, outside quotes: only `;`
 * chains or only `&&` chains. Pipes, `||`, `&`, redirects, subshells and mixed
 * operators give undefined: what ran, and how it ended, isn't known.
 */
export function chainSegments(text: string): { op: "&&" | ";"; parts: string[] } | undefined {
  const parts: string[] = [];
  let op: "&&" | ";" | undefined, quote = "", start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote) { if (c === quote) quote = ""; continue; }
    if (c === "'" || c === '"') { quote = c; continue; }
    let found: "&&" | ";" | undefined;
    if (c === ";") found = ";";
    else if (c === "&" && text[i + 1] === "&") found = "&&";
    else if ("&|<>(){}`".includes(c)) return undefined;
    if (!found) continue;
    if (op && op !== found) return undefined;
    op = found;
    parts.push(text.slice(start, i).trim());
    if (found === "&&") i++;
    start = i + 1;
  }
  if (quote || !op) return undefined;
  parts.push(text.slice(start).trim());
  return parts.some(part => !part) ? undefined : { op, parts };
}

/**
 * One command row as the commands it ran. A chain's outcome is known only so far:
 * a passing `A && B` means every segment passed; in `A; B` only the last
 * segment's exit is known and the earlier ones ran with an unknown outcome; a
 * failing `&&` chain says nothing about which segment failed. An environment
 * set in the chain (`$env:X='1'`, `export X=1`) carries to the segments after
 * it. A chain that changes folder, detaches, sets a plain shell variable, or
 * has any segment that isn't replayable (secrets, absolute paths) stays one row.
 */
export function expandRow(row: JournalRow): JournalRow[] {
  if (row.kind !== "command" || row.text.length > MAX_RECIPE_COMMAND) return [row];
  const chain = chainSegments(row.text.trim());
  if (!chain) return [row];
  const env: string[] = [], commands: string[] = [];
  for (const part of chain.parts) {
    if (POWERSHELL_SET.test(part)) { env.push(`${part};`); continue; }
    const exported = EXPORT.exec(part);
    if (exported) { env.push(exported[1]!); continue; }
    if (/^[A-Za-z_][A-Za-z0-9_]*=\S*$/u.test(part) || CHAIN_BREAKER.test(splitEnvironment(part).rest)) return [row];
    // PowerShell keeps its `$env:` form; POSIX assignments go in front of the command.
    const text = [...env.filter(e => e.endsWith(";")), ...env.filter(e => !e.endsWith(";")), part].join(" ");
    if (!replayable(text)) return [row];
    commands.push(text);
  }
  if (!commands.length) return [row];
  // `export X=1; cmd` is one command with its environment.
  if (commands.length === 1) return [{ ...row, text: commands[0]! }];
  const passed = row.exit_code === 0;
  return commands.map((text, i) => {
    const last = i === commands.length - 1;
    if (chain.op === "&&") return { ...row, text, exit_code: passed ? 0 : null };
    return last ? { ...row, text } : { ...row, text, exit_code: null, ran: true };
  });
}

/** Every command a passing row ran in this checkout, for the gate's exact set. */
export function passedRuns(text: string): string[] {
  return [...new Set([text, ...expandRow({ id: 0, kind: "command", text, exit_code: 0 }).map(row => row.text)])];
}

const verifies = (command: string) => {
  const purpose = linePurpose(normalizeCommand(command));
  return purpose === "test" || purpose === "build" || purpose === "lint" || purpose === "typecheck";
};

const READ_TOOLS = new Set(["cat", "head", "tail", "ls", "pwd", "wc", "rg", "grep", "egrep", "which", "type", "echo", "tree", "stat", "file",
  "less", "more", "nl", "dir", "get-content", "gc", "select-string", "findstr", "get-childitem"]);
const READ_GIT = new Set(["status", "diff", "log", "show", "rev-parse", "ls-files", "grep", "blame"]);
/** Commands that only read or search: they may sit between a failure and its pass. */
export function readsOnly(command: string): boolean {
  const text = normalizeCommand(command);
  if (!text || /[>`]|\$\(/u.test(text)) return false;
  return text.split(/\s*(?:&&|\|\||;|\|)\s*/u).every(segment => {
    const [tool = "", ...args] = segment.split(" ");
    const name = tool.toLowerCase().replace(/\.exe$/u, "");
    if (READ_TOOLS.has(name)) return true;
    if (name === "sed") return args.includes("-n") && !args.some(arg => /^-[a-zA-Z]*i|^--in-place/u.test(arg));
    if (name === "find") return !args.some(arg => /^-(?:delete|exec|execdir|ok|okdir|fprint)/u.test(arg));
    if (name === "git") return READ_GIT.has(args[0] ?? "") || (args[0] === "branch" && args.length === 2 && args[1] === "--show-current");
    return false;
  });
}

const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);
const SAFE_SCRIPT = /^(?:build|compile|generate|gen|codegen|migrate|db:migrate|db:generate|prisma:generate|(?:build|generate|codegen):[\w-]+)$/u;
const UNSAFE_SCRIPT = /watch|dev|start|serve|reset|clean|drop|seed|deploy|publish|release/u;
const PREP_COMMANDS = [
  /^(?:npm (?:install|i|ci)|pnpm (?:install|i)|yarn(?: install)?|bun (?:install|i))(?: --?[\w-]+)*$/u,
  /^pip3? install (?:-r [\w./-]+|-e \.)$/u, /^(?:poetry install|uv sync|bundle install|composer install|cargo fetch|go mod download)(?: --?[\w-]+)*$/u,
  /^(?:go (?:build|generate) \.\/\.\.\.|cargo build|make (?:build|generate|gen|codegen)|buf generate)(?: --?[\w-]+)*$/u,
  /^(?:npx |pnpm exec |yarn |bunx )?(?:prisma generate|prisma migrate deploy|tsc (?:-b|--build))(?: --?[\w-]+)*$/u,
  /^(?:python3? manage\.py migrate|(?:bin\/)?rails db:migrate|bundle exec rake db:migrate)$/u,
];
/**
 * The allow-list of preparation steps: install, build, generate and migrate,
 * with no package arguments. Anything else, destructive or unknown, never counts.
 */
export function safePrep(command: string): boolean {
  if (!replayable(command)) return false;
  const text = normalizeCommand(command);
  const [tool = "", ...rest] = text.split(" ");
  if (PACKAGE_MANAGERS.has(tool)) {
    const words = rest.filter(word => !word.startsWith("-"));
    const script = words[0] === "run" ? words[1] : tool === "npm" ? undefined : words[0];
    if (script !== undefined && words.length === (words[0] === "run" ? 2 : 1) && SAFE_SCRIPT.test(script) && !UNSAFE_SCRIPT.test(script)) return true;
  }
  return PREP_COMMANDS.some(pattern => pattern.test(text));
}

const failed = (row: JournalRow) => row.kind === "command" && row.exit_code !== null && row.exit_code !== 0;

/** Every verified transition in one session's rows, in journal order. */
export function findTransitions(journal: readonly JournalRow[]): Transition[] {
  const rows = journal.flatMap(expandRow);
  const out: Transition[] = [];
  for (let i = 0; i < rows.length; i++) {
    const fail = rows[i]!;
    if (!failed(fail) || !replayable(fail.text) || !verifies(fail.text)) continue;
    const family = normalizeCommand(fail.text);
    const edits: JournalRow[] = [], others: JournalRow[] = [];
    for (let j = i + 1; j < rows.length; j++) {
      const row = rows[j]!;
      if (row.kind === "edit") { edits.push(row); continue; }
      if (row.kind !== "command") continue;
      if (normalizeCommand(row.text) !== family) {
        if (!readsOnly(row.text)) others.push(row);
        continue;
      }
      // The same command again. A later failure starts its own search.
      if (row.exit_code !== 0 || !replayable(row.text)) break;
      if (row.text !== fail.text) {
        const before = new Set(splitEnvironment(fail.text).assignments.map(a => a.canonical));
        const after = new Set(splitEnvironment(row.text).assignments.map(a => a.canonical));
        const differs = before.size !== after.size || [...before].some(a => !after.has(a));
        if (differs && !edits.length && !others.length) out.push({ type: "variant", fail, pass: row });
      } else if (edits.length) {
        out.push({ type: "edit", fail, edits, pass: row });
      } else if (others.length >= 1 && others.length <= MAX_PREPS && others.every(o => (o.exit_code === 0 || o.ran) && safePrep(o.text))) {
        out.push({ type: "prep", fail, preps: others, pass: row });
      }
      break;
    }
  }
  return out;
}

/** The folder every edited file shares: "" for the repository root. */
export function commonFolder(paths: readonly string[]): string {
  const folders = paths.map(path => path.split("/").slice(0, -1));
  const first = folders[0] ?? [];
  let length = first.length;
  for (const folder of folders) {
    let n = 0;
    while (n < Math.min(length, folder.length) && folder[n] === first[n]) n++;
    length = n;
  }
  return first.slice(0, length).join("/");
}

const code = (text: string) => `\`${text}\``;
const list = (items: string[]) => items.length === 1 ? items[0]! : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
/** An assignment as data, `NAME=value`, quoted only when the value needs it. */
function shown(canonical: string): string {
  const at = canonical.indexOf("="), value = canonical.slice(at + 1);
  if (/^[\w@%+:,./-]*$/u.test(value)) return canonical;
  return `${canonical.slice(0, at)}=${value.includes("'") ? `"${value}"` : `'${value}'`}`;
}
/**
 * A command without its shell's assignment syntax: the command itself, then
 * its environment as data. `TZ=UTC npm test` (POSIX) and `$env:TZ='UTC'; npm
 * test` (PowerShell) are the same run, and an agent in either shell can repeat it.
 */
export function neutral(text: string): [command: string, ...environment: string[]] {
  const { assignments, rest } = splitEnvironment(text);
  return [rest, ...assignments.map(a => a.canonical).sort()];
}
/** "`npm test`", or "`npm test` with `CI=1` set". */
function phrase(text: string): string {
  const [command, ...environment] = neutral(text);
  return environment.length ? `${code(command)} with ${list(environment.map(a => code(shown(a))))} set` : code(command);
}
const AGENT_NAMES: Record<string, string> = { "claude-code": "Claude Code", codex: "Codex", copilot: "Copilot CLI", opencode: "OpenCode" };

/** The display line naming the agent whose session found it. */
export function foundBy(agent: string): string {
  const name = AGENT_NAMES[agent] ?? (/^[a-z][a-z0-9-]{0,40}$/u.test(agent) ? agent : "an agent");
  return `found by ${name}`;
}

/** The template proposal for one transition. Stable keys make a re-run update in place or do nothing. */
export function transitionProposal(t: Transition, agent: string): Proposal {
  const base = { producer: "fail-pass" as const, source: { type: "observed" as const, ref: "capture journal" }, model: "none" as const, label: foundBy(agent) };
  const exit = `exit ${t.fail.exit_code}`;
  if (t.type === "variant") {
    const before = splitEnvironment(t.fail.text).assignments, after = splitEnvironment(t.pass.text).assignments;
    const added = after.filter(a => !before.some(b => b.canonical === a.canonical)).map(a => code(shown(a.canonical)));
    const removed = before.filter(b => !after.some(a => a.canonical === b.canonical)).map(b => code(shown(b.canonical)));
    const it = (items: string[]) => items.length === 1 ? "it" : "them";
    const how = !removed.length ? `with ${list(added)} set; without ${it(added)}, it failed here`
      : !added.length ? `without ${list(removed)} set; with ${it(removed)}, it failed here`
        : `with ${list(added)} set instead of ${list(removed)}; with ${list(removed)}, it failed here`;
    const oneLine = `Run ${code(splitEnvironment(t.pass.text).rest)} ${how} (${exit}).`;
    return { ...base, key: JSON.stringify(["variant", ...neutral(t.pass.text)]), kind: "recipe", oneLine,
      text: `${oneLine} In one session it failed, then passed with only the environment changed.`, evidence: [...new Set([t.fail.id, t.pass.id])] };
  }
  if (t.type === "prep") {
    const steps = t.preps.map(p => phrase(p.text));
    const oneLine = `Before ${phrase(t.pass.text)}, run ${steps.join(", then ")}.`;
    return { ...base, key: JSON.stringify(["prep", neutral(t.pass.text), ...t.preps.map(p => neutral(p.text))]), kind: "recipe", oneLine,
      text: `${oneLine} In one session it failed (${exit}) until ${t.preps.length === 1 ? "that" : "those"} ran, then passed with no edit between.`,
      evidence: [...new Set([t.fail.id, ...t.preps.map(p => p.id), t.pass.id])] };
  }
  const area = commonFolder(t.edits.map(e => e.text));
  const where = area ? `in ${code(area)}` : "in this repository";
  const oneLine = `After changes ${where}, run ${phrase(t.pass.text)}; it caught a failure here.`;
  return { ...base, key: JSON.stringify(["edit", neutral(t.pass.text), area]), kind: "procedure", oneLine,
    text: `${oneLine} In one session it failed (${exit}), files there were edited, then it passed.`,
    anchors: { scope: [area ? `${area}/**` : "**"] },
    evidence: [...new Set([t.fail.id, ...t.edits.slice(0, MAX_EDIT_EVIDENCE).map(e => e.id), t.pass.id])] };
}
