import { Argument, Command, Option } from "commander";
import { ENTRY_KINDS, KnowledgeError } from "./contract.js";
import { buildReviewCommand } from "../review/cli.js";

export function buildKnowledgeCommands(): Command[] {
  const adviceReport = new Command("report").description("Read local advisories or session cost estimates")
    .option("--json", "Print the report as JSON")
    .option("--ledger", "Show session cost, context footprint and holdout comparisons")
    .addOption(new Option("--holdout <on|off>", "Set the local randomized holdout study").choices(["on", "off"]))
    .action(async opts => run(opts.json, async () => {
      if (opts.ledger && opts.holdout) throw new KnowledgeError("INVALID_OPTION", "Set the holdout study and read the ledger in separate commands.");
      if (opts.holdout) {
        const { setLedgerHoldout } = await import("../controls/index.js");
        const { openRecord } = await import("../record/index.js");
        const writer = openRecord();
        const enabled = opts.holdout === "on";
        try { setLedgerHoldout(writer, enabled); } finally { writer.close(); }
        if (opts.json) console.log(JSON.stringify({ ok: true, holdoutEnabled: enabled }));
        else console.log(enabled ? "MEX holdout study is on. About 10% of new eligible sessions will run without MEX hooks." : "MEX holdout study is off.");
        return;
      }
      if (opts.ledger) {
        const { ledgerReport, formatLedgerReport } = await import("../ledger/report.js");
        const result = ledgerReport(process.cwd());
        if (opts.json) console.log(JSON.stringify({ ok: true, ...result }));
        else console.log(formatLedgerReport(result));
        return;
      }
      const { adviceReport, formatAdvice } = await import("../judge/advice.js");
      const { patternReport, formatPatternReport } = await import("./pattern-report.js");
      const result = await adviceReport({ projectPath: process.cwd() });
      const patterns = patternReport({ projectPath: process.cwd() });
      if (opts.json) console.log(JSON.stringify({ ok: true, ...result, patterns }));
      else {
        if (!result.advisories.length) console.log("No local advice advisories on this branch.");
        for (const item of result.advisories) console.log(formatAdvice(item)+"\n");
        if (result.partial) console.log("More advisories exist; this view reached its limit.");
        for (const line of formatPatternReport(patterns)) console.log(line);
      }
    }));
  const sessionWhat = new Command("what").description("Read what MEX gave or withheld this session")
 .option("--session <id>","Session identifier").option("--surfaces","Read surface efficacy and controls").option("--json","Print receipt titles and counts as JSON")
 .action(async opts=>run(opts.json,async()=>{
   const {what,whatLine,surfaces}=await import("./what.js");
   if (opts.surfaces) {
     const result=surfaces({projectPath:process.cwd()});
     if(opts.json)console.log(JSON.stringify({ok:true,...result}));
     else { if(result.contention) console.log(`Contention: ${JSON.stringify(result.contention)}`); for(const row of result.surfaces) {
       const live=row.live as {firings:number}, shadow=row.shadow as {firings:number};
       const percent=(value:unknown)=>typeof value==="number" ? `${(value*100).toFixed(1)}%` : "unsettled";
       console.log(`${row.surface}: ${live.firings} live, ${shadow.firings} shadow; acted ${percent(row.actedRate)}; base ${row.baseKind} ${percent(row.baseRate)}; gate ${row.gate}: ${row.reason}`);
       console.log(`  first ${JSON.stringify(row.first)}; repeat ${JSON.stringify(row.repeat)}; false-send estimate ${row.falseSendEstimate}`);
     }
     }
     return;
   }
   const result=what({projectPath:process.cwd()},opts.session);if(opts.json)console.log(JSON.stringify({ok:true,...result}));else {console.log(whatLine(result));for(const it of result.items)console.log(`${it.action} ${it.id} ${it.title}`);if(result.partial)console.log("More receipts exist; this view reached its work limit.");}
 }));
 const save = new Command("note")
    .alias("log")
    .description("Save a personal fact and its reason (log remains an alias for one release)")
    .argument("<text>", "A fact and its reason")
    .addOption(new Option("--kind <kind>", "Entry kind").choices([...ENTRY_KINDS]).default("rule"))
    .option("--scope <glob>", "Repository-relative scope (repeatable)", (value: string, previous: string[]) => [...previous, value], [])
    .option("--one-line <text>", "The complete claim in one line")
    .option("--decision", "Save it as a decision")
    .option("--commit <rev>", "The commit the decision records; it comes into force when that commit lands on the default branch")
    .option("--quote <text>", "With --commit: the line of the commit the decision rests on (kept only if found in the commit)")
    .option("--supersedes <id>", "With --decision: the earlier decision this one replaces (repeatable)", (value: string, previous: string[]) => [...previous, value], [])
    .option("--json", "Print the saved entry as JSON")
    .action(async (text, opts) => {
      await run(opts.json, async () => {
        const { note } = await import("./store.js");
        if ((opts.commit || opts.supersedes.length) && !opts.decision && opts.kind !== "decision") throw new KnowledgeError("INVALID_OPTION", "--commit and --supersedes go with --decision.");
        if (opts.quote && !opts.commit) throw new KnowledgeError("INVALID_OPTION", "--quote goes with --commit.");
        let commit, quoteNote = "";
        if (opts.commit) {
          const { commitFacts, runGit } = await import("./decisions.js");
          const git = runGit(process.cwd());
          const facts = commitFacts(git, opts.commit);
          if (!facts) throw new KnowledgeError("COMMIT_NOT_FOUND", `No commit ${opts.commit} in this repository.`);
          const { subject, ...rest } = facts;
          commit = { ...rest, ...(subject ? { subject } : {}) } as NonNullable<import("./entry.js").KnowledgeEntry["mex"]["commit"]>;
          if (opts.quote) {
            const { ground, RESTATED } = await import("./grounding.js");
            const source = [git(["log", "-1", "--format=%B", facts.sha]) ?? "", git(["show", "--format=", facts.sha]) ?? ""];
            const checked = ground(String(opts.quote).trim(), source, RESTATED);
            if (checked.kept) commit.quote = String(opts.quote).trim().replace(/\s+/gu, " ").slice(0, 512);
            else quoteNote = `\nThe quote wasn't found in ${facts.sha.slice(0, 7)} (confidence ${checked.confidence}), so it was left out.`;
          }
        }
        // Run inside an agent's shell, the note is the agent's record of what the person said:
        // labelled as the agent's, never "you said". (A typed `mex note:` goes through __hook-note.)
        const savedBy = process.env.CLAUDECODE?.trim() && process.env.CLAUDECODE.trim() !== "0" ? "claude-code" as const
          : process.env.CODEX_THREAD_ID?.trim() ? "codex" as const : undefined;
        const saved = note({ text, kind: opts.decision ? "decision" : opts.kind, scope: opts.scope.length ? opts.scope : undefined, oneLine: opts.oneLine, commit, supersedes: opts.supersedes, ...(savedBy ? { savedBy } : {}) }, { projectPath: process.cwd() });
        await queueRuleFiles();
        const forAgent = savedBy ? `\nTell the person it is saved for new sessions in every agent. \`mex forget ${saved.entry.mex.id}\` removes it; \`mex edit ${saved.entry.mex.id} "<text>"\` makes it their own words.` : "";
        if (opts.json) console.log(JSON.stringify({ ok: true, ...saved }));
        else console.log(`Saved personal note ${saved.entry.mex.id} ${saved.label}\n${saved.entry.mex.one_line}${commit ? `\nNot yet accepted: it comes into force when ${commit.sha.slice(0, 7)} lands on the default branch.` : ""}${quoteNote}${forAgent}`);
      });
    });
  const search = new Command("recall")
    .description("Search knowledge by words or read a learned entry by id")
    .argument("<words-or-id>", "Words to find or a learned entry id")
    .option("--limit <n>", "Maximum results, 1-100", "20")
    .option("--agent <name>", "Recipient agent; include hints from other agents only")
    .option("--json", "Print matching entries as JSON")
    .action(async (query, opts) => {
      await run(opts.json, async () => {
        const { recall } = await import("./store.js");
        const limit = Number(opts.limit);
        if (!/^[0-9]+$/u.test(opts.limit) || limit < 1 || limit > 100) {
          throw new KnowledgeError("INVALID_LIMIT", "Search limit must be between 1 and 100.");
        }
        const options = { projectPath: process.cwd(), consumerAgent: opts.agent };
        const { EntryIdSchema } = await import("./entry.js");
        if (EntryIdSchema.safeParse(query).success) {
          const { recallLearned, formatLearnedRecall, noteLearnedRecall } = await import("./recall-learned.js");
          const item = recallLearned(query, options);
          if (item) {
            if (opts.json) console.log(JSON.stringify({ ok: true, ...item }));
            else console.log(formatLearnedRecall(item));
            noteLearnedRecall(item, options);
            return;
          }
        }
        const result = recall(query, options, limit);
        if (opts.json) console.log(JSON.stringify({ ok: true, ...result }));
        else {
          if (!result.entries.length) console.log("No matching knowledge entries.");
          for (const item of result.entries) console.log(`${item.id} ${item.label}${item.branch && item.branch !== "default" ? ` [${item.branch === "branch" ? "not on default branch" : "default branch unverified"}]` : ""}${item.verdict === "changed" ? " [being checked: the code it names changed]" : ""}\n${item.one_line}\nmore: mex expand ${item.id}\n`);
          if (result.truncated) console.log("More notes matched; narrow the words or increase --limit.");
          if (result.stale) console.log(`${result.stale} matching ${result.stale === 1 ? "entry was" : "entries were"} left out: the code no longer matches ${result.stale === 1 ? "it" : "them"} (see mex check).`);
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
        const { entryVerdict, expand } = await import("./store.js");
        const options = { projectPath: process.cwd(), consumerAgent: opts.agent };
        const item = expand(id, options);
        const { describeLearnedRecall, formatLearnedRecall, noteLearnedRecall } = await import("./recall-learned.js");
        const learned = describeLearnedRecall(item, options);
        if (learned) {
          if (opts.json) console.log(JSON.stringify({ ok: true, ...learned }));
          else console.log(formatLearnedRecall(learned));
          noteLearnedRecall(learned, options);
          return;
        }
 const {noteProbe}=await import("./what.js");noteProbe(id,"opened",{projectPath:process.cwd()});
        // The truth gate: an agent never reads an entry the code no longer
        // matches; a person sees it with that status.
        const verdict = entryVerdict(id, options);
        const { isAgentCaller } = await import("../repo-start/caller.js");
        if (verdict === "broken" && (opts.agent || isAgentCaller())) {
          const message = `MEX withheld ${id}: the code no longer matches it. Read the current code instead; \`mex check\` shows which check fails.`;
          if (opts.json) console.log(JSON.stringify({ ok: true, id, withheld: true, verdict, message }));
          else console.log(message);
          return;
        }
        const status = verdict === "broken" ? " [withheld from agents: the code no longer matches it]"
          : verdict === "changed" ? " [being checked: the code it names changed]" : "";
        if (opts.json) console.log(JSON.stringify({ ok: true, ...item, ...(verdict ? { verdict } : {}) }));
        else {
          const { serializeEntry } = await import("./entry.js");
          console.log(`${item.label}${item.entry.mex.status === "proposed" ? " [not yet accepted]" : ""}${item.level === "team" && item.branch !== "default" ? " [not verified on default branch]" : ""}${status}\n${serializeEntry(item.entry)}`);
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
    .description(action === "wrong" ? "Report or retire an incorrect note" : "Hide a note permanently, keeping a local tombstone")
    .argument("<id>", "Stable entry id")
    // `mex forget <id>` is what MEX tells people after an agent saves a note,
    // so forget's reason is optional; wrong keeps it, since the reason is the point.
    .argument(action === "wrong" ? "<reason>" : "[reason]", action === "wrong" ? "What is wrong with this entry" : "Why this entry should no longer be used (optional)")
    .option("--apply", "Apply the reviewed team-entry retirement")
    .option("--expect <revision>", "The exact revision printed by the team preview")
    .option("--json", "Print the retirement record as JSON")
    .option("--all-along", "With wrong: explicitly confirm that every past use is suspect")
    .action(async (id, given: string | undefined, opts) => {
      const reason = given?.trim() ? given : "Removed with mex forget";
      await run(opts.json, async () => {
        if (opts.allAlong && action !== "wrong") throw new KnowledgeError("INVALID_ENTRY", "--all-along is only valid with mex wrong.");
        const options = { projectPath: process.cwd() };
        if (action === "wrong") {
          const { isAgentCaller } = await import("../repo-start/caller.js");
          const { parseWrongReason, reportWrong } = await import("./agent-report.js");
          const { knowledgeProject } = await import("./context.js");
          const agent = isAgentCaller();
          const parsed = parseWrongReason(reason, knowledgeProject(options).root, agent);
          if (agent) {
            const job = await reportWrong(id, parsed, options);
            if (opts.json) console.log(JSON.stringify({ ok: true, id, status: "proposed", reason: parsed.reason, kind: parsed.kind, job }));
            else console.log("MEX will re-check this rule; nothing was retired.");
            (await import("../record/background.js")).ensureBackground();
            return;
          }
        }
        const { forget, wrong } = await import("./mutations.js");
        const { expand } = await import("./store.js");
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
      const covered = plan.coverage.filter(item => item.sources.length).length;
      if (covered) lines.push(`Source IDs, hashes, and links for ${covered} selected ${covered === 1 ? "entry go" : "entries go"} in .mex/sources.json. Use --json to review them.`);
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
  const aids = (["alias", "ask"] as const).map(kind => new Command(kind)
    .description(kind === "alias"
      ? "Add or remove a short name or symptom people use for an entry (kept only if it finds that entry first)"
      : "Add or remove an example request that should find an entry (kept only if it finds that entry first)")
    .argument("<id>", "Stable entry id")
    .addArgument(new Argument("<action>", "add or remove").choices(["add", "remove"]))
    .argument("<text>", kind === "alias" ? "The alias, at most 40 characters" : "The example request, at most 120 characters")
    .option("--apply", "Apply the reviewed team-entry change")
    .option("--expect <revision>", "The exact revision printed by the team preview")
    .option("--json", "Print the result as JSON")
    .action(async (id, action, text, opts) => run(opts.json, async () => {
      const { changeAid } = await import("./aid-store.js");
      const options = { projectPath: process.cwd() };
      if (opts.apply && !opts.expect) throw new KnowledgeError("PREVIEW_REQUIRED", "Preview the team change, then pass --apply --expect <revision>.");
      const result = changeAid({ id, kind, op: action, text }, options, opts.apply ? { expect: opts.expect } : undefined);
      if (result.verdict && !result.verdict.kept) {
        if (opts.json) console.log(JSON.stringify({ ok: true, kept: false, verdict: result.verdict }));
        else console.log(`Not kept: ${result.verdict.reason}.`);
        return;
      }
      if (result.level === "team" && !result.changed && result.preview) { printPreview(result.preview, opts.json); return; }
      if (result.level === "personal") await queueRuleFiles();
      if (opts.json) console.log(JSON.stringify({ ok: true, kept: true, level: result.level, id, aliases: result.entry.mex.aliases ?? [], asks: result.entry.mex.asks ?? [], ...(result.verdict ? { verdict: result.verdict } : {}) }));
      else console.log(`${action === "add" ? "Kept" : "Removed"} ${kind} on ${id}${result.verdict?.margin !== undefined ? ` (leads the next entry by ${Math.round(result.verdict.margin * 100)}%)` : ""}.`);
    })));
  const entries = new Command("entries").description("Work on all of this project's entries");
  entries.command("enrich")
    .description("Backfill aliases and asks with one AI call (opt-in): shows the plan, --run makes the call and previews, --apply writes")
    .option("--run", "Make the one batched AI call and save a filtered preview; writes no entry")
    .option("--apply", "Write the saved preview")
    .option("--expect <revision>", "The revision printed by --run")
    .addOption(new Option("--agent <agent>", "Agent CLI that makes the call").choices(["claude", "codex"]).default("claude"))
    .option("--json", "Print the result as JSON")
    .action(async opts => run(opts.json, async () => {
      const enrich = await import("./enrich.js");
      const options = { projectPath: process.cwd() };
      const print = (value: object, text: string) => console.log(opts.json ? JSON.stringify({ ok: true, ...value }) : text);
      if (opts.apply) {
        if (!opts.expect) throw new KnowledgeError("PREVIEW_REQUIRED", "Pass the revision --run printed: mex entries enrich --apply --expect <revision>.");
        const done = enrich.applyEnrich(options, opts.expect);
        print(done, `Wrote aliases and asks on ${done.written.length} entries.${done.stale.length ? ` ${done.stale.length} changed since the preview and were skipped: ${done.stale.join(", ")}` : ""}`);
        return;
      }
      if (!opts.run) {
        const plan = enrich.planEnrich(options);
        print(plan, plan.entries.length
          ? `One AI call would write aliases and asks for ${plan.entries.length} entries${plan.remaining ? ` (${plan.remaining} more need another run)` : ""}, estimated at about ${plan.estimate.input} input and ${plan.estimate.output} output tokens. It runs inside MEX's model cap. Run it with: mex entries enrich --run`
          : "Every entry already has aliases or asks.");
        return;
      }
      const { runModel } = await import("../model-runner/index.js");
      const preview = await enrich.runEnrich(options, async (prompt, estimate) => (await runModel({
        agent: opts.agent, role: "cheap", prompt, projectRoot: process.cwd(), purpose: "knowledge.enrich",
        automatic: { estimate: { input: estimate.input, cache_write: 0, cache_read: 0, output: estimate.output } },
      })).text);
      const dropped = preview.verdicts.filter(v => !v.kept);
      if (opts.json) { print(preview, ""); return; }
      const lines = [`Kept ${preview.verdicts.length - dropped.length} of ${preview.verdicts.length} suggestions, on ${preview.changes.length} entries:`];
      for (const c of preview.changes) lines.push(`  ${c.id}  aliases: ${c.aliases.join("; ") || "none"}  asks: ${c.asks.join("; ") || "none"}`);
      if (dropped.length) { lines.push("", "Dropped:"); for (const v of dropped.slice(0, 30)) lines.push(`  ${v.entry}  ${v.kind} "${v.text}": ${v.reason}`); }
      lines.push("", `To write exactly this: mex entries enrich --apply --expect ${preview.revision}`);
      console.log(lines.join("\n"));
    }));
  const decisions = new Command("decisions")
    .description("Check which decisions that cite a commit are in force: proposed until the commit lands on the default branch, withdrawn on a revert")
    .option("--json", "Print every decision and its event log as JSON")
    .action(async opts => run(opts.json, async () => {
      const { acceptDecisions } = await import("./decisions.js");
      const rows = acceptDecisions({ projectPath: process.cwd() });
      if (opts.json) { console.log(JSON.stringify({ ok: true, decisions: rows })); return; }
      if (!rows.length) { console.log("No decisions cite a commit here."); return; }
      const label = { proposed: "not yet accepted", accepted: "in force", withdrawn: "withdrawn" } as const;
      for (const r of rows) {
        const last = r.events.at(-1);
        console.log(`${r.id} [${label[r.state]}] ${r.one_line}\n  cites ${r.commit.slice(0, 7)}${last ? `; ${last.event} ${last.at.slice(0, 10)} via ${last.matched_by}${last.landed_sha ? ` (${last.landed_sha.slice(0, 7)})` : ""}` : ""}`);
      }
    }));
  return [adviceReport, sessionWhat, save, search, full, change, ...retire, ...aids, entries, decisions, hints, rules, share, brief, buildReviewCommand()];
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

/** Personal note changes reach the hidden local rule files at once, even with a session open. */
async function queueRuleFiles(): Promise<void> {
  const { queueNativeRebuild } = await import("./native-queue.js");
  queueNativeRebuild(process.cwd(), { local: true });
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
