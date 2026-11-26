import { existsSync } from "node:fs";
import { join, posix } from "node:path";
import { z } from "zod";
import pack from "./agent-defaults-v1.json" with { type: "json" };
import { containedDirectory, readBoundedTextFile } from "./files.js";
import { discoverRuleFiles, GENERATED_MARK, listRuleSources, ruleBody } from "./rule-files.js";

export const DEFAULTS_SETTING = "agent.defaults";
export const DEFAULTS_HEADING = "\n## MEX defaults\n\nFollow the repository's own instructions where they differ.\n\n";
const topics = {
  scope: /\b(?:unrelated|out of scope|minimal (?:changes?|diff)|focused (?:changes?|PRs?)|one (?:change|topic) per)\b/iu,
  additions: /\b(?:options?|new flags?|new settings?|dependencies|new features?)\b/iu,
  reuse: /\b(?:helpers?|abstractions?|reus(?:e|ing)|duplicat(?:e|ion))\b/iu,
  unused: /\b(?:unused (?:code|imports?|variables?|parameters?|branches?)|dead code)\b/iu,
  conventions: /\b(?:conventions?|naming|error handling|import order|formatter|linter|code style|formatting)\b/iu,
  comments: /\b(?:code comments?|comments?|docstrings?|jsdoc|javadoc)\b/iu,
  logging: /\b(?:logging|log statements?|log (?:secrets|credentials|tokens|passwords|messages))\b/iu,
  behaviour: /\b(?:(?:existing|current) behavio[u]?r|(?:git|commit) history)\b/iu,
  assertions: /\b(?:assertions?|skip(?:ping)? tests?|weaken(?:ing)? tests?|(?:update|regenerate|accept|refresh) (?:the )?snapshots?|snapshots? (?:update|refresh)|-u\b)/iu,
  coverage: /\b(?:regression tests?|add (?:a |new )?tests?|tests? for (?:bug|fix|chang|new)|test (?:coverage|fixtures|framework|placement)|tests? (?:in|under|alongside|live))\b/iu,
  compatibility: /\b(?:compatib(?:le|ility)|breaking changes?|public (?:API|signatures?))\b/iu,
  changelog: /\b(?:change ?logs?|release notes?|news (?:entry|fragment))\b/iu,
  submission: /\b(?:commit messages?|(?:pull requests?|PR) (?:descriptions?|templates?|titles?))\b/iu,
  checks: /\b(?:(?:run|required|report) (?:\w+ ){0,3}(?:checks?|tests?|CI|lint(?:ing)?)|commands? and results|(?:npm|pnpm|yarn|cargo|go) test)\b/iu,
  artifacts: /\b(?:generated (?:files?|artifacts?)|lock[ -]?files?|temp(?:orary)? (?:files?|artifacts?))\b/iu,
} as const;
type RuleId = keyof typeof topics;
const { rules } = z.object({
  version: z.literal(1),
  rules: z.array(z.object({
    id: z.enum(Object.keys(topics) as [RuleId, ...RuleId[]]),
    text: z.string().min(1).regex(/^[^\r\n]+$/u),
  })).length(Object.keys(topics).length),
}).parse(pack);

const directive = /\b(?:always|never|must|shall|should|required|only|prefer|avoid|do not|don't|cannot|may not|make sure|ensure|take care|we (?:use|require|expect))\b|^(?:add|check|describe|document|don't|follow|keep|limit|match|preserve|remove|report|reuse|run|skip|use|write|update|regenerate)\b/iu;
const conflict: Partial<Record<RuleId, RegExp>> = {
  scope: /\b(?:include|bundle|combine|fix|perform)\b.{0,55}\b(?:unrelated|opportunistic|drive-by)\b/iu,
  additions: /\b(?:always|must|required|prefer)\b.{0,65}\b(?:add|introduce|new)\b.{0,35}\b(?:dependencies|features?|flags?|options?|settings?)\b/iu,
  reuse: /\b(?:never|do not|don't)\b.{0,35}\breuse\b/iu,
  unused: /\b(?:keep|retain|preserve|leave)\b.{0,30}\b(?:unused|dead)\b/iu,
  conventions: /\b(?:ignore|bypass|disable|don't follow|do not follow)\b.{0,40}\b(?:conventions|formatter|linter|style)\b/iu,
  comments: /\b(?:always|must|required?|every|each|all|full|complete|regardless)\b.{0,70}\b(?:comments?|docstrings?|jsdoc|javadoc)\b|\b(?:comments?|docstrings?|jsdoc|javadoc)\b.{0,60}\b(?:always|required|each|every|all)\b/iu,
  logging: /\b(?:always log|log every|log all|log secrets|log credentials)\b/iu,
  behaviour: /\b(?:change|replace|rewrite|ignore)\b.{0,35}\b(?:existing|current) behavio[u]?r\b/iu,
  assertions: /\b(?:update|regenerate|accept|refresh)\b.{0,45}\bsnapshots?\b|(?:^|\s)-u\b|\b(?:skip|weaken|remove|delete)\b.{0,35}\b(?:tests?|assertions?)\b/iu,
  coverage: /\b(?:skip|omit|do not add|don't add|no need for)\b.{0,50}\b(?:tests?|coverage)\b/iu,
  compatibility: /\b(?:allow|accept|encourage|prefer|need not preserve)\b.{0,40}\b(?:breaking changes?|compatibility)\b/iu,
  changelog: /\b(?:always|must|required?|every|each|all|never|do not|don't)\b.{0,65}\b(?:change ?logs?|release notes?|news (?:entry|fragment))\b|\b(?:change ?logs?|release notes?)\b.{0,60}\b(?:always|required|each|every|all)\b/iu,
  submission: /\b(?:ignore|don't use|do not use)\b.{0,40}\b(?:template|conventions|rules)\b/iu,
  checks: /\b(?:skip|don't run|do not run)\b.{0,30}\b(?:tests?|checks?|lint|CI)\b/iu,
  artifacts: /\b(?:always|must|required|ensure)\b.{0,45}\b(?:commit|include|check in)\b.{0,45}\b(?:generated|lock[ -]?files?|temp(?:orary)?)\b/iu,
};
const negative = /\b(?:never|avoid|do not|don't|must not|no longer)\b/iu;
const conditional = /\b(?:only (?:if|when)|unless|except)\b/iu;
const unsupported = {
  cursor: [".cursor", ".cursorrules"],
  "gemini": [".gemini", "GEMINI.md"],
  kiro: [".kiro"],
  antigravity: [".agent/rules", ".agents/rules", ".antigravity"],
  opencode: [".opencode", "opencode.json"],
  devin: [".devin"],
} as const;
const agentNames: Record<string, string> = {
  cursor: "Cursor", gemini: "Gemini CLI", kiro: "Kiro", antigravity: "Antigravity", opencode: "OpenCode", devin: "Devin",
};

type Omission = { id: string; reason: "conflict" | "repeat" | "related rule"; path: string };
export interface DefaultsReport {
  available: number;
  omitted: Omission[];
  unavailable: string[];
  enabled: boolean;
}
export interface AgentDefaults {
  rules: typeof rules;
  report: DefaultsReport;
}

/** The last defaults selection for this checkout, in pack order. */
export function defaultRuleTexts(report: DefaultsReport | undefined): string[] {
  if (!report?.enabled) return [];
  const omitted = new Set(report.omitted.map(rule => rule.id));
  return rules.filter(rule => !omitted.has(rule.id)).map(rule => rule.text);
}

const contributorPath = /(?:^|\/)(?:contributing|(?:cod(?:e|ing)[-_ ]?)?style|testing|development|developer[-_ ]guide|maintaining|conventions|pull[-_ ]request[-_ ]template)(?:[._-][^/]*)?\.(?:mdx?|rst|txt)$|(?:^|\/)(?:contributing|pull_request_template)\/.+\.(?:mdx?|rst|txt)$|^(?:docs?|documentation)\/.*(?:contribut|development|coding[-_ ]style).*\.(?:mdx?|rst|txt)$/iu;
const extraInstructions = /^(?:\.kiro\/steering|\.agents?\/rules)\/.+\.md$/iu;

function* instructions(body: string): Generator<string> {
  const prose = body.replace(/<!--[\s\S]*?-->/gu, "").replace(/^\s*(?:\x60{3,}|~{3,}).*$/gmu, "");
  for (const raw of prose.split(/\n\s*\n|(?<=\S)\n(?=\s*(?:[-*+]|\d+[.)]|#)\s)/u)) {
    const paragraph = raw.trim().replace(/^(?:[-*+]|\d+[.)])\s+/u, "").replace(/[*\x60]/gu, "").replace(/\s+/gu, " ");
    for (const sentence of paragraph.split(/(?<=[.!?])\s+/u)) {
      if (directive.test(sentence) || /^(?:npm|pnpm|yarn|cargo|go) test\b/u.test(sentence)) yield sentence;
    }
  }
}

function omissions(sources: Iterable<{ path: string; body: string }>): Omission[] {
  const result = new Map<RuleId, Omission>();
  for (const { path, body } of sources) for (const text of instructions(body)) for (const { id, text: rule } of rules) {
    if (!topics[id].test(text)) continue;
    const opposite = conflict[id]?.test(text) && (
      id === "comments" || id === "changelog" ? !conditional.test(text) && !/\bonly\b/iu.test(text)
        : id === "assertions" ? !negative.test(text) : true
    );
    const repeat = text.toLowerCase() === rule.toLowerCase()
      || (id === "changelog" || id === "comments" || id === "logging" ? conditional.test(text) || /\bonly\b/iu.test(text)
        : id === "scope" ? negative.test(text) || /\b(?:keep|leave)\b.{0,65}\bout (?:of|from)\b/iu.test(text)
          : id === "additions" || id === "assertions" ? negative.test(text)
          : !opposite);
    const reason = opposite ? "conflict" : repeat ? "repeat" : "related rule";
    const previous = result.get(id);
    if (!previous || reason === "conflict" || reason === "repeat" && previous.reason === "related rule") {
      if (previous?.reason !== "conflict") result.set(id, { id, reason, path });
    }
  }
  return rules.flatMap(({ id }) => result.get(id) ?? []);
}

/**
 * Select the default pack for a checkout. Native-format integrations can use
 * these same ordered rules and omissions without depending on the planner.
 */
export function selectAgentDefaults(root: string, options: { enabled?: boolean; agents?: readonly string[]; listed?: readonly string[]; generated?: readonly string[] } = {}): AgentDefaults {
  const enabled = options.enabled !== false;
  const unavailable = Object.entries(unsupported).filter(([agent, signs]) =>
    options.agents?.includes(agent) || signs.some(name => existsSync(join(root, name)))).map(([agent]) => agentNames[agent]!);
  if (!enabled) return { rules: [], report: { enabled, available: 0, omitted: [], unavailable: [] } };
  const listed = listRuleSources(root, options.listed);
  function* sources() {
    for (const file of discoverRuleFiles(root, listed)) yield { path: file.path, body: ruleBody(file.text) };
    let bytes = 0;
    for (const name of [...new Set(listed)].sort()) {
      if (!contributorPath.test(name) && !extraInstructions.test(name)) continue;
      if (/(?:^|\/)(?:node_modules|vendor|fixtures?)\//u.test(name)) continue;
      try {
        const parent = posix.dirname(name);
        if (parent !== "." && !containedDirectory(root, parent.split("/"))) continue;
        const body = readBoundedTextFile(join(root, name), 256 * 1024);
        if (!body || body.includes(GENERATED_MARK)) continue;
        bytes += Buffer.byteLength(body);
        if (bytes > 8 * 1024 * 1024) break;
        yield { path: name, body: ruleBody(body) };
      } catch { /* unreadable or redirected repository input */ }
    }
    for (const body of options.generated ?? []) yield { path: "MEX rule entries", body };
  }
  const omitted = omissions(sources());
  const retained = rules.filter(rule => !omitted.some(item => item.id === rule.id));
  return { rules: retained, report: { enabled, available: retained.length, omitted, unavailable } };
}

export const defaultsScope = (root: string): string => "checkout:" + root;
export const DEFAULTS_REPORT = "native.defaults.v1";
export function parseDefaultsReport(value: string | undefined): DefaultsReport | undefined {
  if (!value) return undefined;
  try {
    return z.object({
      enabled: z.boolean(), available: z.number().int().min(0).max(rules.length),
      omitted: z.array(z.object({ id: z.string(), reason: z.enum(["conflict", "repeat", "related rule"]), path: z.string() })),
      unavailable: z.array(z.string()),
    }).parse(JSON.parse(value));
  } catch { return undefined; }
}

export function defaultsSummary(report: DefaultsReport): string {
  if (!report.enabled) return "MEX defaults are off.";
  const enabled = report.available === 1 ? "1 default" : `${report.available} defaults`;
  const omitted = report.omitted.length ? `, ${report.omitted.length} left out because your rules cover the same topics` : "";
  const unavailable = report.unavailable.length ? `. Unavailable for ${report.unavailable.join(", ")}` : "";
  return `MEX defaults. ${enabled} for common agent mistakes${omitted}${unavailable}.`;
}
