/**
 * Setup questions: the gaps only a person can settle (system-0.9 section 5.4). Each comes
 * from something setup already read, and each is asked only when that reading found a
 * real gap:
 *  - rule-conflict: two rule files name different commands or paths under one heading;
 *  - test-command: a package defines two test commands in its config;
 *  - layer-exception: an import rule the code holds everywhere but in one or two places;
 *  - hand-edited: a file with a generated header that commits changed on its own.
 * No gap means no question. Templates only: every gap type has one, so no model drafts
 * questions in this version (the "convention with exceptions" gap, which would need one,
 * waits for idiom mining).
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import type { Proposal, ProposedCheck } from "../../knowledge/gate.js";
import type { EntryCheck } from "../../knowledge/entry.js";
import type { RuleScan } from "../../knowledge/rule-files.js";
import type { RecipesFile } from "../recipes/index.js";
import type { CodeFactsFile } from "../history/job.js";
import { preciseName } from "../history/entries.js";
import { HAND_EDITS_FINE, type GapType } from "./answers.js";

export const MAX_QUESTIONS = 5;
/** The order questions are asked in: rule lines first, they reach every session. */
const ORDER: readonly GapType[] = ["rule-conflict", "test-command", "layer-exception", "hand-edited"];

export interface Choice { key: string; label: string; }
export interface Resolution { proposals: Proposal[]; subject: string; }
export interface Gap {
  /** Stable while the evidence is: a hash of the type, the subject and what setup saw. */
  id: string;
  type: GapType;
  subject: string;
  /** Files the answer was based on, for preview revision checks. */
  evidencePaths: string[];
  /** One line, in plain words. */
  question: string;
  /** The evidence, a line or two. */
  details: string[];
  choices: Choice[];
  /** The choice Enter takes; none means Enter skips. */
  suggested?: string;
  resolve(choice: string, date: string): Resolution;
}

export interface GapInput {
  root: string;
  scan?: RuleScan;
  recipes?: RecipesFile;
  facts?: CodeFactsFile;
  /** Ids already answered or skipped. */
  answered?: ReadonlySet<string>;
  /** A read-only surface can omit recency hints that need Git. */
  ruleHistory?: boolean;
}

const code = (text: string) => `\`${text}\``;
const id = (...parts: string[]) => createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 24);
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
const LABEL = "you said, at setup";

function personSource(date: string, question: string, answer: string): Proposal["source"] {
  const said = `${question} ${answer}`.slice(0, 2000);
  return { type: "person", ref: `mex setup ${date}`, quote: said, text: said };
}
function proposal(fields: Omit<Proposal, "producer" | "model" | "label">): Proposal {
  return { producer: "setup-question", model: "none", label: LABEL, ...fields };
}
function checkOf(check: EntryCheck): ProposedCheck | undefined {
  if (check.kind === "legacy-grounding") return undefined;
  return { kind: check.kind, role: "complete", target: check.target } as ProposedCheck;
}

function lastChanged(root: string, path: string): number {
  try {
    return Number(execFileSync("git", ["-C", root, "log", "-1", "--format=%ct", "--", path],
      { encoding: "utf8", timeout: 5_000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).trim()) || 0;
  } catch { return 0; }
}

/** Code spans (commands, paths, names) of at least three characters. */
function spans(text: string): string[] {
  return [...new Set([...text.matchAll(/`([^`\n]{3,200})`/gu)].map(m => m[1]!.trim()).filter(Boolean))];
}

function ruleConflicts(input: GapInput): Gap[] {
  const { scan } = input;
  if (!scan) return [];
  const out: Gap[] = [];
  for (const item of scan.review) {
    if (item.kind !== "conflict" || item.paths.length !== 2) continue;
    const [a, b] = item.paths.map(path => scan.entries.find(e => e.path === path && /^([^:]+):/u.exec(e.entry.mex.one_line)?.[1] === item.heading));
    if (!a || !b) continue;
    const inA = spans(a.entry.text), inB = spans(b.entry.text);
    const setA = new Set(inA), setB = new Set(inB);
    const onlyA = inA.filter(span => !setB.has(span)), onlyB = inB.filter(span => !setA.has(span));
    // Only one file names something the other doesn't: one says more, not something else.
    if (!onlyA.length || !onlyB.length) continue;
    const checkA = a.entry.mex.checks.map(checkOf).find(Boolean), checkB = b.entry.mex.checks.map(checkOf).find(Boolean);
    if (!checkA || !checkB) continue;
    const timeA = input.ruleHistory === false ? 0 : lastChanged(input.root, a.path);
    const timeB = input.ruleHistory === false ? 0 : lastChanged(input.root, b.path);
    const question = `${code(a.path)} says ${code(onlyA[0]!)}, ${code(b.path)} says ${code(onlyB[0]!)} (under "${item.heading}"). Which is right?`;
    const side = (winner: typeof a, lose: string[], win: string[], loser: typeof b, checks: ProposedCheck[], date: string, answer: string): Proposal => proposal({
      key: `conflict\n${item.heading}\n${winner.path}\n${loser.path}`, kind: "decision",
      text: `Under "${item.heading}", follow ${winner.path}: ${win.slice(0, 3).map(code).join(", ")}. ${loser.path} says ${lose.slice(0, 3).map(code).join(", ")}, which is out of date.`,
      oneLine: `${item.heading}: use ${code(win[0]!)}, not ${code(lose[0]!)}.`,
      source: personSource(date, question, answer),
      anchors: { scope: winner.entry.mex.scope, when: lose.slice(0, 4).map(pattern => ({ type: "rejected" as const, match: "literal" as const, pattern })) },
      checks,
    });
    out.push({
      id: id("rule-conflict", item.heading, a.path, b.path, onlyA.join("\n"), onlyB.join("\n")), type: "rule-conflict", subject: `${a.path}\n${b.path}\n${item.heading}`,
      question, details: [], evidencePaths: [a.path, b.path],
      choices: [{ key: "1", label: `${a.path} is right` }, { key: "2", label: `${b.path} is right` }],
      ...(timeA !== timeB ? { suggested: timeA > timeB ? "1" : "2" } : {}),
      resolve: (choice, date) => {
        const subject = `${a.path}\n${b.path}\n${item.heading}`;
        if (choice === "1") return { subject, proposals: [side(a, onlyB, onlyA, b, [checkA, checkB], date, `${a.path} is right.`)] };
        if (choice === "2") return { subject, proposals: [side(b, onlyA, onlyB, a, [checkB, checkA], date, `${b.path} is right.`)] };
        return { subject, proposals: [] };
      },
    });
  }
  return out;
}

function testCommands(input: GapInput): Gap[] {
  const { recipes } = input;
  if (!recipes) return [];
  const out: Gap[] = [];
  for (const pkg of ["", ...recipes.packages.map(p => p.path).filter(path => path !== "" && path !== ".")]) {
    const found = recipes.recipes.filter(r => r.package === pkg && r.purpose === "test" && r.local === "yes" && r.entry.mex.source.type === "config" && r.origin[0]);
    const commands = [...new Map(found.map(r => [r.command, r])).values()];
    if (commands.length < 2) continue;
    const [one, two] = commands as [typeof commands[0], typeof commands[0]];
    const where = (r: typeof one) => r.origin[0]!.file;
    const inCi = (r: typeof one) => r.origin.some(o => o.file.startsWith(".github/"));
    const question = `${pkg ? `${code(pkg)} has` : "This repo has"} two test commands: ${code(one.command)} (${where(one)}) and ${code(two.command)} (${where(two)}). Which is the real one?`;
    const recipe = (r: typeof one, date: string, answer: string, also = false): Proposal => proposal({
      key: `test\n${pkg}\n${r.command}`, kind: "recipe",
      text: `${also ? "Tests also" : "Tests"}${pkg ? ` in ${pkg}` : ""}: ${code(r.command)}`,
      source: personSource(date, question, answer),
      anchors: { scope: [pkg ? `${pkg}/**` : "**"] },
      checks: [{ kind: "command", role: "complete", target: { run: r.command, file: r.origin[0]!.file, pointer: r.origin[0]!.pointer } }],
    });
    const ci = [one, two].filter(inCi);
    out.push({
      id: id("test-command", pkg, one.command, two.command), type: "test-command", subject: pkg, question, details: [], evidencePaths: [where(one), where(two)],
      choices: [{ key: "1", label: code(one.command) }, { key: "2", label: code(two.command) }, { key: "3", label: "both" }],
      ...(ci.length === 1 ? { suggested: ci[0] === one ? "1" : "2" } : {}),
      resolve: (choice, date) => ({
        subject: pkg,
        proposals: choice === "1" ? [recipe(one, date, one.command)] : choice === "2" ? [recipe(two, date, two.command)]
          : choice === "3" ? [recipe(one, date, "Both."), recipe(two, date, "Both.", true)] : [],
      }),
    });
  }
  return out;
}

function layerExceptions(input: GapInput): Gap[] {
  const { facts, recipes } = input;
  if (!facts?.layer_exceptions?.length || !recipes) return [];
  const out: Gap[] = [];
  for (const rule of facts.layer_exceptions) {
    // The rule is "from never imports to"; only a named package gives an exact import to watch for.
    const target = recipes.packages.find(pkg => pkg.path === rule.to && pkg.kind === "node" && pkg.name);
    if (!target || !preciseName(target.name)) continue;
    const name = target.name;
    const literals = [`'${name}'`, `"${name}"`, `'${name}/`, `"${name}/`];
    const where = rule.files.length ? ` (${rule.files.slice(0, 2).map(code).join(", ")})` : "";
    const question = `${code(rule.from)} imports ${code(name)} in ${plural(rule.back, "place")}${where}, while ${plural(rule.imports, "import")} go the other way. Is that allowed?`;
    out.push({
      id: id("layer-exception", rule.from, rule.to, String(rule.back)), type: "layer-exception", subject: `${rule.from}\n${rule.to}`, question, details: [],
      evidencePaths: [`${rule.to}/package.json`, ...rule.files.slice(0, 2)],
      choices: [{ key: "1", label: "no, keep it one-way" }, { key: "2", label: "yes, it's allowed" }],
      suggested: "1",
      resolve: (choice, date) => ({
        subject: `${rule.from}\n${rule.to}`,
        proposals: choice !== "1" ? [] : [proposal({
          key: `layer\n${rule.from}\n${rule.to}`, kind: "rule",
          text: `${code(rule.from)} must not import ${code(name)} (${code(rule.to)}): keep the dependency one-way. ${plural(rule.back, "import")} still ${rule.back === 1 ? "does" : "do"} today; don't add more.`,
          oneLine: `${code(rule.from)} must not import ${code(name)}; keep the dependency one-way.`,
          source: personSource(date, question, "No, keep it one-way."),
          anchors: { scope: [`${rule.from}/**`], when: literals.map(pattern => ({ type: "anti" as const, match: "literal" as const, pattern })) },
          // The package keeps its name: the rule still means what was answered.
          checks: [{ kind: "key", role: "complete", target: { file: `${rule.to}/package.json`, pointer: "/name" } }],
        })],
      }),
    });
  }
  return out;
}

function handEdited(input: GapInput): Gap[] {
  const { facts } = input;
  if (!facts?.hand_edited?.length) return [];
  const markers = new Set(facts.generated.filter(item => item.signal === "marker").map(item => item.path));
  return facts.hand_edited.filter(item => markers.has(item.path)).map(item => {
    const question = `${code(item.path)} has a generated header, but ${plural(item.commits, "commit")} changed only that file. Should changes go through its generator?`;
    return {
      id: id("hand-edited", item.path), type: "hand-edited" as const, subject: item.path, question, details: [], evidencePaths: [item.path],
      choices: [{ key: "1", label: "yes, change the generator" }, { key: HAND_EDITS_FINE, label: "no, hand edits are fine" }],
      suggested: "1",
      // A yes confirms the pitfall code facts already keeps for the header; a no makes code facts drop it.
      resolve: () => ({ subject: item.path, proposals: [] }),
    };
  });
}

/** The questions worth asking, at most five, none already answered. */
export function findGaps(input: GapInput): Gap[] {
  const answered = input.answered ?? new Set<string>();
  const all = [...ruleConflicts(input), ...testCommands(input), ...layerExceptions(input), ...handEdited(input)]
    .filter(gap => !answered.has(gap.id));
  return all.sort((a, b) => ORDER.indexOf(a.type) - ORDER.indexOf(b.type)).slice(0, MAX_QUESTIONS);
}
