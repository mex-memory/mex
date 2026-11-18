import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { closeHandoff, draftHandoff, writeHandoff, type HandoffDraft } from "./handoff.js";

export interface HandoffOptions { to?: string; yes?: boolean; dryRun?: boolean; branch?: string; json?: boolean; projectPath?: string; }

function preview(draft: HandoffDraft): string {
  const lines = [`${draft.replaces ? "Replaces" : "Writes"} ${draft.path}:`, "", ...draft.content.trimEnd().split("\n").map(l => `  ${l}`)];
  if (draft.held.length) {
    lines.push("", "Left out:");
    for (const h of draft.held) lines.push(`  ${h.line}  (${h.reason})`);
  }
  if (draft.uncommitted.length) lines.push("", `${draft.uncommitted.length} uncommitted file${draft.uncommitted.length === 1 ? "" : "s"} won't reach your teammate unless you commit ${draft.uncommitted.length === 1 ? "it" : "them"} too.`);
  return lines.join("\n");
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return /^y(?:es)?$/iu.test((await rl.question(question)).trim()); } finally { rl.close(); }
}

/** Returns the exit code. */
export async function runHandoff(words: string[], opts: HandoffOptions): Promise<number> {
  const options = { projectPath: opts.projectPath ?? process.cwd() };
  if (words.length === 1 && words[0] === "done") {
    const closed = closeHandoff(options, opts.branch);
    if (opts.json) console.log(JSON.stringify({ ok: true, ...closed }));
    else if (!closed.removed) console.log(`No handoff for ${closed.branch} here.`);
    else console.log(`Closed the handoff for ${closed.branch}: removed ${closed.path}.${closed.tracked ? " Commit the deletion with your next commit." : ""}`);
    return 0;
  }
  const draft = draftHandoff({ line: words.length ? words.join(" ") : undefined, to: opts.to }, options);
  const write = !opts.dryRun && (opts.yes || (!opts.json && process.stdin.isTTY && process.stdout.isTTY && await (async () => {
    console.log(preview(draft));
    return confirm("\nWrite it? [y/N] ");
  })()));
  if (!write) {
    if (opts.json) console.log(JSON.stringify({ ok: true, written: false, branch: draft.branch, path: draft.path, content: draft.content, held: draft.held, uncommitted: draft.uncommitted.length }));
    else {
      if (opts.dryRun || !process.stdin.isTTY || !process.stdout.isTTY) console.log(preview(draft));
      console.log(opts.dryRun || process.stdin.isTTY ? "\nNothing written." : "\nNothing written. Run `mex handoff --yes` with the same words to write it.");
    }
    return 0;
  }
  writeHandoff(draft);
  if (opts.json) console.log(JSON.stringify({ ok: true, written: true, branch: draft.branch, path: draft.path, content: draft.content, held: draft.held, uncommitted: draft.uncommitted.length }));
  else {
    if (opts.yes) console.log(preview(draft));
    // A person's own ignore rules may hide .mex/; then a plain git add refuses the file.
    const ignored = spawnSync("git", ["-C", draft.root, "check-ignore", "-q", "--", draft.path], { stdio: "ignore", windowsHide: true }).status === 0;
    console.log(`\nWrote ${draft.path}. Commit it with the branch, for example:\n  git add ${ignored ? "-f " : ""}${draft.path} && git commit -m "Hand off ${draft.branch}"\nMEX never pushes. The next agent session on ${draft.branch} gets it once.`);
  }
  return 0;
}
