import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "./workspace.mjs";

// Only explicitly delimited managed blocks may differ between arms.
export function withoutMexBlocks(text) {
  return String(text).replace(/\r\n/g, "\n")
    .replace(/<!-- ((?:mex|mex-agent)(?::[a-z-]+)+):start -->[\s\S]*?<!-- \1:end -->\n?/g, "")
    .trimEnd();
}

export function instructionSnapshot(workspace) {
  const paths = git(workspace, ["ls-files", "-z"]).stdout.split("\0")
    .filter((p) => /(?:^|\/)(?:CLAUDE|AGENTS)\.md$/.test(p) && !p.startsWith(".mex/"));
  return Object.fromEntries(paths.filter((p) => existsSync(join(workspace, p)))
    .map((p) => [p, withoutMexBlocks(readFileSync(join(workspace, p), "utf8"))]).filter(([, text]) => text));
}

export function assertInstructionParity(control, treatment) {
  const different = [...new Set([...Object.keys(control), ...Object.keys(treatment)])]
    .filter((p) => control[p] !== treatment[p]);
  if (different.length) throw new Error(`arm instruction mismatch outside managed MEX blocks: ${different.join(", ")}`);
  return { identical: true, files: Object.keys(control).sort() };
}
