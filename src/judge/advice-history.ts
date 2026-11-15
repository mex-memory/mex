import type { KnowledgeEntry } from "../knowledge/entry.js";
import { git, entryFiles, type Position } from "./evidence.js";
import { nativeRequest } from "./native.js";

export type AdviceOrigin = { kind: "unknown" } | { kind: "wrong-all-along"; evidence: "person-confirmed" }
  | { kind: "outdated-since"; commit: string; previous: string; held_inputs_hash: string; evidence: "complete checks on first-parent history" };
export type SnapshotCheck = (entry: string, files: Record<string, string | null>) => Promise<{ verdict: string; checks: Array<{ role: string; status: string }>; inputs_hash: string }>;
const evaluate: SnapshotCheck = async (entry, files) => {
  const value = await nativeRequest({ action: "evaluate-snapshot", checkout: ".", entry, files }) as { result: Omit<Awaited<ReturnType<SnapshotCheck>>, "inputs_hash">; inputs_hash: string };
  return { ...value.result, inputs_hash: value.inputs_hash };
};
const unknown: AdviceOrigin = { kind: "unknown" };

/** Prove a contiguous held -> broken transition. A missing, shallow, oversized,
 * unsupported or uncommitted input never becomes a guessed commit/date. */
export async function adviceOrigin(checkout: string, entry: KnowledgeEntry, content: string, at: Position, check: SnapshotCheck = evaluate): Promise<AdviceOrigin> {
  const paths = entryFiles(entry);
  if (!at.head || !paths.length || paths.length > 16 || !entry.mex.checks.some(c => c.role === "complete")) return unknown;
  const parents = new Set<string>();
  for (const path of paths) {
    const parts=path.split("/");
    for(let n=1;n<parts.length;n++) parents.add(parts.slice(0,n).join("/"));
  }
  const requested=[...new Set([...paths,...parents])];
  if(requested.length>128 || Buffer.byteLength(requested.join("\n"))>32<<10) return unknown;
  const log = await git(checkout, ["log", "--first-parent", "-32", "--format=%H %P", at.head]);
  if (!log) return unknown;
  const commits = log.trim().split("\n").map(line => line.split(" ")[0]!);
  if (commits.some(commit => !/^[a-f0-9]{40,64}$/u.test(commit))) return unknown;
  let broken: string | undefined;
  const deadline = Date.now() + 15_000;
  for (const commit of commits) {
    if (Date.now() > deadline) return unknown;
    const tree = await git(checkout, ["ls-tree", "-z", "-r", "-t", commit, "--", ...paths], 64 << 10);
    if (tree === undefined) return unknown;
    const found = new Map<string, string>();
    for (const row of tree.split("\0").filter(Boolean)) {
      const match = /^(\d+) (?:blob|tree|commit) [a-f0-9]+\t([\s\S]+)$/u.exec(row);
      if (!match) return unknown;
      found.set(match[2]!, match[1]!);
    }
    // A file below a historical link/submodule is unavailable to this in-memory
    // evaluator. It is not proof that the target was absent at that commit.
    for(const parent of parents) {
      if(Date.now()>deadline) return unknown;
      if(!found.has(parent)) {
        // An exact parent query distinguishes a link from a missing directory
        // without listing all siblings under an otherwise normal parent.
        const row=await git(checkout,["ls-tree","-z",commit,"--",parent],8<<10);
        if(row===undefined) return unknown;
        if(row) {
          const match=/^(\d+) (?:blob|tree|commit) [a-f0-9]+\t([^\0]+)\0$/u.exec(row);
          if(!match || match[2]!==parent) return unknown;
          found.set(parent,match[1]!);
        }
      }
      if(found.has(parent) && found.get(parent)!=="040000") return unknown;
    }
    if(paths.some(path=>found.has(path) && !["100644","100755"].includes(found.get(path)!))) return unknown;
    const files: Record<string, string | null> = {};
    for (const path of paths) {
      if (Date.now() > deadline) return unknown;
      if (!found.has(path)) { files[path] = null; continue; }
      const text = await git(checkout, ["show", `${commit}:${path}`], 64 << 10);
      if (text === undefined) return unknown;
      files[path] = text;
    }
    let result: Awaited<ReturnType<SnapshotCheck>>;
    try { result = await check(content, files); } catch { return unknown; }
    if (result.verdict === "broken" && result.checks.some(c => c.role === "complete" && ["fail", "gone"].includes(c.status))) { broken = commit; continue; }
    if (broken && result.verdict === "held" && result.checks.length && result.checks.every(c => c.status === "pass")) {
      if (!/^sha256:[a-f0-9]{64}$/u.test(result.inputs_hash)) return unknown;
      return { kind: "outdated-since", commit: broken, previous: commit, held_inputs_hash: result.inputs_hash, evidence: "complete checks on first-parent history" };
    }
    return unknown;
  }
  return unknown;
}
export function originLine(origin: AdviceOrigin): string {
  if (origin.kind === "wrong-all-along") return "Wrong all along (person-confirmed): every recorded use is suspect.";
  if (origin.kind === "outdated-since") return `Outdated since commit ${origin.commit} (complete checks on first-parent history); earlier held observations are kept separate.`;
  return "When it became wrong is unknown.";
}
