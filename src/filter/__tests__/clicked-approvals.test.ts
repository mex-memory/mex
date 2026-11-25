import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setSessionLearning, setStatementLearning } from "../../controls/index.js";
import { readNotes } from "../../knowledge/personal-store.js";
import { openRecord, type RecordWriter } from "../../record/index.js";
import { shortHash } from "../../record/project.js";
import { buildReviewCommand } from "../../review/cli.js";
import { reviewQueue } from "../../review/queue.js";
import { clickedApprovals, type ClickedApproval } from "../clicked-approvals.js";

vi.mock("../../knowledge/producers.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../../knowledge/producers.js")>();
  return { ...actual, producer(id: Parameters<typeof actual.producer>[0]) {
    const producer = actual.producer(id);
    return id === "session-ongoing" ? { ...producer, active: true } : producer;
  } };
});

let directory: string, checkout: string, home: string, project: string, folder: string, writer: RecordWriter;
const now = Date.now();
const options = () => ({ projectPath: checkout, home, isNetwork: () => false });
const stamp = (ms: number) => new Date(ms).toISOString();
const controls = () => JSON.parse(readFileSync(join(home, "controls.json"), "utf8"));

function capture(call: string, fields: Partial<ClickedApproval> = {}, filename?: string) {
  const item: ClickedApproval = { version: 1, project_id: project, checkout, agent: "codex", session_id: "s1", call_id: call,
    tool: "request_user_input", at: stamp(now - 100), kind: "approval", level: "personal", strength: "weak", author: "agent",
    choices: [{ question: 1, option: 2, label: "Keep local", text: "Use a local search index" }], ...fields };
  const name = filename ?? shortHash([project, checkout, item.agent, item.session_id, call].join("\0"));
  writeFileSync(join(folder, `${name}.json`), JSON.stringify(item), { mode: 0o600 });
  return item;
}

beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), "mex-approval-")));
  checkout = join(directory, "checkout"); home = join(directory, ".mex");
  mkdirSync(checkout);
  writer = openRecord(options()); project = writer.checkout(checkout)!.project_id;
  folder = join(writer.location.directory, "filter-approvals", shortHash(project + "\0" + checkout));
  mkdirSync(folder, { recursive: true });
});
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs(); writer.close();
  rmSync(directory, { recursive: true, force: true });
});

it("mirrors only the opted-in producer and holds approvals when either learning control is off", () => {
  const choice = capture("choice");
  setStatementLearning(writer, "on");
  expect(controls().clicked_approvals).toBeUndefined();
  expect(clickedApprovals(options(), now)).toEqual([]);
  setSessionLearning(writer, "on");
  expect(controls().clicked_approvals).toBe(true);
  expect(clickedApprovals(options(), now)).toEqual([choice]);
  setStatementLearning(writer, "off");
  expect(controls().clicked_approvals).toBeUndefined();
  expect(clickedApprovals(options(), now)).toEqual([]);
  setSessionLearning(writer, "off");
  setStatementLearning(writer, "on");
  expect(controls().clicked_approvals).toBeUndefined();
});

it("shows bounded agent-written choices in Review and withholds expired, misnamed and foreign records", async () => {
  setStatementLearning(writer, "on"); setSessionLearning(writer, "on");
  const choice = capture("choice");
  const plan = capture("plan", { agent: "claude-code", tool: "ExitPlanMode", at: stamp(now - 1),
    choices: [{ question: 1, option: 1, text: "# Plan\r\nKeep the files local." }] });
  capture("expired", { at: stamp(now - 30 * 86_400_000) });
  capture("foreign", { checkout: join(directory, "other") });
  capture("secret", { choices: [{ question: 1, option: 1, label: "Choose me", text: "password=fixture-secret-123" }] });
  capture("wrong-name", {}, "a".repeat(24));
  writeFileSync(join(folder, `${"b".repeat(24)}.json`), " ".repeat(17 << 10));
  expect(clickedApprovals(options(), now)).toEqual([plan, choice]);
  expect(reviewQueue(options(), now, true).items).toHaveLength(0);
  expect(readNotes(home, project).files.size).toBe(0);

  vi.stubEnv("MEX_HOME", directory);
  vi.spyOn(process, "cwd").mockReturnValue(checkout);
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  await buildReviewCommand().parseAsync(["choices"], { from: "user" });
  const rendered = output.mock.calls.flat().join("\n");
  expect(rendered).toContain("Agent-written option");
  expect(rendered).toContain("Agent-written plan");
  expect(rendered).toContain("  # Plan\n  Keep the files local.");
  expect(rendered).toContain("weak personal approvals");
  expect(rendered).not.toContain("fixture-secret");
});
