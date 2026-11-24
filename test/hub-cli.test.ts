import { describe, expect, it } from "vitest";
import {
  isTelemetryExemptCommand,
  createHubRunOptions,
  parsePortArg,
  program,
} from "../src/cli.js";
import { createConfig } from "../src/config.js";

describe("mex hub command surface", () => {
  it("registers the Hub command and its public options", () => {
    const command = program.commands.find((candidate) => candidate.name() === "hub");
    expect(command).toBeDefined();
    expect(command?.options.map((option) => option.long)).toEqual([
      "--port",
      "--no-open",
      "--foreground",
    ]);
  });

  it("accepts only valid explicit TCP ports", () => {
    expect(parsePortArg("1")).toBe(1);
    expect(parsePortArg("65535")).toBe(65_535);
    expect(() => parsePortArg("0")).toThrow(/positive integer/);
    expect(() => parsePortArg("65536")).toThrow(/1 to 65535/);
    expect(() => parsePortArg("1junk")).toThrow();
  });

  it("keeps Hub launch and actions outside command telemetry", () => {
    expect(isTelemetryExemptCommand("hub", "mex")).toBe(true);
    expect(isTelemetryExemptCommand("check", "mex")).toBe(false);
  });

  it("passes normalized Wiki ownership and corpus scope into production Hub startup", () => {
    const config = createConfig({
      projectRoot: "/project",
      scaffoldRoot: "/project/.mex",
      wiki: {
        exclude: ["private/**"],
        readOnly: ["imported/**"],
        synthesis: {
          minFiles: 1,
          maxTokens: 4_000,
          primaryContextLines: 3,
          maxFileLines: 400,
          supportingMaxLines: 120,
          maxCandidates: 60,
          maxPerUnit: 6,
          maxGroups: 40,
          maxNodes: 60,
        },
      },
    });
    expect(createHubRunOptions(config, "scaffold-configured", { port: 48123, open: false }))
      .toMatchObject({
        projectRoot: "/project",
        scaffoldId: "scaffold-configured",
        port: 48123,
        openBrowser: false,
        wikiExclude: ["private/**"],
        wikiReadOnly: ["imported/**"],
      });
  });
});
