import { existsSync, mkdtempSync, readFileSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runChain } from "../index.mjs";
import { adapters } from "../lib/agents.mjs";
import { buildReport, renderReport } from "../lib/report.mjs";
import { loadSuite } from "../lib/suite.mjs";
import { records, sessionUsage } from "../lib/usage.mjs";
import { built, fixtureOptions, fixtureRoot } from "./demo.mjs";

const fixture = name => fileURLToPath(new URL("./fixtures/" + name, import.meta.url));

function checkCredentialCleanup(options) {
  const homes = join(options.output, "homes");
  const profiles = readdirSync(homes);
  expect(profiles).toHaveLength(2);
  for (const root of profiles) {
    expect(existsSync(join(homes, root, "claude", ".credentials.json"))).toBe(false);
    expect(existsSync(join(homes, root, "codex", "auth.json"))).toBe(false);
  }
  expect(existsSync(options.credentialFile)).toBe(true);
}

describe("release harness native token accounting", () => {
  it("uses final Claude counts per message and request", () => {
    const usage = sessionUsage(records(fixture("claude.jsonl")), "claude-code");
    expect(usage).toMatchObject({ input: 20, cacheWrite: 10, cacheRead: 60, output: 10, unpricedModels: [] });
    expect(usage.dollars).toBeCloseTo(0.000171, 10);
  });

  it("splits Codex cached input and includes reasoning once", () => {
    const usage = sessionUsage(records(fixture("codex.jsonl")), "codex");
    expect(usage).toMatchObject({ input: 20, cacheWrite: 0, cacheRead: 55, output: 14, reasoning: 8, unpricedModels: [] });
    expect(usage.dollars).toBeCloseTo(0.0001855, 10);
  });

  it("withholds all affected weighted totals when any rate is missing", () => {
    const events = records(fixture("codex.jsonl"));
    events[1].payload.model = "gpt-6.2-sol";
    const agentUsage = sessionUsage(events, "codex");
    const mexCalls = [{ agent: "claude", model: "claude-sonnet-5-5", input: 3, cacheWrite: 1, cacheRead: 4, output: 2 }];
    const row = { task: "fixture", arm: "mex", accepted: true, turns: 2, wallMs: 0, agentUsage, mexCalls };
    const report = buildReport([row], []);
    expect(report.tasks[0].combined.dollars).toBeNull();
    expect(report.chains[1]).toMatchObject({ usage: { dollars: null }, costPerAccepted: null });
    const rendered = renderReport(report, { agent: "codex", suite: "fixture", prices: { profile: "fixture", date: "2026-11-16" } });
    expect(rendered).toContain("| mex | 1 / 1 | 23 | 1 | 59 | 16 | to confirm | 2 | 0 | to confirm |");
    expect(rendered).toContain("List prices to confirm for gpt-6.2-sol.");
  });
});

describe("release harness suites", () => {
  it("accepts a task with no reviewer notes as one turn, and rejects blank notes", () => {
    const dir = mkdtempSync(join(tmpdir(), "mex-arm-suite-"));
    const suite = JSON.parse(readFileSync(fixture("dry.json"), "utf8"));
    delete suite.tasks[1].reviewerNotes;
    const file = join(dir, "suite.json");
    writeFileSync(file, JSON.stringify(suite));
    const loaded = loadSuite(file);
    expect(loaded.tasks.map(task => task.reviewerNotes === undefined)).toEqual([false, true]);
    suite.tasks[1].reviewerNotes = " ";
    writeFileSync(file, JSON.stringify(suite));
    expect(() => loadSuite(file)).toThrow("Invalid or duplicate task");
    unlinkSync(file);
    rmdirSync(dir);
  });
});

describe.skipIf(process.env.MEX_ARM_RUN_DRY !== "1")("release harness dry chain", () => {
  it.each(["claude", "codex"])("runs two %s tasks across isolated arms", async agent => {
    expect(built).toBe(true);
    const options = fixtureOptions(fixtureRoot(), agent);
    const { manifest, report, replay, reportText } = await runChain(options);
    expect(manifest).toMatchObject({ agent, model: options.pin.model, effort: "medium", agentVersion: options.pin.version,
      mexVersion: options.pin.mexVersion, mexCommit: options.pin.mexCommit, node: process.version, os: process.platform });
    expect(manifest.order).toEqual([
      { task: "first", arms: ["baseline", "mex"] }, { task: "second", arms: ["mex", "baseline"] },
    ]);
    expect(manifest.sessions.map(({ task, arm }) => [task, arm])).toEqual([
      ["first", "baseline"], ["first", "mex"], ["second", "mex"], ["second", "baseline"],
    ]);
    expect(report.tasks.map(task => [task.turns, task.accepted])).toEqual([[2, true], [2, true], [2, true], [2, false]]);
    expect(report.tasks.filter(task => task.arm === "mex").map(task => task.mexUsage)).toMatchObject([
      { input: 3, cacheWrite: 1, cacheRead: 4, output: 2 }, { input: 3, cacheWrite: 1, cacheRead: 4, output: 2 },
    ]);
    expect(report.chains.map(chain => chain.accepted)).toEqual([1, 2]);
    expect(reportText).toContain("| Uncached input | Cache write | Cache read | Output |");

    const observations = [];
    for (const row of replay.sessions) {
      const file = join(options.output, "replay", row.file);
      expect(readFileSync(file)).toEqual(readFileSync(join(options.output, "recordings", basename(file))));
      expect(row).toMatchObject({ agent: agent === "claude" ? "claude-code" : agent, repo: "fixture/subject", entries: [],
        commit: expect.stringMatching(/^[a-f0-9]{40}$/) });
      expect(replay.files[row.file]).toMatch(/^[a-f0-9]{64}$/);
      const events = records(file).filter(event => event.type === "fixture_observation");
      expect(events.map(event => event.resumed)).toEqual([false, true]);
      expect(events[0].session).toBe(events[1].session);
      expect(events[1].prompt).toMatch(/^Reviewer notes\n/);
      for (const event of events) {
        expect(event.credentialHash).toBe(options.credentialHash);
        expect(event.installed).toBe(row.arm === "mex");
        expect(Object.keys(event.canaries)).toEqual(expect.arrayContaining([
          event.homes.CLAUDE_CONFIG_DIR, event.homes.CODEX_HOME, event.homes.HOME, event.homes.LOCALAPPDATA,
        ]));
        expect(Object.values(event.canaries).filter(Boolean)).toEqual(expect.arrayContaining(event.resumed ? [event.token] : []));
        expect(Object.values(event.canaries).every(value => value === null || value === event.token)).toBe(true);
      }
      const homes = events[0].homes;
      const native = adapters[agent].transcript({ env: homes }, events[0].session);
      expect(readFileSync(file)).toEqual(readFileSync(native));
      if (row.arm === "baseline") expect(existsSync(homes.MEX_HOME)).toBe(false);
      observations.push({ ...row, events });
    }
    for (const task of ["first", "second"]) {
      const [one, two] = observations.filter(row => row.task === task).map(row => row.events);
      expect(one.map(event => event.prompt)).toEqual(two.map(event => event.prompt));
      expect(one[0].token).not.toBe(two[0].token);
      expect(Object.values(one[0].homes).some(home => Object.values(two[0].homes).includes(home))).toBe(false);
      expect(Object.keys(one[0].canaries).some(home => Object.values(two[0].homes).includes(home))).toBe(false);
      expect(Object.keys(two[0].canaries).some(home => Object.values(one[0].homes).includes(home))).toBe(false);
    }
    for (const arm of ["baseline", "mex"]) {
      const [first, second] = observations.filter(row => row.arm === arm).map(row => row.events[0]);
      expect(first.homes).toEqual(second.homes);
      expect(first.cwd).toBe(second.cwd);
      expect(Object.values(second.canaries).every(value => value === first.token)).toBe(true);
    }
    checkCredentialCleanup(options);
  }, 45_000);

  it.each(["claude", "codex"])("unlinks the %s copies in both homes when a resumed turn fails", async agent => {
    const options = fixtureOptions(fixtureRoot(), agent, "fail");
    await expect(runChain(options)).rejects.toThrow(adapters[agent].label + " turn failed (exit 37)");
    checkCredentialCleanup(options);
    expect(existsSync(join(options.output, "run-manifest.json"))).toBe(false);
  }, 45_000);
});
