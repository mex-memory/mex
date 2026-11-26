import { posix } from "node:path";
import { parseMarkdown } from "../markdown.js";
import { aiPolicyPath, documentPathKind } from "./harvest/documents.js";
import type { Candidate } from "./harvest/types.js";
import { squash } from "./lesson-text.js";

const directive = /^((?:if|when|before|for) [^.!?]+?, )?(?:please )?(read|follow)(?: (?:our|the))?$/iu;
const continuation = /^(?:,? (?:if|when|before|for|unless|while) [^.!?]+)?[.!]?$/iu;
const ai = /\b(?:AI|LLMs?)\b/iu;
const submission = /\b(?:pull requests?|PRs?|contribut(?:ions?|ing)|submi(?:t|tting|ssion))\b/iu;

/** Preserve explicit read/follow instructions and their conditions, with the linked policy named by its pinned path. */
export function submissionPolicyReferences(candidates: readonly Candidate[], paths: ReadonlySet<string>) {
  const references: Array<{ candidate: Candidate; path: string; text: string; quote: string }> = [];
  for (const candidate of candidates) {
    const { path: source, text } = candidate;
    if (!source || !/\.mdx?$/iu.test(source) || !text.includes("](") || !ai.test(text)) continue;
    for (const paragraph of parseMarkdown(text).children) {
      if (paragraph.type !== "paragraph") continue;
      const [link, other] = paragraph.children.filter(node => node.type === "link");
      if (!link || other || posix.isAbsolute(link.url) || /[:\\]/u.test(link.url)) continue;
      const path = posix.join(posix.dirname(source), link.url);
      if (!paths.has(path) || path.includes("`") || !aiPolicyPath(path) || documentPathKind(path) !== "doc") continue;
      const start = paragraph.position?.start.offset, end = paragraph.position?.end.offset;
      const from = link.position?.start.offset, to = link.position?.end.offset;
      if (start === undefined || end === undefined || from === undefined || to === undefined) continue;
      const before = squash(text.slice(start, from));
      const after = text.slice(to, end).replace(/\s+/gu, " ").trimEnd();
      const match = directive.exec(before);
      if (!match || !continuation.test(after) || !ai.test(before + after) || !submission.test(before + after)) continue;
      const action = (match[1] ?? "") + match[2]!.toLowerCase() + " `" + path + "`" + after;
      references.push({ candidate, path, text: action[0]!.toUpperCase() + action.slice(1), quote: text.slice(start, end) });
    }
  }
  return references;
}
