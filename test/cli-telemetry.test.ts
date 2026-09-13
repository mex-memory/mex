import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import { createCliTelemetry, isTelemetryExemptCommand, telemetryProjectLocation } from "../src/cli-telemetry.js";

describe("CLI invocation telemetry", () => {
  it.each(["status", "refresh", "rebuild", "repair"])("honors parent and local --root for graph %s", async (name) => {
    for (const [args, expected] of [
      [["graph", "--root", "/parent", name], "/parent"],
      [["graph", "--root", "/parent", name, "--root", "/selected"], "/selected"],
      [["graph", name], "/cwd"],
    ] as const) {
      const root = new Command("mex");
      const command = root.command("graph").option("--root <dir>").command(name).option("--root <dir>").action(() => {});
      await root.parseAsync([...args], { from: "user" });
      expect(telemetryProjectLocation(command, "/cwd")).toEqual({ root: expected, discovery: "exact" });
    }
  });

  it("uses exact cwd for legacy graph but ordinary Git discovery for query commands", async () => {
    const root = new Command("mex");
    const graph = root.command("graph").option("--root <dir>");
    const query = graph.command("query").action(() => {});
    expect(telemetryProjectLocation(graph, "/cwd")).toEqual({ root: "/cwd", discovery: "exact" });
    await root.parseAsync(["graph", "--root", "/unused", "query"], { from: "user" });
    expect(telemetryProjectLocation(query, "/cwd")).toEqual({ root: "/cwd", discovery: "git-root" });
    expect(telemetryProjectLocation(graph, "/cwd")).toEqual({ root: "/unused", discovery: "exact" });
  });

  it("uses the registered namespaced command and excludes input and output", async () => {
    const capture = vi.fn();
    const flush = vi.fn(async () => {});
    let now = 100;
    const telemetry = createCliTelemetry(capture, flush, () => now);
    const root = new Command("mex");
    const command = root.command("wiki").command("query <text>").option("--json").action(() => { now = 137.9; });
    root.hook("preAction", (_, action) => telemetry.start(action));
    root.hook("postAction", () => telemetry.finish(0));
    await root.parseAsync(["wiki", "query", "private customer@example.com query", "--json"], { from: "user" });
    expect(command.args).toHaveLength(1);
    expect(capture.mock.calls).toEqual([
      ["cli.command_started", { command: "wiki.query", stage: "direct" }],
      ["cli.command_completed", { command: "wiki.query", stage: "direct", outcome: "success", duration_ms: 37 }],
    ]);
    await telemetry.finish(0);
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it("records a thrown action once during cleanup without capturing the error", async () => {
    const capture = vi.fn();
    const telemetry = createCliTelemetry(capture, async () => {}, () => 0);
    const root = new Command("mex");
    root.command("check").action(() => { throw new Error("secret path /Users/private"); });
    root.hook("preAction", (_, action) => telemetry.start(action));
    root.hook("postAction", () => telemetry.finish(0));
    await expect(root.parseAsync(["check"], { from: "user" })).rejects.toThrow();
    await telemetry.finish(1);
    await telemetry.finish(1);
    expect(capture.mock.calls).toEqual([
      ["cli.command_started", { command: "check", stage: "direct" }],
      ["cli.command_completed", { command: "check", stage: "direct", outcome: "failure", duration_ms: 0 }],
    ]);
  });

  it.each([
    [[], "preview"],
    [["--apply", "/private/receipt.json"], "apply"],
    [["--from", "/private/draft.json"], "direct"],
  ])("distinguishes Relay preview, approved apply, and quick local save: %j", async (args, stage) => {
    const capture = vi.fn();
    const telemetry = createCliTelemetry(capture, async () => {}, () => 0);
    const root = new Command("mex");
    root.command("relay").command("draft").command("save")
      .option("--apply <receipt>").option("--from <draft>").action(() => {});
    root.hook("preAction", (_, action) => telemetry.start(action));
    root.hook("postAction", () => telemetry.finish(0));
    await root.parseAsync(["relay", "draft", "save", ...args], { from: "user" });
    expect(capture.mock.calls[1]).toEqual(["cli.command_completed", {
      command: "relay.draft.save", stage, outcome: "success", duration_ms: 0,
    }]);
  });

  it.each(["capabilities", "logging", "timeline", "hub", "telemetry.inspect", "member.list", "inbox.contract", "relay.draft.show", "new-private-command"])(
    "keeps pure discovery, Hub bootstrap, meta and unknown commands silent: %s", async (path) => {
      const root = new Command("mex");
      const command = path.split(".").reduce((parent, name) => parent.command(name), root);
      const capture = vi.fn();
      const flush = vi.fn(async () => {});
      const telemetry = createCliTelemetry(capture, flush);
      telemetry.start(command);
      await telemetry.finish(0);
      expect(capture).not.toHaveBeenCalled();
      expect(flush).not.toHaveBeenCalled();
      expect(isTelemetryExemptCommand(command.name(), command.parent?.name(), path)).toBe(true);
    },
  );

  it("reads one context snapshot for both events of an ordinary invocation", async () => {
    const command = new Command("mex").command("wiki").command("query");
    const readContext = vi.fn(() => ({ configured_ai_tools: ["codex" as const] }));
    const capture = vi.fn();
    const telemetry = createCliTelemetry(capture, async () => {}, () => 0, readContext);
    telemetry.start(command);
    await telemetry.finish(0);
    expect(readContext).toHaveBeenCalledExactlyOnceWith(command);
    expect(capture.mock.calls.map(([, attributes]) => attributes.configured_ai_tools)).toEqual([["codex"], ["codex"]]);
  });

  it.each(["setup", "init"])("observes newly saved configuration when %s completes", async (name) => {
    const command = new Command("mex").command(name);
    if (name === "setup") command.setOptionValue("cli", true);
    const readContext = vi.fn().mockReturnValueOnce({}).mockReturnValueOnce({ configured_ai_tools: ["claude", "codex"] });
    const capture = vi.fn();
    const telemetry = createCliTelemetry(capture, async () => {}, () => 0, readContext);
    telemetry.start(command);
    await telemetry.finish(0);
    expect(readContext).toHaveBeenCalledTimes(2);
    expect(capture.mock.calls[0][1]).not.toHaveProperty("configured_ai_tools");
    expect(capture.mock.calls[1][1].configured_ai_tools).toEqual(["claude", "codex"]);
  });

  it("does not discover project metadata for exempt commands", async () => {
    const readContext = vi.fn();
    const capture = vi.fn();
    const telemetry = createCliTelemetry(capture, async () => {}, undefined, readContext);
    telemetry.start(new Command("mex").command("telemetry").command("inspect"));
    await telemetry.finish(0);
    expect(readContext).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
  });

  it("keeps base events when optional metadata lookup throws", async () => {
    const capture = vi.fn();
    const telemetry = createCliTelemetry(capture, async () => {}, () => 0, () => { throw new Error("unreadable config"); });
    telemetry.start(new Command("mex").command("check"));
    await telemetry.finish(1);
    expect(capture.mock.calls[1][1]).toEqual({ command: "check", stage: "direct", outcome: "failure", duration_ms: 0 });
  });

  it("preserves command behavior if capture or delivery fails", async () => {
    const root = new Command("mex");
    const command = root.command("commands");
    const telemetry = createCliTelemetry(() => { throw new Error("disk full"); }, async () => { throw new Error("offline"); });
    expect(() => telemetry.start(command)).not.toThrow();
    await expect(telemetry.finish(0)).resolves.toBeUndefined();
  });
});
