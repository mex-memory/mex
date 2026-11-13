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
          for (const item of result.entries) console.log(`${item.id} ${item.label}\n${item.one_line}\nmore: mex expand ${item.id}\n`);
          if (result.truncated) console.log("More notes matched; narrow the words or increase --limit.");
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
          console.log(`${item.label}\n${serializeEntry(item.entry)}`);
        }
      });
    });
  return [save, search, full];
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
