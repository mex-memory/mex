import { Command, Option } from "commander";
import { ENTRY_KINDS, KnowledgeError } from "./contract.js";

export function buildKnowledgeCommands(): Command[] {
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
        if (opts.json) console.log(JSON.stringify({ ok: true, ...saved }));
        else console.log(`Saved personal note ${saved.entry.mex.id} ${saved.label}\n${saved.entry.mex.one_line}`);
      });
    });
  const search = new Command("recall")
    .description("Search personal knowledge by words, without AI")
    .argument("<words>", "Words to find")
    .option("--limit <n>", "Maximum results, 1-100", "20")
    .option("--json", "Print matching entries as JSON")
    .action(async (query, opts) => {
      await run(opts.json, async () => {
        const { recall } = await import("./store.js");
        if (!/^[0-9]+$/u.test(opts.limit)) throw new KnowledgeError("INVALID_LIMIT", "Search limit must be between 1 and 100.");
        const result = recall(query, { projectPath: process.cwd() }, Number(opts.limit));
        if (opts.json) console.log(JSON.stringify({ ok: true, ...result }));
        else {
          if (!result.entries.length) console.log("No matching personal notes.");
          for (const item of result.entries) console.log(`${item.id} ${item.label}${item.branch && item.branch !== "default" ? ` [${item.branch === "branch" ? "not on default branch" : "default branch unverified"}]` : ""}\n${item.one_line}\nmore: mex expand ${item.id}\n`);
          if (result.truncated) console.log("More notes matched; narrow the words or increase --limit.");
          if (result.withheld) console.log(`${result.withheld} entries withheld by storage checks.`);
        }
      });
    });
  const full = new Command("expand")
    .description("Read a personal entry and its source and checks")
    .argument("<id>", "Stable entry id")
    .option("--json", "Print the full entry as JSON")
    .action(async (id, opts) => {
      await run(opts.json, async () => {
        const { expand } = await import("./store.js");
        const item = expand(id, { projectPath: process.cwd() });
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
        const current = expand(id, options);
        const input = { text, kind: opts.kind, scope: opts.scope.length ? opts.scope : undefined, oneLine: opts.oneLine };
        if (current.level === "team") {
          const { prepareTeamWrite, applyTeamWrite } = await import("./team.js");
          const preview = prepareTeamWrite(editedEntry(current.entry, input, new Date()), options, text);
          if (!opts.apply) { printPreview(preview, opts.json); return; }
          if (!opts.expect) throw new KnowledgeError("PREVIEW_REQUIRED", "Preview the team change, then pass --apply --expect <revision>.");
          const saved = applyTeamWrite(preview, opts.expect, options, text);
          if (opts.json) console.log(JSON.stringify({ ok: true, ...saved }));
          else console.log(`Updated team entry ${id}`);
          return;
        }
        const saved = edit(id, input, options);
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
    .action(async (id, reason, opts) => {
      await run(opts.json, async () => {
        const { forget, wrong } = await import("./mutations.js");
        const { expand } = await import("./store.js");
        const options = { projectPath: process.cwd() };
        let current;
        try { current = expand(id, options); }
        catch (error) { if (!(error instanceof KnowledgeError) || error.code !== "SECRET_FOUND") throw error; }
        if (current?.level === "team") {
          const { prepareTeamWrite, applyTeamWrite } = await import("./team.js");
          const retired = { reason, by: `mex ${action}`, at: new Date().toISOString().slice(0, 10) };
          const preview = prepareTeamWrite({ ...current.entry, mex: { ...current.entry.mex, status: "retired", retired } }, options);
          if (!opts.apply) { printPreview(preview, opts.json); return; }
          if (!opts.expect) throw new KnowledgeError("PREVIEW_REQUIRED", "Preview the team change, then pass --apply --expect <revision>.");
          applyTeamWrite(preview, opts.expect, options);
          if (opts.json) console.log(JSON.stringify({ ok: true, id, level: "team", status: "retired", retired }));
          else console.log(`Retired team entry ${id}: ${reason}`);
          return;
        }
        const marker = (action === "wrong" ? wrong : forget)(id, reason, { projectPath: process.cwd() });
        if (opts.json) console.log(JSON.stringify({ ok: true, level: "personal", status: "retired", ...marker }));
        else console.log(`Retired personal note ${id}: ${marker.retired.reason}`);
      });
    }));
  return [save, search, full, change, ...retire];
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
    const message = known ? error.message : "Personal note storage could not be read or written.";
    if (json) console.log(JSON.stringify({ ok: false, error: { code, message } }));
    else console.error(message);
    process.exitCode = 1;
  }
}
