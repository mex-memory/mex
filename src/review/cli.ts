import { Command } from "commander";
import { KnowledgeError } from "../knowledge/entry.js";
import type { ReviewAction } from "./actions.js";

export function buildReviewCommand(): Command {
  const command = new Command("review").description("Review team-worthy rules that need your decision")
    .option("--json", "Print the visible queue as JSON")
    .action(async opts => run(opts.json, async () => {
      const { reviewQueue } = await import("./queue.js"), result = reviewQueue({ projectPath: process.cwd() });
      if (opts.json) { console.log(JSON.stringify({ ok: true, ...result })); return; }
      if (!result.items.length) { console.log("No rules waiting for Review."); return; }
      for (const [index, card] of result.items.entries()) console.log(`${index + 1}. ${card.entry.text}\nAsking because ${card.reason.replace(/\.$/u, "")}.\n${card.checkedByModel ? "Checked by model.\n" : ""}Share: mex review share ${card.id}\nKeep for me: mex review keep ${card.id}\nEdit: mex review edit ${card.id} "corrected rule"\n`);
      if (result.hidden) console.log(`${result.hidden} more will appear as these cards leave Review.`);
    }));
  for (const action of ["share", "keep", "edit"] as const) {
    const child = command.command(action).description(action === "share" ? "Preview sharing a rule in this working tree" : action === "keep" ? "Keep a claim personal and never ask again" : "Save a corrected rule personally")
      .argument("<card>", "Visible card id or number (1-5)");
    if (action === "edit") child.argument("<text>", "Corrected rule in plain words");
    child.option("--apply", "Apply this exact preview").option("--expect <revision>", "Revision printed by the preview").option("--json", "Print the preview or result as JSON");
    const perform = async (card: string, text: string | undefined, opts: { json?: boolean; apply?: boolean; expect?: string }) => {
      opts = { ...opts, json: child.optsWithGlobals().json };
      return run(opts.json, async () => {
      const { reviewAction } = await import("./actions.js");
      const result = await reviewAction(card, action as ReviewAction, { projectPath: process.cwd() }, { text, apply: opts.apply, expect: opts.expect });
      if (result.applied && action !== "share") (await import("../knowledge/native-queue.js")).queueNativeRebuild(process.cwd());
      if (opts.json) console.log(JSON.stringify({ ok: true, ...result }));
      else if (result.applied) console.log(action === "share" ? "Shared in this working tree. Include the diff in your next commit." : action === "keep" ? "Kept for you. This claim will not return to Review." : "Saved personally. Its checks must be recorded before sharing.");
      else console.log(`${result.preview.message}\n${result.preview.diff}\nRepeat with --apply --expect ${result.preview.revision}`);
      });
    };
    if (action === "edit") child.action((card, text, opts) => perform(card, text, opts));
    else child.action((card, opts) => perform(card, undefined, opts));
  }
  return command;
}
async function run(json: boolean | undefined, action: () => Promise<void>): Promise<void> {
  try { await action(); }
  catch (error) {
    const known = error instanceof KnowledgeError;
    const detail = { code: known ? error.code : "REVIEW_UNAVAILABLE", message: known ? error.message : "Review could not be read or updated." };
    if (json) console.log(JSON.stringify({ ok: false, error: detail })); else console.error(detail.message);
    process.exitCode = 1;
  }
}
