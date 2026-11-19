import { expect, it } from "vitest";
import { program } from "../src/cli.js";
import { PUBLIC_COMMAND_ORDER } from "../src/cli-tools.js";
import { REMOVED_COMMANDS } from "../src/removed-commands.js";

it("shows the 0.9 manual in command order", () => {
  program.configureHelp({ ...program.configureHelp(), helpWidth: 80 });
  expect(program.helpInformation()).toMatchSnapshot();
  expect(program.createHelp().visibleCommands(program).map(command => command.name()).filter(name => name !== "help")).toEqual([...PUBLIC_COMMAND_ORDER]);
});

it("keeps compatibility commands runnable but out of top-level help", () => {
  const help = program.helpInformation();
  for (const name of ["wiki", "graph", "impact", "index", "member", "activity", "relay", "capabilities", "completion"]) {
    expect(program.commands.some(command => command.name() === name)).toBe(true);
    expect(help).not.toMatch(new RegExp(`^  ${name}(?:\\s|\\[|<|$)`, "mu"));
  }
  const setup = program.commands.find(command => command.name() === "setup")!;
  expect(setup.description()).toBe("Turn MEX on for this repo (the same as `mex`)");
  for (const flag of ["--legacy", "--cli", "--browser", "--mode", "--dry-run", "--port", "--no-open", "--tool", "--yes", "--force"]) expect(setup.options.find(option => option.long === flag)?.hidden).toBe(true);
});

it("names a replacement for each removed command", () => {
  for (const message of Object.values(REMOVED_COMMANDS)) expect(message).toMatch(/;.*(?:mex |no replacement in 0\.9)/u);
  expect(REMOVED_COMMANDS.tui).toContain("mex status");
});
