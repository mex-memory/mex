import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { InvalidArgumentError } from "commander";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { parseIntArg, parsePositiveIntArg, program } from "../src/cli.js";
import * as events from "../src/events.js";
import * as configMod from "../src/config.js";
import type { MexConfig } from "../src/types.js";

// ── parser helpers ────────────────────────────────────────────────────────────

describe("parseIntArg", () => {
  it("accepts a non-negative integer", () => {
    expect(parseIntArg("0")).toBe(0);
    expect(parseIntArg("42")).toBe(42);
  });

  it("throws InvalidArgumentError on non-numeric input", () => {
    expect(() => parseIntArg("abc")).toThrow(InvalidArgumentError);
  });

  it("throws InvalidArgumentError on negative input", () => {
    expect(() => parseIntArg("-3")).toThrow(InvalidArgumentError);
  });
});

describe("parsePositiveIntArg", () => {
  it("accepts a positive integer", () => {
    expect(parsePositiveIntArg("1")).toBe(1);
    expect(parsePositiveIntArg("99")).toBe(99);
  });

  it("rejects zero", () => {
    expect(() => parsePositiveIntArg("0")).toThrow(InvalidArgumentError);
  });

  it("rejects negative integers", () => {
    expect(() => parsePositiveIntArg("-1")).toThrow(InvalidArgumentError);
  });

  it("rejects non-numeric input", () => {
    expect(() => parsePositiveIntArg("five")).toThrow(InvalidArgumentError);
  });
});

// ── commander wiring (mex log, mex timeline) ──────────────────────────────────

// The action handlers in cli.ts call findConfig() and the event-layer runners
// (runLog / runTimeline). We mock those so a parseAsync call doesn't touch the
// real filesystem or print into the test output.

let tmpDir: string;
let mexConfig: MexConfig;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "mex-cli-"));
  mkdirSync(join(tmpDir, ".mex/events"), { recursive: true });
  mexConfig = {
    projectRoot: tmpDir,
    scaffoldRoot: join(tmpDir, ".mex"),
    aiTools: [],
  };
  vi.spyOn(configMod, "findConfig").mockReturnValue(mexConfig);
  // Make parseAsync exit-safe: route Commander exits through an exception we
  // can catch instead of process.exit. Mode is reset per call (see helper).
  program.exitOverride();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/**
 * Run program.parseAsync against an argv tail, mimicking the shape Commander
 * expects (`['node', 'mex', ...args]`). Returns the action's resolved value.
 */
async function runCLI(args: string[]): Promise<void> {
  await program.parseAsync(["node", "mex", ...args]);
}

describe("mex log option parsing", () => {
  it("passes a single --file through to runLog", async () => {
    const spy = vi.spyOn(events, "runLog").mockResolvedValue(undefined);
    await runCLI(["log", "hello", "--type", "note", "--file", "src/a.ts"]);
    expect(spy).toHaveBeenCalledTimes(1);
    const [cfgArg, msgArg, optsArg] = spy.mock.calls[0]!;
    expect(cfgArg).toBe(mexConfig);
    expect(msgArg).toBe("hello");
    expect(optsArg).toMatchObject({ kind: "note", files: ["src/a.ts"] });
  });

  it("preserves repeated --file values in order", async () => {
    const spy = vi.spyOn(events, "runLog").mockResolvedValue(undefined);
    await runCLI([
      "log",
      "stack of files",
      "--file",
      "first.ts",
      "--file",
      "second.ts",
      "--file",
      "third.ts",
    ]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![2]).toMatchObject({
      files: ["first.ts", "second.ts", "third.ts"],
    });
  });

  it("defaults --type to 'note' when not provided", async () => {
    const spy = vi.spyOn(events, "runLog").mockResolvedValue(undefined);
    await runCLI(["log", "no type given"]);
    expect(spy.mock.calls[0]![2]).toMatchObject({ kind: "note" });
  });

  it("propagates an invalid --type through to runLog (validation lives there)", async () => {
    // The command surface accepts any --type string; runLog is the gate that
    // rejects unknown kinds. The CLI's job is to wire the value through.
    const err = new Error("unknown event kind: bogus");
    const spy = vi.spyOn(events, "runLog").mockRejectedValue(err);
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(((_code?: number) => {
        // Throw to short-circuit the action handler so vitest sees the failure
        // rather than hanging the process.
        throw new Error("process.exit was called");
      }) as never);

    await expect(runCLI(["log", "bad", "--type", "bogus"])).rejects.toThrow(
      "process.exit was called",
    );

    expect(spy).toHaveBeenCalledTimes(1);
    expect(consoleErr).toHaveBeenCalledWith("unknown event kind: bogus");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe("mex timeline option parsing", () => {
  it("parses --limit as a positive integer", async () => {
    const spy = vi.spyOn(events, "runTimeline").mockResolvedValue(undefined);
    await runCLI(["timeline", "--limit", "5"]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![1]).toMatchObject({ limit: 5 });
  });

  it("threads --json, --since, and --type through to runTimeline", async () => {
    const spy = vi.spyOn(events, "runTimeline").mockResolvedValue(undefined);
    await runCLI([
      "timeline",
      "--json",
      "--since",
      "2026-05-01",
      "--type",
      "decision",
      "--limit",
      "10",
    ]);
    const opts = spy.mock.calls[0]![1];
    expect(opts).toMatchObject({
      json: true,
      since: "2026-05-01",
      type: "decision",
      limit: 10,
    });
  });

  // --limit validation is covered by the parsePositiveIntArg parser-helper
  // tests above. We do not exercise the rejection path through Commander
  // because Commander's option-coercer error path interacts poorly with
  // vitest's process.exit interception, and the parser is the unit under
  // test - the wiring just hands `--limit` to it.
});
