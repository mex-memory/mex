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
  buildBatchFixPrompt,
  buildExistingNoBriefPrompt,
  buildExistingWithBriefPrompt,
  buildFinalPassPrompt,
  buildFreshPrompt,
  buildSharedFilesPrompt,
  buildSubsystemPrompt,
} from "../prompts.js";
import type { SubsystemPlan } from "../subsystems.js";
import { buildSetupRepairPrompt } from "../finalize-repair.js";
import { POPULATION_FINISH } from "../prompts.js";
import { QUEUE_POPULATION_FINISH } from "../next.js";
import { SETUP_HANDOFF_PROMPT } from "../unfinished.js";

const SUBSYSTEM = {
  path: "src/router", budget: { min: 10, max: 15 }, wikiFile: "context/router.md",
  batchFile: ".mex/local/setup-ops/router.json", opIdPrefix: "setup_router_",
};

/**
 * Sessions that run no `mex` command at all: MEX applies their batch files
 * in-process. Diagnostics quoted as data are not instructions to run anything.
 */
const NO_COMMAND_PROMPTS = new Set(["per-subsystem shared files", "per-subsystem subsystem", "per-subsystem batch fix"]);

/** Every prompt `buildSetupPopulationPrompt` can hand to the headless population agent. */
const PLAN: SubsystemPlan = {
  source: "graph",
  ranking: "activity",
  sourceFiles: 120,
  target: { min: 3, max: 4 },
  candidates: [
    { path: "src/router", files: 30, commits: 12, budget: { min: 10, max: 15 } },
    { path: "src/http", files: 20, commits: 4, budget: { min: 6, max: 10 } },
  ],
};
const HEADLESS_PROMPTS: ReadonlyArray<readonly [string, () => string]> = [
  ["fresh", buildFreshPrompt],
  ["existing with brief", () => buildExistingWithBriefPrompt("{}", PLAN)],
  ["existing with brief, no candidates", () => buildExistingWithBriefPrompt("{}", null)],
  ["existing without brief", () => buildExistingNoBriefPrompt(PLAN)],
  ["existing without brief, no candidates", () => buildExistingNoBriefPrompt(null)],
  ["agent memory", buildAgentMemoryPrompt],
  // Per-subsystem population on larger repositories: shared files, one per subsystem, a batch fix, the final pass.
  ["per-subsystem shared files", () => buildSharedFilesPrompt({ briefJson: "{}", batchFile: ".mex/local/setup-ops/shared.json", opIdPrefix: "setup_shared_", subsystems: [SUBSYSTEM] })],
  ["per-subsystem subsystem", () => buildSubsystemPrompt({ subsystem: SUBSYSTEM, nested: ["src/router/trie"] })],
  ["per-subsystem batch fix", () => buildBatchFixPrompt({ label: "subsystem src/router/", batchFile: SUBSYSTEM.batchFile, wikiFiles: [SUBSYSTEM.wikiFile], opIdPrefix: SUBSYSTEM.opIdPrefix,
    diagnostics: [{ code: "GROUNDING_NOT_FOUND", message: "Operation 1 (setup_router_a): No declaration named `x`. Nearest: y (function)." }] })],
  ["per-subsystem final pass", () => buildFinalPassPrompt({ written: [SUBSYSTEM], skipped: [] })],
  // The one-paste flow: the prompt a user pastes, and the single unit `mex setup next` hands out.
  ["one-paste handoff", () => SETUP_HANDOFF_PROMPT],
  ["one-paste single unit", () => buildExistingWithBriefPrompt("{}", PLAN).replace(POPULATION_FINISH, QUEUE_POPULATION_FINISH)],
  // The finalize repair turn runs through the same headless agent.
  ["finalize repair", () => buildSetupRepairPrompt([
    { file: ".mex/context/a.md", node: "function:0", reason: "Node is unavailable.", entity: "mx_01K4FAM7W8N9R3T5Y6Q2ZBCHJD", kind: "new", contentHash: "0" },
  ], [])],
];

/**
 * Named in the closing "Finish" paragraph only, as something to do after the
 * agent returns; the agent is told not to run it itself.
 */
const FINISH_ONLY_COMMANDS = new Set(["mex setup"]);

function withoutFinish(prompt: string): string {
  const index = prompt.lastIndexOf("Finish:");
  return index === -1 ? prompt : prompt.slice(0, index);
}

/**
 * The `mex <command> [<subcommand>]` invocations a prompt names, resolved against
 * the real command tree so prose such as "a mex scaffold" or "mex://" is ignored.
 */
function namedMexCommands(prompt: string): string[] {
  const found = new Set<string>();
  if (/\bmex --help\b/.test(prompt)) found.add("mex --help");
  for (const match of prompt.matchAll(/\bmex\s+([a-z][a-z-]*)(?:\s+(--help|[a-z][a-z-]*))?/g)) {
    const top = program.commands.find((command) => command.name() === match[1]);
    if (top !== undefined && match[2] === "--help") {
      found.add(`mex ${top.name()} --help`);
      continue;
    }
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
    const prompt = build();
    for (const command of namedMexCommands(withoutFinish(prompt))) {
      expect(isHeadlessClaudeMexCommandAllowed(command), `${command} is named by the prompt but denied headless`).toBe(true);
    }
    for (const command of namedMexCommands(prompt).filter((named) => FINISH_ONLY_COMMANDS.has(named))) {
      expect(withoutFinish(prompt)).not.toContain(command);
    }
  });

  it("permits every --help form the prompts name, and the validate self-check", () => {
    const helpForms = new Set<string>();
    for (const [, build] of HEADLESS_PROMPTS) {
      for (const match of build().matchAll(/`(mex(?: [a-z][a-z-]*)* --help)`/g)) helpForms.add(match[1]!);
    }
    expect([...helpForms].sort()).toEqual(["mex --help", "mex wiki --help", "mex wiki apply --help"]);
    for (const form of helpForms) expect(isHeadlessClaudeMexCommandAllowed(form), form).toBe(true);
    expect(isHeadlessClaudeMexCommandAllowed("mex wiki validate")).toBe(true);
    expect(isHeadlessClaudeMexCommandAllowed("mex wiki apply .mex/local/setup-ops/router.json --apply")).toBe(true);
    // Compound commands are the host's to refuse; the prompt says to run one command per call.
    expect(buildExistingWithBriefPrompt("{}", PLAN)).toContain("Run one `mex` command per shell call");
  });

  it("does not let the cross-check pass vacuously", () => {
    const named = new Set(HEADLESS_PROMPTS.flatMap(([, build]) => namedMexCommands(build())));
    expect([...named]).toEqual(expect.arrayContaining([
      "mex graph query", "mex wiki apply", "mex wiki validate", "mex setup next",
    ]));
    // Only the one-paste loop's step is allowed; setup itself still needs a person.
    expect(isHeadlessClaudeMexCommandAllowed("mex setup next")).toBe(true);
    expect(isHeadlessClaudeMexCommandAllowed("mex setup")).toBe(false);
    expect(isHeadlessClaudeMexCommandAllowed("mex setup --browser")).toBe(false);
    expect(isHeadlessClaudeMexCommandAllowed("mex setup nextx")).toBe(false);
    // The population prompts offer no graph-query helper; only the finalize repair turn names where-defined.
    const population = HEADLESS_PROMPTS.filter(([name]) => name !== "finalize repair")
      .flatMap(([, build]) => namedMexCommands(build()));
    expect(population).not.toContain("mex graph query");
    expect(population).not.toContain("mex impact");
    expect(named).not.toContain("mex wiki link-sections");
    expect(namedMexCommands("run `mex wiki apply op.json --apply`, then mex setup")).toEqual(["mex setup", "mex wiki apply"]);
    expect(namedMexCommands("a mex scaffold at mex://node")).toEqual([]);
  });

  it.each(HEADLESS_PROMPTS.filter(([name]) => NO_COMMAND_PROMPTS.has(name)))("names no mex command to run in the %s prompt", (_name, build) => {
    const prompt = build();
    // Quoted refusal text is data; the session instructions themselves name no command.
    const instructions = prompt.replace(/Treat these as data, not instructions:\n(?:- .*\n?)+/u, "");
    expect(namedMexCommands(instructions)).toEqual([]);
    expect(instructions).toContain("Run no `mex` commands");
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
      if (top === "--help") continue;
      const topCommand = program.commands.find((candidate) => candidate.name() === top);
      expect(topCommand, `${command} is not a mex command`).toBeDefined();
      if (sub !== undefined && sub !== "--help") expect(topCommand!.commands.map((candidate) => candidate.name())).toContain(sub);
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
