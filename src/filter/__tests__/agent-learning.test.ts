import { mkdtempSync, mkdirSync, readdirSync, realpathSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ModelRequest } from "../../model-runner/index.js";
import { openRecord, type RecordWriter } from "../../record/index.js";
import { enqueueJob, registerJobKind, runOneBatch } from "../../record/jobs.js";
import { shortHash } from "../../record/project.js";
import { setSessionLearning, setStatementLearning } from "../../controls/index.js";
import { createFilterKind } from "../job.js";
import { filterPending, finishRequest, queuePendingFilters } from "../pending.js";
import { filterRunner } from "../runner.js";
import { readStageOneBatch } from "../stage-one.js";
import { sessionNoteHistory } from "../session-notes.js";
import { readStageTwoInput } from "../stage-two-input.js";
import { timestampNs } from "../time.js";
import type { CaptureAgent } from "../profiles.js";
import type { FilterParams } from "../input.js";

vi.mock("../../knowledge/producers.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../../knowledge/producers.js")>();
  return { ...actual, producer(id: Parameters<typeof actual.producer>[0]) {
    const value = actual.producer(id);
    return id === "session-ongoing" ? { ...value, active: true } : value;
  } };
});

const now = Date.now() - 30_000;
const stamp = (ms: number) => new Date(ms).toISOString();
let temp: string, home: string, checkout: string, project: string, writer: RecordWriter, hooks: DatabaseSync;

beforeEach(() => {
  temp = realpathSync(mkdtempSync(join(tmpdir(), "mex-agent-learning-")));
  home = join(temp, ".mex"); checkout = join(temp, "repo"); mkdirSync(checkout);
  writer = openRecord({ home, projectPath: checkout, isNetwork: () => false });
  project = writer.checkout(checkout)!.project_id;
  setSessionLearning(writer, "on"); setStatementLearning(writer, "on");
  hooks = new DatabaseSync(join(writer.location.directory, "hooks.db"));
  const schema = resolve("native/record/schema/hooks");
  for (const file of readdirSync(schema).filter(file => file.endsWith(".sql")).sort()) hooks.exec(readFileSync(join(schema, file), "utf8"));
  hooks.exec("PRAGMA user_version=6");
});
afterEach(() => { vi.unstubAllEnvs(); hooks.close(); writer.close(); rmSync(temp, { force: true, recursive: true }); });

function file(folder: string, name: string, data: unknown) {
  const dir = join(writer.location.directory, folder); mkdirSync(dir, { recursive: true });
  const path = join(dir, name + ".json"); writeFileSync(path, JSON.stringify(data)); return path;
}
function session(agent: CaptureAgent, id: string, when: number, checkoutPath = checkout, scope = project, idle = false) {
  const at = stamp(when);
  hooks.prepare("INSERT INTO sessions VALUES(?,?,?,?,?,?,0)").run(id, agent, scope, checkoutPath, stamp(when - 20_000), at);
  file("filter-sessions", shortHash(scope + "\0" + id), { version: 1, agent, session_id: id, project_id: scope,
    checkout: checkoutPath, seen_at: at, finished: !idle, ...(idle ? { idle: true } : {}), transcript: "" });
  const name = [shortHash(checkoutPath), shortHash(agent + "\0" + id), timestampNs(at)].join(".");
  return file("filter-pending", name, { version: 1, session_learning: true, agent, session_id: id, project_id: scope,
    checkout: checkoutPath, generation: at, ...(idle ? { ready_at: stamp(when + 600_000) } : {}) });
}
function typed(session: string, ms: number, text: string) {
  return Number(hooks.prepare("INSERT INTO journal(session_id,ts,kind,text,marks) VALUES(?,?,'typed',?,'')")
    .run(session, stamp(ms), text).lastInsertRowid);
}

it("uses an installed cheap runner from another agent and consumes the reply cache with the verdict batch", async () => {
  const request = session("gemini", "g", now - 5_000);
  const earlier = typed("g", now - 20_000, "Can you suggest a local data store?");
  const later = typed("g", now - 10_000, "Go with the first one.");
  const latest = "1. Store everything in SQLite forever.";
  const at = stamp(now - 15_000);
  const cache = file(join("filter-replies", shortHash([project, checkout, "gemini", "g"].join("\0"))), String(timestampNs(at)), {
    version: 1, project_id: project, checkout, agent: "gemini", session_id: "g", at, text: latest, for_prompt_at: stamp(now - 10_000),
  });
  const calls: ModelRequest[] = [];
  registerJobKind(createFilterKind({ stageOne: true, clock: () => now,
    runner: host => filterRunner(host, agent => agent === "codex"), recordChecks: vi.fn(),
    model: async input => {
      calls.push(input);
      const wording = "Store everything in SQLite forever.";
      const verdicts = calls.length === 1 ? [{ id: "m" + earlier, verdict: "task" }, {
        id: "m" + later, verdict: "candidate", kind: "instruction", lasts: "all", marker: "forever", reason: null,
        quote: wording,
      }] : [{ id: "m" + later, verdict: "task" }];
      return { text: JSON.stringify({ verdicts }), selectedModel: "fixture", usage: { input: 10, output: 10, cache_write: 0, cache_read: 0, model: "fixture", estimated: false } };
    },
  }));
  expect(queuePendingFilters(writer, enqueueJob, now)).toBe(1);
  await runOneBatch(writer, "test-agent-learning");
  const messages = JSON.parse(calls[0]!.prompt.split("Input follows as JSON:\n")[1]!).messages;
  expect(calls[0]).toMatchObject({ agent: "codex", role: "cheap" });
  expect(messages).toMatchObject([{ id: "m" + earlier, previous_reply: null }, { id: "m" + later, previous_reply: latest }]);
  expect(existsSync(cache)).toBe(false);
  expect(readStageOneBatch(writer, project, checkout, earlier)?.retry).toEqual([later]);
  await runOneBatch(writer, "test-agent-learning");
  expect(calls[1]!.prompt).not.toContain(latest);
  expect(sessionNoteHistory(writer, project)).toEqual([]);
  await runOneBatch(writer, "test-agent-learning");
  expect(existsSync(request)).toBe(false);
});

it("discovers finished requests from different agents and delays a turn-only host until it is quiet", () => {
  const otherCheckout = join(temp, "other"); mkdirSync(otherCheckout);
  const registered = openRecord({ home, projectPath: otherCheckout, isNetwork: () => false });
  const otherProject = registered.checkout(otherCheckout)!.project_id; registered.close();
  const opencode = session("opencode", "o", now - 30_000, otherCheckout, otherProject, true);
  const cursor = session("cursor", "c", now - 1000);
  typed("o", now - 60_000, "Keep local"); typed("c", now - 10_000, "Proceed");
  const requested: FilterParams[] = [];
  const schedule: typeof enqueueJob = (record, options) => {
    requested.push(options.params as FilterParams);
    return enqueueJob(record, options);
  };
  expect(filterPending(writer.location.directory, writer)).toBe(true);
  expect(queuePendingFilters(writer, schedule, now)).toBe(1);
  expect(requested[0]).toMatchObject({ sourceAgent: "cursor", sessionId: "c" });
  finishRequest(writer, requested[0]!);
  expect(existsSync(cursor)).toBe(false);
  expect(existsSync(opencode)).toBe(true);
  expect(queuePendingFilters(writer, schedule, now + 600_000)).toBe(1);
  expect(requested[1]).toMatchObject({ sourceAgent: "opencode", sessionId: "o", checkout: otherCheckout });
  expect(filterRunner("codex", agent => agent === "claude")).toBe("claude");
  expect(filterRunner("gemini", () => false)).toBeUndefined();
});

it("uses the recorded Copilot session id to find the same transcript in both stages", async () => {
  session("copilot", "copilot-session", now - 1000);
  const text = "We always keep uploaded files local in this checkout.";
  const id = typed("copilot-session", now - 10_000, text);
  const hostHome = join(temp, "copilot-home"), folder = join(hostHome, "session-state", "copilot-session");
  vi.stubEnv("COPILOT_HOME", hostHome); mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "events.jsonl"), [
    { type: "assistant.message", data: { content: "The upload rule is under discussion." } },
    { type: "user.message", data: { content: text } },
  ].map(row => JSON.stringify(row)).join("\n"));
  registerJobKind(createFilterKind({ stageOne: true, clock: () => now, runner: () => "claude", recordChecks: vi.fn(),
    model: async request => {
      expect(request.prompt).toContain("The upload rule is under discussion.");
      return { text: JSON.stringify({ verdicts: [{ id: "m" + id, verdict: "candidate", kind: "instruction", lasts: "repo", marker: "always",
        quote: text, reason: null }] }), selectedModel: "fixture",
        usage: { input: 10, output: 10, cache_write: 0, cache_read: 0, model: "fixture", estimated: false } };
    },
  }));
  expect(queuePendingFilters(writer, enqueueJob, now)).toBe(1);
  await runOneBatch(writer, "test-copilot-learning");
  const stageTwo = readStageTwoInput(writer, project, checkout, now, null);
  expect(stageTwo.sources).toMatchObject([{ agent: "copilot", message: { text, previous_reply: "The upload rule is under discussion." } }]);
});
