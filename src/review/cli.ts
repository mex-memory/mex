import { Command } from "commander";
import { KnowledgeError } from "../knowledge/entry.js";
import type { ReviewAction } from "./actions.js";
import type { AgentReply } from "../filter/review-context.js";

function replyContext(context?: AgentReply): string {
  if (!context) return "";
  const indent = (text: string) => text.split("\n").map(line => `  ${line}`).join("\n");
  return `Typed quote\n${indent(context.quote)}\nAgent-written reply context\n${indent(context.text ?? "Unavailable")}\n`;
}

export function buildReviewCommand(): Command {
  const command = new Command("review").description("Review rules that need your decision")
    .option("--json", "Print the visible queue as JSON")
    .action(async opts => run(opts.json, async () => {
      const { reviewQueue } = await import("./queue.js"), result = reviewQueue({ projectPath: process.cwd() }, Date.now(), true);
      if (opts.json) { console.log(JSON.stringify({ ok: true, ...result })); return; }
      if (!result.items.length) { console.log("No rules waiting for Review."); return; }
      for (const [index, card] of result.items.entries()) {
        if (card.conflictsWith) {
          console.log(`${index + 1}. ${card.entry.text}\nContradicts ${card.conflictsWith.join(", ")}.\nKeep current: mex review keep ${card.id}\nUse proposal: mex review use ${card.id}\n`);
          continue;
        }
        console.log(`${index + 1}. ${card.entry.text}\nAsking because ${card.reason.replace(/\.$/u, "")}.\n${card.checkedByModel ? "Checked by model.\n" : ""}${replyContext(card.agentContext)}Share: mex review share ${card.id}\nKeep for me: mex review keep ${card.id}\nEdit: mex review edit ${card.id} "corrected rule"\n`);
      }
      if (result.hidden) console.log(`${result.hidden} more will appear as these cards leave Review.`);
    }));
  const choices = command.command("choices").description("Review recent weak personal approvals from clicked choices")
    .option("--json", "Print the approvals as JSON")
    .option("--limit <count>", "Number of recent tool calls to show", "5");
  choices.action(async () => {
    const { json, limit } = choices.optsWithGlobals();
    await run(json, async () => {
      if (!/^\d+$/u.test(limit) || Number(limit) < 1 || Number(limit) > 128) {
        throw new KnowledgeError("INVALID_OPTION", "Use a limit between 1 and 128.");
      }
      const { clickedApprovals } = await import("../filter/clicked-approvals.js");
      const approvals = clickedApprovals({ projectPath: process.cwd() });
      const items = approvals.slice(0, Number(limit));
      if (json) { console.log(JSON.stringify({ ok: true, items, total: approvals.length })); return; }
      if (!items.length) { console.log("No recent clicked choices to review."); return; }
      for (const item of items) {
        const label = item.tool === "ExitPlanMode" ? "plan" : "option";
        for (const choice of item.choices) {
          const text = [choice.label, choice.text, choice.preview].filter(Boolean).join("\n");
          const indented = text.split(/\r\n?|[\n\u2028\u2029]/u).map(line => `  ${line}`).join("\n");
          console.log(`Agent-written ${label} (${item.agent}, ${item.at.slice(0, 10)})\n${indented}\n`);
        }
      }
      if (approvals.length > items.length) console.log(`Showing ${items.length} of ${approvals.length} recent tool calls. Use --limit to show more.`);
      console.log('These choices are weak personal approvals. To save a rule, restate it with mex note "your wording".');
    });
  });
  for (const action of ["share", "keep", "edit", "use"] as const) {
    const child = command.command(action).description(action === "share" ? "Preview sharing a rule in this working tree" : action === "keep" ? "Keep a claim personal and never ask again" : action === "use" ? "Use a proposed rule in a contradiction" : "Save a corrected rule personally")
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
      else if (result.applied) console.log(action === "share" ? "Shared in this working tree. Include the diff in your next commit." : action === "keep" ? result.preview.conflict ? "Kept the current entries." : "Kept for you. This claim will not return to Review." : action === "use" ? "Saved the proposal personally." : "Saved personally. Its checks must be recorded before sharing.");
      else console.log(`${result.preview.message}\n${replyContext(result.preview.agentContext)}${result.preview.diff}\nRepeat with --apply --expect ${result.preview.revision}`);
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
