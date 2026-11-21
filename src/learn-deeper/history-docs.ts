import { z } from "zod";
import { getTextContent, parseMarkdown } from "../markdown.js";
import { repoPath } from "./git.js";

const VERSION = "\\d+\\.\\d+(?:\\.(?:\\d+|x))?";
const STATUS = "(?:superseded|historical|frozen|archived|retired)";
const currentBranch = new RegExp("\\bthis branch (?:is|uses|targets) (?:the )?v?(" + VERSION + ")\\b", "iu");
const legacyBranches = new RegExp("\\b([a-zA-Z0-9][a-zA-Z0-9_./-]*) (?:stays|remains) on v?(" + VERSION + ")\\b", "gu");
const scopedVersion = new RegExp("(?:\\b(?:frozen|maintained) for (?:the )?|^ *(?:version scope|applies to)\\s*:\\s*)"
  + "(?:mex +|version +|release +)?v?(" + VERSION + ")\\b", "imu");
const versionSnapshot = new RegExp("^This (?:page|guide|document) documents [^\\n]{0,120}\\bincluded in (?:mex )?v?(" + VERSION + ")\\b", "imu");
const status = new RegExp("^ *(?:status\\s*:\\s*[\"']?|this (?:document|design|guide|page|proposal) (?:is |has been )(?:now )?)"
  + STATUS + "\\b", "imu");
const statusTitle = new RegExp("(?:\\(" + STATUS + "\\)|\\[" + STATUS + "\\])\\s*$", "iu");
const targetBranch = /(?:^ *(?:target )?branch\s*: *|\b(?:contributions|changes|patches|pull requests) target )([a-z0-9][a-z0-9_./-]*[a-z0-9])\b/imu;
const releasePlan = /(?:^|[._-])release[._-]plan(?:[._-]|$)/iu;
const releaseIdentifier = /(?:^|[._-])(?:v?\d+\.\d+\.\d+|\d{4}-\d{2}-\d{2})(?:[._-]|$)/iu;

export const StaleDoc = z.object({
  path: z.string().refine(repoPath),
  reason: z.enum(["release-plan", "explicit-status", "version-scope", "branch-scope"]),
}).strict();
type Reason = z.infer<typeof StaleDoc>["reason"];

function header(raw: string, length: number): { text: string; title: string } {
  const nodes = parseMarkdown(raw.slice(0, length)).children;
  const text = nodes.flatMap(node => node.type === "yaml" ? [node.value] :
    node.type === "heading" || node.type === "paragraph" || node.type === "blockquote" ? [getTextContent(node)] : []).join("\n");
  const heading = nodes.find(node => node.type === "heading");
  return { text, title: heading ? getTextContent(heading) : "" };
}

function releaseLine(version: string): string { return version.split(".").slice(0, 2).join("."); }

/** Use an explicit branch declaration from the pinned tree. Do not infer age from the Git date. */
export function branchScope(raw: string | undefined): { version?: string; legacy: Set<string> } {
  const text = raw ? header(raw, 1024).text : "";
  const version = currentBranch.exec(text)?.[1];
  const legacy = new Set<string>();
  if (version) for (const [, name, old] of text.matchAll(legacyBranches)) {
    if (releaseLine(old) !== releaseLine(version)) legacy.add(name);
  }
  return { version, legacy };
}

export function staleDoc(path: string, raw: string, branch: ReturnType<typeof branchScope>): Reason | undefined {
  const name = path.split("/").at(-1)!;
  if (releasePlan.test(name) && releaseIdentifier.test(name)) return "release-plan";
  const { text, title } = header(raw, 2048);
  if (status.test(text) || statusTitle.test(title)) return "explicit-status";
  const version = scopedVersion.exec(text)?.[1] ?? versionSnapshot.exec(text)?.[1];
  if (version && branch.version && releaseLine(version) !== releaseLine(branch.version)) return "version-scope";
  const target = targetBranch.exec(text)?.[1];
  if (target && branch.legacy.has(target)) return "branch-scope";
}
