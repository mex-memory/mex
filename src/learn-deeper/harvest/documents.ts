import { posix } from "node:path";
import { GENERATED_MARK, ruleFormat } from "../../knowledge/rule-files.js";
import { getTextContent, parseMarkdown } from "../../markdown.js";
import { Reviewers } from "../reviewers.js";
import { sourceDigest } from "../source.js";
import { templatePath } from "./description.js";
import { cleanText, excerpt, newCandidate, safePath, safeRaw, TEXT_BYTES, type Gaps } from "./evidence.js";
import type { Candidate, HarvestPoint } from "./types.js";

type DocKind = "adr" | "doc";
const prose = /\.(?:mdx?|rst|txt|adoc)$/iu;
const excludedDocs = {
  sections: /^(?:codeofconduct|securitypolicy|licen[cs]es?|changelogs?|history|releasenotes?|funding|supportpolicy|(?:author|contributor)lists?|governance|(?:issue|pullrequest)templates?)$/iu,
  files: /^(?:security|support|authors?|contributors?)$/iu,
};
const docName = (name: string) => name.replace(/[._ -]/gu, "");
const aiPolicy = /^(?:ai|llm)(?:[._ -](?:contribution|usage|use))?[._ -]policy$/iu;
const guides = /^(?:contributing|development|developing|architecture|maintaining|hacking|(?:code[-_. ])?style|conventions|testing|release[-_. ]process|building[-_. ]from[-_. ]source|developer[-_. ]guide|maintainer[-_. ]guide|getting[-_. ]started[-_. ]developing)(?:[._-][^/]*)?$/iu;
const adrHeading = /\b(?:alternatives?|considered options?|options considered|rejected|consequences?|decisions?)\b/iu;
const contributor = /\b(?:contribut\w*|develop(?:ment|ing|ers?)|architecture|maintain\w*|building from source|local setup|running tests|testing|hacking|release process|style|conventions)\b/iu;
const consumer = /\b(?:install(?:ation|ing)?|quick[- ]?start|usage|using the package|getting started|examples?|api reference)\b/iu;

export function aiPolicyPath(path: string): boolean {
  const name = posix.basename(path);
  return prose.test(name) && aiPolicy.test(name.replace(prose, ""));
}

export function documentPathKind(path: string): DocKind | "heading" | undefined {
  if (!safePath(path) || !prose.test(path)) return undefined;
  const segments = path.split("/");
  const name = posix.basename(path).replace(prose, "");
  if (segments.some((_, i) => ruleFormat(segments.slice(i).join("/")))
    || /^(?:agents(?:\.override)?|claude(?:\.local)?|gemini|copilot-instructions)$/iu.test(name)
    || /(?:^|\/)\.(?:cursor|claude|mex)\/|(?:^|\/)\.github\/instructions\//iu.test(path)
    || segments.some(part => ["node_modules", "vendor"].includes(part.toLowerCase()))) return undefined;
  const policy = aiPolicyPath(path);
  if (templatePath.test(path) || segments[0] === ".github" && segments.length === 2 && (policy || /^contributing/iu.test(name))) return "doc";
  if (segments.some(part => part.startsWith("."))) return undefined;
  if (excludedDocs.files.test(docName(name))
    || [...segments.slice(0, -1), name].some(part => excludedDocs.sections.test(docName(part)))) return undefined;
  if (/(?:^|\/)(?:adrs?|decisions|rfcs)\//iu.test(path) || /adr/iu.test(name)) return "adr";
  if (policy || guides.test(name) || /^contributing/iu.test(name)) return "doc";
  if (/(?:^|\/)docs?\//iu.test(path)) return contributor.test(path.replace(prose, "").replace(/[\/._-]+/gu, " ")) ? "doc" : "heading";
  if (/^readme$/iu.test(name)) return "doc";
}

interface Heading { level: number; name: string; start: number; end: number; }

export function docKind(path: string, raw?: string): DocKind | undefined {
  const kind = documentPathKind(path);
  if (kind !== "heading") return kind;
  if (raw !== undefined && safeRaw(raw) !== undefined && contributor.test(headings(raw, path)[0]?.name ?? "")) return "doc";
}

function headings(raw: string, path: string): Heading[] {
  if (/\.adoc$/iu.test(path)) return [...raw.matchAll(/^(={1,6})[ \t]+(.+)$/gmu)].map(match => ({
    level: match[1]!.length, name: match[2]!.trim(), start: match.index, end: match.index + match[0].length,
  }));
  if (/\.rst$/iu.test(path)) {
    const levels = new Map<string, number>();
    return [...raw.matchAll(/^([^\s][^\n]+)\r?\n([=~^-])\2{2,}[ \t]*\r?$/gmu)].map(match => {
      if (!levels.has(match[2]!)) levels.set(match[2]!, levels.size + 1);
      return { level: levels.get(match[2]!)!, name: match[1]!.trim(), start: match.index, end: match.index + match[0].length };
    });
  }
  return parseMarkdown(raw).children.flatMap(node => {
    if (node.type !== "heading" || node.position?.start.offset === undefined || node.position.end.offset === undefined) return [];
    return [{ level: node.depth, name: getTextContent(node), start: node.position.start.offset, end: node.position.end.offset }];
  });
}

/** Break long passages at a line when practical, and never cut UTF-8 in the middle of a character. */
function passages(raw: string): string[] {
  const result: string[] = [];
  let rest = raw.trim();
  while (rest) {
    let part = excerpt(rest, TEXT_BYTES);
    const newline = part.lastIndexOf("\n");
    if (part.length < rest.length && newline > part.length / 2) part = part.slice(0, newline);
    result.push(part);
    rest = rest.slice(part.length).trimStart();
  }
  return result;
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").trim().replace(/\s+/gu, "-") || "section";
}

export function documentCandidates(point: HarvestPoint, kind: DocKind, raw: string, reviewers: Reviewers, gaps: Gaps): Candidate[] {
  const path = point.id;
  const pathKind = documentPathKind(path);
  if (pathKind !== kind && (pathKind !== "heading" || kind !== "doc")) return [];
  // Check the whole file before splitting. A private marker or key can span section boundaries.
  if (raw.includes(GENERATED_MARK)) return [];
  if (safeRaw(raw) === undefined) { gaps.withheld(false); return []; }
  const tree = headings(raw, path);
  if (pathKind === "heading" && !contributor.test(tree[0]?.name ?? "")) return [];
  const stack: Heading[] = [];
  const counts = new Map<string, number>();
  const used = new Set<string>();
  const output: Candidate[] = [];
  const readme = /^readme$/iu.test(posix.basename(path).replace(prose, ""));
  const policy = aiPolicyPath(path);
  const hasContributorSection = tree.some(heading => contributor.test(heading.name));
  const title = tree[0]?.level === 1 ? tree[0].name : "";
  const slots = [{ level: 0, name: "", start: 0, end: 0 }, ...tree];
  for (const [i, heading] of slots.entries()) {
    while (stack.length && stack.at(-1)!.level >= heading.level) stack.pop();
    if (heading.level) stack.push(heading);
    const names = stack.map(item => item.name);
    const body = raw.slice(heading.end, slots[i + 1]?.start ?? raw.length).trim();
    const consumerUsage = !policy && names.some(name => consumer.test(name));
    const base = heading.name ? slug(heading.name) : "intro";
    let seen = counts.get(base) ?? 0;
    let anchor = seen ? `${base}-${seen}` : base;
    while (used.has(anchor)) anchor = `${base}-${++seen}`;
    counts.set(base, seen + 1);
    used.add(anchor);
    if (!body || (kind === "adr" && !adrHeading.test(heading.name))) continue;
    if (readme && !names.some(name => contributor.test(name)) && !(consumerUsage && hasContributorSection)) continue;
    if (!readme && kind === "doc" && /(?:^|\/)docs?\//iu.test(path)
      && /(?:^|\/)(?:api[-_ ]?reference|reference|generated)\//iu.test(path)
      && ![...names, title].some(name => contributor.test(name))) continue;
    const chunks = passages(body);
    if (kind === "adr" && chunks.length > 1) gaps.messages.add("Some long decision sections were excerpted.");
    const document = { headings: names.map(name => cleanText(name, gaps, reviewers, 256) ?? ""), consumerUsage };
    for (const [chunk, part] of (kind === "adr" ? chunks.slice(0, 1) : chunks).entries()) {
      const text = cleanText(part, gaps, reviewers);
      if (!text) continue;
      const fragment = encodeURIComponent(anchor);
      output.push(newCandidate({ id: `doc:${path}#${fragment}${chunk ? `:${chunk + 1}` : ""}`, link: `${path}#${fragment}`,
        kind, hash: sourceDigest(part), at: point.at, path, title: document.headings.at(-1), text,
        nodeIds: [], reviewers: [], document }));
    }
  }
  return output;
}
