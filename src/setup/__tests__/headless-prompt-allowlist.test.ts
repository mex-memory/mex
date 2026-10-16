import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import {
  HEADLESS_CLAUDE_ALLOWED_TOOLS,
  HEADLESS_CLAUDE_MEX_COMMANDS,
  buildAgentCommand,
  isHeadlessClaudeMexCommandAllowed,
} from "../../agent-command.js";
import { program } from "../../cli.js";
import {
  buildAgentMemoryPrompt,
  buildExistingNoBriefPrompt,
  buildExistingWithBriefPrompt,
  buildFreshPrompt,
} from "../prompts.js";

/** Every prompt `buildSetupPopulationPrompt` can hand to the headless population agent. */
const HEADLESS_PROMPTS: ReadonlyArray<readonly [string, () => string]> = [
  ["fresh", buildFreshPrompt],
  ["existing with brief", () => buildExistingWithBriefPrompt("{}")],
  ["existing without brief", buildExistingNoBriefPrompt],
  ["agent memory", buildAgentMemoryPrompt],
];

/**
 * The `mex <command> [<subcommand>]` invocations a prompt names, resolved against
 * the real command tree so prose such as "a mex scaffold" or "mex://" is ignored.
 */
function namedMexCommands(prompt: string): string[] {
  const found = new Set<string>();
  for (const match of prompt.matchAll(/\bmex\s+([a-z][a-z-]*)(?:\s+([a-z][a-z-]*))?/g)) {
    const top = program.commands.find((command) => command.name() === match[1]);
    if (top === undefined) continue;
    const sub = match[2] === undefined ? undefined : top.commands.find((command) => command.name() === match[2]);
    found.add(sub === undefined ? `mex ${top.name()}` : `mex ${top.name()} ${sub.name()}`);
  }
  return [...found].sort();
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "__tests__" ? [] : sourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

describe("headless Claude allowlist against the prompts it serves", () => {
  it.each(HEADLESS_PROMPTS)("permits every mex command the %s prompt tells the agent to run", (_name, build) => {
    for (const command of namedMexCommands(build())) {
      expect(isHeadlessClaudeMexCommandAllowed(command), `${command} is named by the prompt but denied headless`).toBe(true);
    }
  });

  it("does not let the cross-check pass vacuously", () => {
    const named = new Set(HEADLESS_PROMPTS.flatMap(([, build]) => namedMexCommands(build())));
    expect([...named]).toEqual(expect.arrayContaining([
      "mex graph scope", "mex graph get", "mex graph query", "mex impact", "mex wiki apply", "mex wiki link-sections",
    ]));
    expect(namedMexCommands("run `mex wiki apply op.json --apply`, then mex setup")).toEqual(["mex setup", "mex wiki apply"]);
    expect(namedMexCommands("a mex scaffold at mex://node")).toEqual([]);
  });

  it("names a prompt command that would be denied, so the check can fail", () => {
    expect(isHeadlessClaudeMexCommandAllowed("mex wiki reground")).toBe(false);
    expect(isHeadlessClaudeMexCommandAllowed("mex graph rebuild")).toBe(false);
    expect(isHeadlessClaudeMexCommandAllowed("mex wiki")).toBe(false);
    expect(isHeadlessClaudeMexCommandAllowed("mex wiki applyx")).toBe(false);
  });

  it("allows only commands that exist, as narrow prefixes", () => {
    for (const command of HEADLESS_CLAUDE_MEX_COMMANDS) {
      const [, top, sub] = command.split(" ");
      const topCommand = program.commands.find((candidate) => candidate.name() === top);
      expect(topCommand, `${command} is not a mex command`).toBeDefined();
      if (sub !== undefined) expect(topCommand!.commands.map((candidate) => candidate.name())).toContain(sub);
    }
    for (const shell of ["Bash", "PowerShell"]) {
      for (const command of HEADLESS_CLAUDE_MEX_COMMANDS) expect(HEADLESS_CLAUDE_ALLOWED_TOOLS).toContain(`${shell}(${command}:*)`);
    }
    expect(HEADLESS_CLAUDE_ALLOWED_TOOLS.join(",")).not.toMatch(/mex:\*|\(mex \*\)/);
    expect(buildAgentCommand("claude", "p", "headless")!.args).toContain(HEADLESS_CLAUDE_ALLOWED_TOOLS.join(","));
  });

  it("is told about any new caller of headless mode, whose prompts this test must then cover", () => {
    const root = join(__dirname, "..", "..");
    const callers = sourceFiles(root)
      .filter((file) => !file.endsWith("agent-command.ts"))
      .filter((file) => /buildAgentCommand\([^)]*"headless"/s.test(readFileSync(file, "utf8")))
      .map((file) => relative(root, file).replace(/\\/g, "/"));
    expect(callers).toEqual(["setup/headless-population.ts"]);
  });
});
