import { Command, Option } from "commander";
import { ENTRY_KINDS, KnowledgeError } from "./contract.js";

export function buildKnowledgeCommands(): Command[] {
  const adviceReport = new Command("report").description("Read local advisories about advice already used on this branch")
    .option("--json", "Print local advisories as JSON")
    .action(async opts => run(opts.json, async () => {
      const { adviceReport, formatAdvice } = await import("../judge/advice.js");
      const result = await adviceReport({ projectPath: process.cwd() });
      if (opts.json) console.log(JSON.stringify({ ok: true, ...result }));
      else {
        if (!result.advisories.length) console.log("No local advice advisories on this branch.");
        for (const item of result.advisories) console.log(formatAdvice(item)+"\n");
        if (result.partial) console.log("More advisories exist; this view reached its limit.");
      }
    }));
  const sessionWhat = new Command("what").description("Read what MEX gave or withheld this session")
 .option("--session <id>","Session identifier").option("--json","Print receipt titles and counts as JSON")
 .action(async opts=>run(opts.json,async()=>{const {what,whatLine}=await import("./what.js");const result=what({projectPath:process.cwd()},opts.session);if(opts.json)console.log(JSON.stringify({ok:true,...result}));else {console.log(whatLine(result));for(const it of result.items)console.log(`${it.action} ${it.id} ${it.title}`);if(result.partial)console.log("More receipts exist; this view reached its work limit.");}}));
 const save = new Command("note")
    .alias("log")
    .description("Save a personal fact and its reason (log remains an alias for one release)")
    .argument("<text>", "A fact and its reason")
    .addOption(new Option("--kind <kind>", "Entry kind").choices([...ENTRY_KINDS]).default("rule"))
    .option("--scope <glob>", "Repository-relative scope (repeatable)", (value: string, previous: string[]) => [...previous, value], [])
    .option("--one-line <text>", "The complete claim in one line")
    .option("--json", "Print the saved entry as JSON")
    .action(async (text, opts) => {
      await run(opts.json, async () => {
        const { note } = await import("./store.js");
        const saved = note({ text, kind: opts.kind, scope: opts.scope.length ? opts.scope : undefined, oneLine: opts.oneLine }, { projectPath: process.cwd() });
        await queueRuleFiles();
        if (opts.json) console.log(JSON.stringify({ ok: true, ...saved }));
        else console.log(`Saved personal note ${saved.entry.mex.id} ${saved.label}\n${saved.entry.mex.one_line}`);
      });
    });
  const search = new Command("recall")
    .description("Search knowledge by words, without AI")
    .argument("<words>", "Words to find")
    .option("--limit <n>", "Maximum results, 1-100", "20")
    .option("--agent <name>", "Recipient agent; include hints from other agents only")
    .option("--json", "Print matching entries as JSON")
    .action(async (query, opts) => {
      await run(opts.json, async () => {
        const { recall } = await import("./store.js");
        if (!/^[0-9]+$/u.test(opts.limit)) throw new KnowledgeError("INVALID_LIMIT", "Search limit must be between 1 and 100.");
        const result = recall(query, { projectPath: process.cwd(), consumerAgent: opts.agent }, Number(opts.limit));
        if (opts.json) console.log(JSON.stringify({ ok: true, ...result }));
        else {
          if (!result.entries.length) console.log("No matching knowledge entries.");
          for (const item of result.entries) console.log(`${item.id} ${item.label}${item.branch && item.branch !== "default" ? ` [${item.branch === "branch" ? "not on default branch" : "default branch unverified"}]` : ""}\n${item.one_line}\nmore: mex expand ${item.id}\n`);
          if (result.truncated) console.log("More notes matched; narrow the words or increase --limit.");
          if (result.withheld) console.log(`${result.withheld} entries withheld by storage checks.`);
          if (result.hintsPartial) console.log("Hint source checking reached its work limit; results are partial.");
        }
      });
    });
  const full = new Command("expand")
    .description("Read a knowledge entry and its source and checks")
    .argument("<id>", "Stable entry id")
    .option("--agent <name>", "Recipient agent; never show its own memory back to it")
    .option("--json", "Print the full entry as JSON")
    .action(async (id, opts) => {
      await run(opts.json, async () => {
        const { expand } = await import("./store.js");
        const item = expand(id, { projectPath: process.cwd(), consumerAgent: opts.agent });
 const {noteProbe}=await import("./what.js");noteProbe(id,"opened",{projectPath:process.cwd()});
        if (opts.json) console.log(JSON.stringify({ ok: true, ...item }));
        else {
          const { serializeEntry } = await import("./entry.js");
          console.log(`${item.label}${item.level === "team" && item.branch !== "default" ? " [not verified on default branch]" : ""}\n${serializeEntry(item.entry)}`);
        }
      });
    });
  const change = new Command("edit")
    .description("Correct an entry; team changes require a reviewed preview")
    .argument("<id>", "Stable entry id")
    .argument("<text>", "The corrected fact and its reason")
    .addOption(new Option("--kind <kind>", "Entry kind").choices([...ENTRY_KINDS]))
    .option("--scope <glob>", "Repository-relative scope (repeatable)", (value: string, previous: string[]) => [...previous, value], [])
    .option("--one-line <text>", "The complete corrected claim in one line")
    .option("--apply", "Apply the reviewed team-entry change")
    .option("--expect <revision>", "The exact revision printed by the team preview")
    .option("--json", "Print the corrected entry as JSON")
    .action(async (id, text, opts) => {
      await run(opts.json, async () => {
        const { edit, editedEntry } = await import("./mutations.js");
        const { expand } = await import("./store.js");
        const options = { projectPath: process.cwd() };
        const input = { text, kind: opts.kind, scope: opts.scope.length ? opts.scope : undefined, oneLine: opts.oneLine };
        let current;
        try { current = expand(id, options); }
        catch (error) {
          if (!(error instanceof KnowledgeError) || error.code !== "NOT_FOUND") throw error;
          const { confirmHint } = await import("./hints.js");
          const saved = confirmHint(id, input, options);
          await queueRuleFiles();
          if (opts.json) console.log(JSON.stringify({ ok: true, ...saved }));
          else console.log(`Confirmed personal note ${id}\n${saved.entry.mex.one_line}`);
          return;
        }
        if (current.level === "team") {
          const { prepareTeamWrite, applyTeamWrite } = await import("./team.js");
          const preview = prepareTeamWrite(editedEntry(current.entry, input, new Date()), options, text);
          if (!opts.apply) { printPreview(preview, opts.json); return; }
          if (!opts.expect) throw new KnowledgeError("PREVIEW_REQUIRED", "Preview the team change, then pass --apply --expect <revision>.");
          const saved = applyTeamWrite(preview, opts.expect, options, text);
          const native = await sharedRuleFiles(options);
          if (opts.json) console.log(JSON.stringify({ ok: true, ...saved, native }));
          else console.log(`Updated team entry ${id}${native.length ? `\nRule files updated in the same change: ${native.join(", ")}` : ""}`);
          return;
        }
        const saved = edit(id, input, options);
        await queueRuleFiles();
        if (opts.json) console.log(JSON.stringify({ ok: true, ...saved }));
        else console.log(`Updated personal note ${id}\n${saved.entry.mex.one_line}`);
      });
    });
  const retire = (["wrong", "forget"] as const).map(action => new Command(action)
    .description(action === "wrong" ? "Retire an incorrect note and keep its reason" : "Hide a note permanently, keeping a local tombstone")
    .argument("<id>", "Stable entry id")
    .argument("<reason>", "Why this entry should no longer be used")
    .option("--apply", "Apply the reviewed team-entry retirement")
    .option("--expect <revision>", "The exact revision printed by the team preview")
    .option("--json", "Print the retirement record as JSON")
    .option("--all-along", "With wrong: explicitly confirm that every past use is suspect")
    .action(async (id, reason, opts) => {
      await run(opts.json, async () => {
        if (opts.allAlong && action !== "wrong") throw new KnowledgeError("INVALID_ENTRY", "--all-along is only valid with mex wrong.");
        const { forget, wrong } = await import("./mutations.js");
        const { expand } = await import("./store.js");
        const options = { projectPath: process.cwd() };
        let current;
        try { current = expand(id, options); }
        catch (error) {
          if (!(error instanceof KnowledgeError) || !["SECRET_FOUND", "NOT_FOUND"].includes(error.code)) throw error;
          if (error.code === "NOT_FOUND") {
            const { forgetHint } = await import("./hints.js");
            const marker = forgetHint(id, reason, options, new Date(), action);
            if (opts.allAlong) await (await import("../judge/advice.js")).wrongAllAlong(id, options);
            if (opts.json) console.log(JSON.stringify({ ok: true, level: "hint", status: "retired", ...marker }));
            else console.log(`Retired hint ${id}: ${marker.retired.reason}`);
            return;
          }
        }
        if (current?.level === "team") {
          const { prepareTeamWrite, applyTeamWrite } = await import("./team.js");
          const retired = { reason, by: `mex ${action}`, at: new Date().toISOString().slice(0, 10) };
          const preview = prepareTeamWrite({ ...current.entry, mex: { ...current.entry.mex, status: "retired", retired } }, options);
          if (!opts.apply) { printPreview(preview, opts.json); return; }
          if (!opts.expect) throw new KnowledgeError("PREVIEW_REQUIRED", "Preview the team change, then pass --apply --expect <revision>.");
          const saved = applyTeamWrite(preview, opts.expect, options);
          if (opts.allAlong) await (await import("../judge/advice.js")).wrongAllAlong(id, options);
          if (action === "wrong") (await import("./what.js")).noteProbe(id, "wrong", options);
          const native = await sharedRuleFiles(options);
          if (opts.json) console.log(JSON.stringify({ ok: true, id, level: "team", status: "retired", retired: saved.entry.mex.retired, native }));
          else console.log(`Retired team entry ${id}: ${saved.entry.mex.retired!.reason}${native.length ? `\nRule files updated in the same change: ${native.join(", ")}` : ""}`);
          return;
        }
        const marker = (action === "wrong" ? wrong : forget)(id, reason, { projectPath: process.cwd() });
        if (opts.allAlong) await (await import("../judge/advice.js")).wrongAllAlong(id, options);
        if (action === "wrong") (await import("./what.js")).noteProbe(id, "wrong", options);
        await queueRuleFiles();
        if (opts.json) console.log(JSON.stringify({ ok: true, level: "personal", status: "retired", ...marker }));
        else console.log(`Retired personal note ${id}: ${marker.retired.reason}`);
      });
    }));
  const hints = new Command("hints").description("Explicitly refresh or expire read-only agent-memory hints");
  hints.command("refresh")
    .description("Read this project's host memories without changing their files")
    .option("--expiry-months <n>", "Persist the hint lifetime (1-120 calendar months; default 6)")
    .option("--json", "Print bounded import/source status")
    .action(async opts => run(opts.json, async () => {
      const months = opts.expiryMonths === undefined ? undefined : Number(opts.expiryMonths);
      const { refreshHints } = await import("./hints.js");
      const result = refreshHints({ projectPath: process.cwd() }, new Date(), months);
      if (opts.json) console.log(JSON.stringify({ ok: true, ...result }));
      else console.log(`Hints: ${result.imported} imported, ${result.expired} expired, ${result.skipped} skipped.${result.partial ? " Source reading is partial." : ""}`);
    }));
  hints.command("expire").description("Remove expired hints and preserve their tombstones")
    .option("--json", "Print expiry results")
    .action(async opts => run(opts.json, async () => {
      const { expireHints } = await import("./hints.js");
      const result = expireHints({ projectPath: process.cwd() });
      if (opts.json) console.log(JSON.stringify({ ok: true, ...result }));
      else console.log(`Expired ${result.expired} hints.${result.retainedFiles ? ` ${result.retainedFiles} hidden copies need cleanup.` : ""}`);
    }));
  hints.command("status").description("Read local hint status without scanning or changing host memory")
    .option("--json", "Print hint status")
    .action(async opts => run(opts.json, async () => {
      const { hintStatus } = await import("./hints.js");
      const result = hintStatus({ projectPath: process.cwd() });
      if (opts.json) console.log(JSON.stringify({ ok: true, ...result }));
      else console.log(`${result.active} active hints; ${result.confirmed} confirmed; expiry ${result.expiryMonths} calendar months.`);
    }));
  const rules = new Command("rules")
    .description("Read the repo's rule files (CLAUDE.md, AGENTS.md, Cursor, Copilot, Gemini) into entries and list what needs review")
    .option("--write", "Also rebuild the agents' rule files from the entries")
    .option("--now", "With --write: rebuild even while a session is running here")
    .option("--json", "Print the scan as JSON")
    .action(async opts => run(opts.json, async () => {
      const { refreshRuleFiles, formatRules } = await import("./rule-cache.js");
      const cache = refreshRuleFiles({ projectPath: process.cwd() });
      const native = opts.write ? (await import("./native.js")).rebuildNative({ projectPath: process.cwd() }, { force: opts.now }) : undefined;
      if (opts.json) console.log(JSON.stringify({ ok: true, ...cache, ...(native ? { native } : {}) }));
      else {
        console.log(formatRules(cache));
        if (native) console.log(`\n${(await import("./native.js")).formatRebuild(native)}`);
      }
    }));
  const share = new Command("share")
    .description("Share your strongest notes with the team: preview, then commit them to a new branch (MEX never pushes unless you pass --pr)")
    .option("--skip <id>", "Leave this note out (repeatable)", (value: string, previous: string[]) => [...previous, value], [])
    .option("--apply", "Make the share you previewed")
    .option("--expect <revision>", "The revision the preview printed")
    .option("--pr", "With --apply: push the share branch and open a pull request")
    .option("--finish", "Finish a share that was stopped partway")
    .option("--discard", "Drop a share that was stopped partway")
    .option("--json", "Print the result as JSON")
    .action(async opts => run(opts.json, async () => {
      const { runShare, finishShare, discardShare, pendingShare } = await import("./share.js");
      const options = { projectPath: process.cwd() };
      const print = (value: object, text: string) => console.log(opts.json ? JSON.stringify({ ok: true, ...value }) : text);
      if (opts.finish) {
        const done = finishShare(options, { pr: opts.pr });
        print(done, `Finished the share: ${done.entries.length} entries on ${done.branch}.\n${nextStep(done)}`);
        return;
      }
      if (opts.discard) {
        const dropped = discardShare(options);
        print(dropped, `Discarded the share to ${dropped.branch}.${dropped.branchKept ? ` Its branch has a commit, so it was kept; delete it with: git branch -D ${dropped.branch}` : ""}`);
        return;
      }
      const waiting = pendingShare(options);
      if (waiting) throw new KnowledgeError("SHARE_IN_PROGRESS", `A share to ${waiting.branch} stopped at "${waiting.step}". Run mex share --finish or mex share --discard.`);
      if (opts.apply) {
        if (!opts.expect) throw new KnowledgeError("PREVIEW_REQUIRED", "Preview the share with mex share, then pass --apply --expect <revision>.");
        const done = runShare(options, opts.expect, { pr: opts.pr, skip: opts.skip });
        print(done, `Shared ${done.entries.length} entries on ${done.branch} (${done.files.length} files). Your branch wasn't touched.\n${nextStep(done)}`);
        return;
      }
      const { prepareShare } = await import("./share-plan.js");
      const plan = prepareShare(options, { skip: opts.skip });
      if (opts.json) { const { entries: _entries, ...shown } = plan; console.log(JSON.stringify({ ok: true, applied: false, ...shown })); return; }
      const lines = [plan.share.length ? `Share ${plan.share.length} with the team, on a new branch ${plan.branch} from ${plan.baseName}:` : "Nothing to share yet."];
      for (const item of plan.share) lines.push(`  ${item.id}  ${item.one_line}`);
      if (plan.blocked.length) { lines.push("", "Held back:"); for (const b of plan.blocked) lines.push(`  ${b.id}  ${b.reason}`); }
      if (plan.skipped.length) { lines.push("", "Not offered:"); for (const s of plan.skipped) lines.push(`  ${s.id}  ${s.reason}`); }
      if (plan.share.length) lines.push("", "Leave one out with --skip <id>. To share exactly this:", `  mex share --apply --expect ${plan.revision}    (add --pr to open a pull request)`);
      console.log(lines.join("\n"));
    }));
  const brief = new Command("brief")
    .description("Preview the session-start brief and native coverage without recording a delivery")
    .addOption(new Option("--agent <agent>", "Recipient agent").choices(["claude-code", "codex"]).makeOptionMandatory())
    .option("--path <path>", "Area or file within this checkout")
    .option("--json", "Include the coverage map and conservative token bound")
    .action(async opts => run(opts.json, async () => {
      const { previewBrief } = await import("./brief.js");
      const result = previewBrief({ projectPath: process.cwd() }, opts.agent, opts.path);
      console.log(opts.json ? JSON.stringify(result) : result.text);
    }));
  return [adviceReport, sessionWhat, save, search, full, change, ...retire, hints, rules, share, brief];
}
/** After a share: the pull request, or the push command (MEX doesn't push on its own). */
function nextStep(done: { branch: string; pr?: string }): string {
  return done.pr ? `Pull request: ${done.pr}` : `Push it when you're ready: git push -u origin ${done.branch}`;
}

/** Shared rule files change in the same working-tree change as the team entry. */
async function sharedRuleFiles(options: { projectPath: string }): Promise<string[]> {
  const { rebuildNative } = await import("./native.js");
  const result = rebuildNative(options, { sharedOnly: true, force: true });
  return [...result.written ?? [], ...result.removed ?? []];
}

/** Personal note changes reach the hidden local rule files between sessions. */
async function queueRuleFiles(): Promise<void> {
  const { queueNativeRebuild } = await import("./native-queue.js");
  queueNativeRebuild(process.cwd());
}

function printPreview(preview: { revision: string; diff: string }, json: boolean | undefined): void {
  if (json) console.log(JSON.stringify({ ok: true, applied: false, preview }));
  else console.log(`${preview.diff}\nTo apply this exact change, repeat the command with --apply --expect ${preview.revision}`);
}
async function run(json: boolean | undefined, action: () => Promise<void>): Promise<void> {
  try { await action(); }
  catch (error) {
    const known = error instanceof KnowledgeError;
    const code = known ? error.code : "STORE_UNAVAILABLE";
    const message = known ? error.message : "Knowledge storage could not be read or written.";
    if (json) console.log(JSON.stringify({ ok: false, error: { code, message } }));
    else console.error(message);
    process.exitCode = 1;
  }
}
