import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { Command, InvalidArgumentError } from "commander";
import { runLog, runTimeline } from "../src/events.js";
import type { MexConfig } from "../src/types.js";

vi.mock("../src/events.js", () => ({
  runLog: vi.fn(),
  runTimeline: vi.fn(),
}));

let parseIntArg: typeof import("../src/cli.js").parseIntArg;
let parsePositiveIntArg: typeof import("../src/cli.js").parsePositiveIntArg;

const config: MexConfig = {
  projectRoot: process.cwd(),
  scaffoldRoot: `${process.cwd()}/.mex`,
  aiTools: [],
};

beforeAll(async () => {
  const originalArgv = process.argv;
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  process.argv = ["node", "mex", "completion", "bash"];
  try {
    ({ parseIntArg, parsePositiveIntArg } = await import("../src/cli.js"));
  } finally {
    process.argv = originalArgv;
    logSpy.mockRestore();
  }
});

beforeEach(() => {
  vi.mocked(runLog).mockResolvedValue(undefined);
  vi.mocked(runTimeline).mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function buildProgram(): Command {
  const program = new Command();
  program
    .name("mex")
    .exitOverride()
    .configureOutput({
      writeOut: () => {},
      writeErr: () => {},
    });

  program
    .command("log <message>")
    .description("Append a decision, note, risk, or todo to the mex event log")
    .option("--type <type>", "Event type: decision, note, risk, todo", "note")
    .option("--file <path>", "Related file path (repeatable)", (value, prev: string[]) => [...prev, value], [])
    .action(async (message, opts) => {
      try {
        const { runLog } = await import("../src/events.js");
        await runLog(config, message, { kind: opts.type, files: opts.file });
      } catch (err) {
        console.error((err as Error).message);
        process.exit(1);
      }
    });

  program
    .command("timeline")
    .description("Show recent mex event log entries")
    .option("--json", "Output events as JSON")
    .option("--since <date>", "Filter from YYYY-MM-DD or relative Nd, e.g. 30d")
    .option("--type <type>", "Filter by event type")
    .option("--limit <n>", "Maximum number of entries", parsePositiveIntArg)
    .action(async (opts) => {
      try {
        const { runTimeline } = await import("../src/events.js");
        await runTimeline(config, opts);
      } catch (err) {
        console.error((err as Error).message);
        process.exit(1);
      }
    });

  return program;
}

describe("CLI argument parsers", () => {
  it("parses non-negative integers", () => {
    expect(parseIntArg("0")).toBe(0);
    expect(parseIntArg("12")).toBe(12);
  });

  it("parses positive integers", () => {
    expect(parsePositiveIntArg("1")).toBe(1);
    expect(parsePositiveIntArg("12")).toBe(12);
  });

  it("rejects non-positive and non-numeric values for positive integers", () => {
    for (const value of ["0", "-1", "foo"]) {
      expect(() => parsePositiveIntArg(value)).toThrow(InvalidArgumentError);
    }
  });
});

describe("mex log parsing", () => {
  it("passes the default type through as note", async () => {
    const program = buildProgram();
    await program.parseAsync(["node", "mex", "log", "captured context"]);

    expect(runLog).toHaveBeenCalledWith(config, "captured context", {
      kind: "note",
      files: [],
    });
  });

  it("preserves repeated --file values", async () => {
    const program = buildProgram();
    await program.parseAsync([
      "node",
      "mex",
      "log",
      "tracked files",
      "--file",
      "src/cli.ts",
      "--file",
      "test/cli.test.ts",
      "--file",
      "README.md",
    ]);

    expect(runLog).toHaveBeenCalledWith(config, "tracked files", {
      kind: "note",
      files: ["src/cli.ts", "test/cli.test.ts", "README.md"],
    });
  });

  it("passes --type decision through as kind", async () => {
    const program = buildProgram();
    await program.parseAsync(["node", "mex", "log", "choose commander", "--type", "decision"]);

    expect(runLog).toHaveBeenCalledWith(config, "choose commander", {
      kind: "decision",
      files: [],
    });
  });

  it("reports invalid --type failures from the log handler", async () => {
    vi.mocked(runLog).mockRejectedValueOnce(
      new Error('Unknown event type "invalid". Use decision, note, risk, or todo.'),
    );
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
      throw new Error(`process.exit ${code}`);
    }) as typeof process.exit);
    const program = buildProgram();

    await expect(
      program.parseAsync(["node", "mex", "log", "bad type", "--type", "invalid"]),
    ).rejects.toThrow("process.exit 1");

    expect(runLog).toHaveBeenCalledWith(config, "bad type", {
      kind: "invalid",
      files: [],
    });
    expect(errorSpy).toHaveBeenCalledWith('Unknown event type "invalid". Use decision, note, risk, or todo.');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe("mex timeline parsing", () => {
  it("parses --limit as an integer", async () => {
    const program = buildProgram();
    await program.parseAsync(["node", "mex", "timeline", "--limit", "5"]);

    expect(runTimeline).toHaveBeenCalledWith(config, { limit: 5 });
  });

  it("rejects invalid --limit values", async () => {
    for (const value of ["0", "foo"]) {
      const program = buildProgram();
      await expect(program.parseAsync(["node", "mex", "timeline", "--limit", value])).rejects.toMatchObject({
        code: "commander.invalidArgument",
        message: expect.stringContaining(`argument '${value}' is invalid`),
      });
    }
  });

  it("passes --json, --since, and --type through to the timeline handler", async () => {
    const program = buildProgram();
    await program.parseAsync([
      "node",
      "mex",
      "timeline",
      "--json",
      "--since",
      "30d",
      "--type",
      "risk",
    ]);

    expect(runTimeline).toHaveBeenCalledWith(config, {
      json: true,
      since: "30d",
      type: "risk",
    });
  });
});
