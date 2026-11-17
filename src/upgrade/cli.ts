import { Command } from "commander";
import { KnowledgeError } from "../knowledge/contract.js";

/** The files a unified diff touches, with what happens to each. */
export function diffFiles(diff: string): Array<{ path: string; change: "new" | "removed" | "changed" }> {
  const out: Array<{ path: string; change: "new" | "removed" | "changed" }> = [];
  for (const block of diff.split(/^diff --git /mu).slice(1)) {
    const path = /^a\/(.+?) b\//u.exec(block)?.[1] ?? block.split("\n")[0]!;
    out.push({ path, change: /^new file mode/mu.test(block) ? "new" : /^deleted file mode/mu.test(block) ? "removed" : "changed" });
  }
  return out;
}

export function buildUpgradeCommand(effects: { afterUpgrade?: () => void } = {}): Command {
  return new Command("upgrade").description("Preview the 0.8 upgrade; keep human documents and import their knowledge")
    .option("--apply", "Apply the approved personal/local changes and prepare a separate tracked branch")
    .option("--expect <revision>", "The exact revision printed by the preview")
    .option("--pr", "With --apply or --finish: push the upgrade branch and open its pull request")
    .option("--finish", "Finish an interrupted upgrade from its exact recorded outputs")
    .option("--discard", "Discard pending tracked output; applied personal/local changes stay")
    .option("--json", "Print the full preview or result as JSON")
    .option("--diff", "Show every line of the tracked changes in the preview")
    .action(async opts => {
      try {
        const { runUpgrade, finishUpgrade, discardUpgrade, pendingUpgrade, completedUpgrade } = await import("./run.js");
        const options = { projectPath: process.cwd() };
        if ([opts.apply, opts.finish, opts.discard].filter(Boolean).length > 1 || (opts.pr && !opts.apply && !opts.finish) || (opts.expect && !opts.apply)) throw new KnowledgeError("UPGRADE_OPTIONS", "Choose preview, --apply --expect, --finish, or --discard; --pr requires --apply or --finish.");
        if (opts.discard) {
          const result = await discardUpgrade(options);
          console.log(opts.json ? JSON.stringify({ ok: true, ...result }) : `Discarded pending tracked output for ${result.branch}. Applied personal/local changes stay.${result.branchKept ? " Its committed branch was kept." : ""}`);
          return;
        }
        const waiting = pendingUpgrade(options);
        if (!opts.finish && waiting) throw new KnowledgeError("UPGRADE_IN_PROGRESS", `Upgrade ${waiting.branch} stopped after ${waiting.step}; use --finish or --discard.`);
        const done = completedUpgrade(options);
        if (!opts.finish && done) {
          console.log(opts.json ? JSON.stringify({ ok: true, alreadyUpgraded: true, ...done }) : `This checkout has already been upgraded.${done.commit ? ` Review ${done.pr ?? done.branch}.` : ""}`);
          if (!opts.json) effects.afterUpgrade?.();
          return;
        }
        if (opts.apply || opts.finish) {
          if (opts.apply && !opts.expect) throw new KnowledgeError("PREVIEW_REQUIRED", "Run mex upgrade, then pass --apply --expect <revision>.");
          const result = opts.finish ? await finishUpgrade(options, { pr: opts.pr }) : await runUpgrade(options, opts.expect, { pr: opts.pr });
          console.log(opts.json ? JSON.stringify({ ok: true, applied: true, ...result }) : `Imported ${result.personal} personal entries and applied ${result.local} local changes.${result.commit ? `\nTracked changes: ${result.branch} (${result.files.length} files).\n${result.pr ?? `Review the branch; push only when ready: git push -u origin ${result.branch}`}` : ""}`);
          if (!opts.json) effects.afterUpgrade?.();
          return;
        }
        const { prepareUpgrade } = await import("./plan.js");
        const plan = prepareUpgrade(options);
        if (opts.json) console.log(JSON.stringify({ ok: true, applied: false, ...plan }));
        else {
          console.log(plan.present ? `Upgrade ${plan.entries.length} entries (${plan.entries.filter(e => e.level === "team").length} team, ${plan.personal.length} new personal).` : "No legacy MEX scaffold here.");
          if (plan.diff && opts.diff) console.log(plan.diff);
          else if (plan.diff) {
            // The full diff of a real repo runs to thousands of lines: list the files, keep the lines one flag away.
            const files = diffFiles(plan.diff);
            console.log(`Changes to tracked files, on a separate branch (${files.length}):`);
            for (const f of files.slice(0, 15)) console.log(`  ${f.change.padEnd(7)} ${f.path}`);
            if (files.length > 15) console.log(`  … and ${files.length - 15} more`);
            console.log("Every line of it: mex upgrade --diff");
          }
          if (plan.retained.length) console.log(`Kept in place: ${[...new Set(plan.retained)].join(", ")}`);
          for (const issue of plan.issues) console.log(`${issue.blocking ? "Blocked" : "Review; source kept"}: ${issue.code} ${issue.path}`);
          if (plan.ready && (plan.diff || plan.personal.length)) console.log(`To apply exactly this: mex upgrade --apply --expect ${plan.revision}\nAdd --pr to push and open the pull request.`);
        }
      } catch (error) {
        const code = error instanceof KnowledgeError ? error.code : "UPGRADE_UNAVAILABLE";
        const message = error instanceof KnowledgeError ? error.message : "The upgrade could not finish; existing files and any recovery record were kept for review.";
        if (opts.json) console.log(JSON.stringify({ ok: false, error: { code, message } })); else console.error(message);
        process.exitCode = 1;
      }
    });
}
