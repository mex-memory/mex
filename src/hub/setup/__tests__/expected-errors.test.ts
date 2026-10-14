import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SetupRunSchema, type SetupRun } from "@mex/hub-contracts/setup";
import { HubSetupRunner } from "../runner.js";

const roots: string[] = [];
const runners: HubSetupRunner[] = [];

afterEach(async () => {
  for (const runner of runners.splice(0)) await runner.shutdown();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "mex-setup-expected-error-"));
  roots.push(root);
  return root;
}

function observeRunner(root: string) {
  const runner = new HubSetupRunner({ projectRoot: root });
  runners.push(runner);
  const observed: SetupRun[] = [];
  runner.subscribe((run) => observed.push(run));
  return { runner, observed };
}

async function expectSafeFailure(
  runner: HubSetupRunner,
  observed: readonly SetupRun[],
  root: string,
  message: string,
): Promise<void> {
  await vi.waitFor(() => expect(runner.snapshot().status).toBe("failed"));
  const snapshot = SetupRunSchema.parse(runner.snapshot());
  expect(snapshot).toMatchObject({
    status: "failed", ready: false, error: message, message,
    progress: { step: "scaffold" },
  });
  expect(observed.at(-1)).toEqual(snapshot);
  for (const run of observed) expect(SetupRunSchema.safeParse(run).success).toBe(true);
  const reconnect = vi.fn();
  const unsubscribe = runner.subscribe(reconnect);
  expect(reconnect).toHaveBeenCalledExactlyOnceWith(snapshot);
  expect(SetupRunSchema.parse(reconnect.mock.calls[0]![0])).toEqual(snapshot);
  unsubscribe();
  const payload = JSON.stringify(observed);
  expect(payload).not.toContain(root);
  expect(payload).not.toContain("private-config-token");
  expect(payload).not.toContain("Run mex setup --cli in this project for details");
}

describe("expected setup failures through the real Hub runner", () => {
  it("reports malformed config and accepts a corrected-config retry on the same runner", async () => {
    const root = fixture();
    mkdirSync(join(root, ".mex"));
    const configPath = join(root, ".mex", "config.json");
    const malformed = '{"private-config-token":';
    writeFileSync(configPath, malformed);
    const { runner, observed } = observeRunner(root);

    runner.start({ mode: "agent-memory", tools: [] });
    await expectSafeFailure(runner, observed, root,
      "Existing .mex/config.json is not a valid JSON object. Fix it before rerunning setup.");
    expect(readFileSync(configPath, "utf8")).toBe(malformed);

    writeFileSync(configPath, "{}\n");
    const retry = runner.start({ mode: "agent-memory", tools: [] });
    expect(retry).toMatchObject({ status: "running", error: null });
    await vi.waitFor(() => expect(runner.snapshot().status).toBe("paused"), { timeout: 10_000 });
    const resumed = SetupRunSchema.parse(runner.snapshot());
    expect(resumed).toMatchObject({
      mode: "agent-memory", status: "paused", stage: "needs_population",
      ready: false, error: null, selectedTools: [], populationTool: null,
    });
    expect(resumed.prompt?.length).toBeGreaterThan(100);
    expect(resumed.message).not.toContain("not a valid JSON");
    for (const run of observed) expect(SetupRunSchema.safeParse(run).success).toBe(true);
    expect(existsSync(join(root, ".mex", "graph.db"))).toBe(false);
    expect(existsSync(join(root, ".mex", "wiki.db"))).toBe(false);
  });

  it("reports the broad Git ignore rule before graph construction or agent population", async () => {
    const root = fixture();
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    writeFileSync(join(root, ".gitignore"), ".mex/\n");
    const { runner, observed } = observeRunner(root);

    runner.start({ mode: "code-repo", tools: [] });
    await expectSafeFailure(runner, observed, root,
      "A Git ignore rule hides .mex/config.json. Remove the broad .mex ignore so canonical MEX files can be committed.");
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe(".mex/\n");
    expect(existsSync(join(root, ".mex", "config.json"))).toBe(false);
    expect(existsSync(join(root, ".mex", "graph.db"))).toBe(false);
    expect(existsSync(join(root, ".mex", "wiki.db"))).toBe(false);
    expect(runner.snapshot().populationTool).toBeNull();
    expect(runner.snapshot().prompt).toBeNull();
  });
});
