import { Command } from "commander";

/** Compatibility pointers only; these commands never load project state. */
export const REMOVED_COMMANDS: Readonly<Record<string, string>> = {
  inbox: "mex inbox was removed in 0.9; save a note with mex note, or share notes with mex share.",
  workstream: "mex workstream was removed in 0.9; use mex handoff for branch context.",
  spec: "mex spec was removed in 0.9; no replacement in 0.9.",
  tui: "mex tui was removed in 0.9; use mex status.",
  watch: "mex watch was removed in 0.9; MEX now runs from your agent's hooks, see mex status.",
  heartbeat: "mex heartbeat was removed in 0.9; use mex doctor.",
  logging: "mex logging was removed in 0.9; save a note with mex note.",
  timeline: "mex timeline was removed in 0.9; use mex recall <words>.",
  pattern: "mex pattern was removed in 0.9; save a rule with mex note.",
  init: "mex init was removed in 0.9; run mex in a repo.",
  export: "mex export was removed in 0.9; share notes through git with mex share.",
  commands: "mex commands was removed in 0.9; use mex --help.",
  skills: "mex skills sync was removed in 0.9; no replacement in 0.9. mex install manages agent hooks.",
};

export function removedCommandMessage(argv: readonly string[]): string | null {
  const name = argv[0] === "help" ? argv[1] : argv[0];
  return Object.hasOwn(REMOVED_COMMANDS, name ?? "")
    ? REMOVED_COMMANDS[name!]!
    : null;
}

export function registerRemovedCommands(program: Command): void {
  for (const [name, message] of Object.entries(REMOVED_COMMANDS)) {
    program.addCommand(new Command(name)
      .argument("[args...]")
      .allowUnknownOption()
      .allowExcessArguments()
      .helpOption(false)
      .action(() => {
        console.error(message);
        process.exitCode = 1;
      }), { hidden: true });
  }
}
