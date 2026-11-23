import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { setCheckoutEnabled } from "../../controls/index.js";
import { buildIndex } from "../../file-index/build.js";
import { openRecord, type RecordWriter } from "../../record/index.js";
import { AGENT_VARIABLES } from "../../repo-start/caller.js";
import { parseEntry } from "../entry.js";
import { propose, type Proposal } from "../gate.js";
import { forget } from "../mutations.js";
import { snapshotNotes } from "../personal-store.js";

// A ruled-out approach and the decision it lost to: an agent that brings the approach back sees both reasons.
let suite: string, binary: string, root: string, writer: RecordWriter, project: string, options: { home: string; projectPath: string };
beforeAll(() => {
  suite = realpathSync(mkdtempSync(join(tmpdir(), "mex-pairing-")));
  binary = join(suite, process.platform === "win32" ? "mex-hook.exe" : "mex-hook");
  execFileSync("go", ["build", "-o", binary, "./cmd/mex-hook"], { cwd: resolve("native"), timeout: 240_000, stdio: "pipe" });
}, 300_000);
afterAll(() => rmSync(suite, { recursive: true, force: true }));
beforeEach(async () => {
  for (const key of AGENT_VARIABLES) vi.stubEnv(key, undefined);
  const base = realpathSync(mkdtempSync(join(suite, "case-"))), home = join(base, ".mex");
  root = join(base, "repo");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "dates.ts"), "export const today = 1;\n");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git("init", "-qb", "main"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
  git("add", "."); git("-c", "commit.gpgsign=false", "commit", "-qm", "fixture");
  vi.stubEnv("MEX_HOOK_BINARY", binary); vi.stubEnv("MEX_HOME", base); vi.stubEnv("MEX_BACKGROUND", "0"); vi.stubEnv("MEX_OFFLINE", "1");
  writer = openRecord({ home, projectPath: root, isNetwork: () => false });
  const checkout = setCheckoutEnabled(writer, root, true);
  project = checkout.project_id;
  options = { home, projectPath: checkout.path };
  await buildIndex({ root, projectId: project, recordDirectory: writer.location.directory, workers: 0 });
}, 60_000);
afterEach(() => { writer.close(); vi.unstubAllEnvs(); });

const learned = (key: string, role: "decision" | "ruled-out", text: string, pattern = "from 'moment'", scope = ["src/**"]): Proposal => ({
  producer: "learn-deeper", key, kind: "decision", text, oneLine: text, source: { type: "review", ref: "https://github.com/acme/app/pull/1" }, evidenceClass: "review",
  anchors: { scope, when: [{ type: "rejected", match: "literal", pattern }] }, checks: [{ kind: "scope", role: "complete", target: { glob: scope[0]! } }], model: "none", decisionPairing: role,
});
async function save(...proposals: Proposal[]): Promise<string[]> {
  const results = await propose(proposals, options);
  return results.map(result => { if (result.status !== "accepted") throw new Error(JSON.stringify(result)); return result.entryId; });
}
const companions = (id: string) => parseEntry(snapshotNotes(writer, project).files.get(id)!).mex.companions ?? [];
const DECISION = "Dates go through the Temporal polyfill, because it keeps time zones.", RULED = "Moment was tried and removed, because it doubled the bundle.";

let session = 0;
function bringBack(): string {
  const id = `s${++session}`;
  const hook = (name: string, extra: Record<string, unknown>) => execFileSync(binary, ["claude-code", name], { env: process.env, cwd: root, encoding: "utf8", timeout: 20_000,
    input: JSON.stringify({ session_id: id, cwd: root, hook_event_name: name, ...extra }) });
  hook("SessionStart", { source: "startup" });
  return hook("PreToolUse", { tool_name: "Write", tool_use_id: id, tool_input: { file_path: join(root, "src", `${id}.ts`), content: "import moment from 'moment';\n" } });
}

it("links the two in one save, and shows both reasons when the approach comes back", async () => {
  const [decision, ruled] = await save(learned("d", "decision", DECISION), learned("r", "ruled-out", RULED));
  expect([companions(decision!), companions(ruled!)]).toEqual([[ruled], [decision]]);
  const reply = bringBack();
  expect(reply).toContain("deny");
  expect(reply).toContain("keeps time zones");
  expect(reply).toContain("doubled the bundle");
});

it("links a later ruled-out item to a decision from an earlier run", async () => {
  const [decision] = await save(learned("d", "decision", DECISION));
  const [ruled] = await save(learned("r", "ruled-out", RULED));
  expect([companions(decision!), companions(ruled!)]).toEqual([[ruled], [decision]]);
});

it.each([
  ["two decisions could have won", () => [learned("d", "decision", DECISION), learned("d2", "decision", "Dates are formatted on the server, because clients differ.", "from 'moment'", ["src/dates.ts"]), learned("r", "ruled-out", RULED)]],
  ["the triggers differ", () => [learned("d", "decision", DECISION, "from 'dayjs'"), learned("r", "ruled-out", RULED)]],
  ["neither is a decision", () => [learned("r2", "ruled-out", "Dayjs plugins were tried, because they were smaller.", "from 'moment'", ["src/dates.ts"]), learned("r", "ruled-out", RULED)]],
] as const)("makes no link on a guess: %s", async (_why, proposals) => {
  for (const id of await save(...proposals())) expect(companions(id)).toEqual([]);
});

it("shows only the reason that still stands when the person drops the other", async () => {
  const [decision, ruled] = await save(learned("d", "decision", DECISION), learned("r", "ruled-out", RULED));
  expect(companions(ruled!)).toEqual([decision]);
  forget(decision!, "We changed our mind", options);
  const reply = bringBack();
  expect(reply).toContain("doubled the bundle");
  expect(reply).not.toContain("keeps time zones");
  forget(ruled!, "And about this", options);
  expect(bringBack()).not.toContain("deny");
});
