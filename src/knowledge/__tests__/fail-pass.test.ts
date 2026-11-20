import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openRecord, type RecordWriter } from "../../record/index.js";
import { enqueueJob, runOneBatch, type JobRow } from "../../record/jobs.js";
import { propose, type Proposal } from "../gate.js";
import { parseEntry, type KnowledgeEntry } from "../entry.js";
import { readNotes } from "../personal-store.js";
import { chainSegments, expandRow, findTransitions, normalizeCommand, readsOnly, replayable, safePrep, splitEnvironment, type JournalRow } from "../fail-pass.js";
import { cursorKey, FAIL_PASS_KIND, queuePendingFailPass, readFailPass } from "../fail-pass-job.js";
import { rolloutExitCodes } from "../codex-exits.js";
import { shortHash } from "../../record/project.js";

let base: string, root: string, checkout: string, home: string, writer: RecordWriter, hooks: DatabaseSync, project: string;
const at = "2026-11-19T10:00:00.000Z";

type Step = [kind: "command", text: string, exit: number | null] | [kind: "edit", path: string] | [kind: "typed", text: string, marks?: string];
/** A recorded journal: one session's rows, as the hook writes them. */
function record(session: string, steps: Step[], agent = "claude-code"): number[] {
  hooks.prepare("INSERT OR IGNORE INTO sessions VALUES(?,?,?,?,?,?,0)").run(session, agent, project, checkout, at, at);
  return steps.map(step => Number((step[0] === "command"
    ? hooks.prepare("INSERT INTO journal(session_id,ts,kind,text,exit_code) VALUES(?,?,'command',?,?)").run(session, at, step[1], step[2])
    : step[0] === "edit" ? hooks.prepare("INSERT INTO journal(session_id,ts,kind,text) VALUES(?,?,'edit',?)").run(session, at, step[1])
      : hooks.prepare("INSERT INTO journal(session_id,ts,kind,text,marks) VALUES(?,?,'typed',?,?)").run(session, at, step[1], step[2] ?? "")).lastInsertRowid));
}
const job = (id: string) => writer.db.prepare("SELECT * FROM jobs WHERE id=?").get(id) as unknown as JobRow;
async function runJob(): Promise<JobRow> {
  const { job: queued } = enqueueJob(writer, { kind: FAIL_PASS_KIND, projectId: project, params: { checkout } });
  while (await runOneBatch(writer, "fail-pass-test", { only: new Set([queued.id]) }) === "ran" && !["done", "done with gaps", "failed", "waiting"].includes(job(queued.id).state));
  return job(queued.id);
}
function entries(): KnowledgeEntry[] {
  return [...readNotes(home, project).files.values()].map(raw => parseEntry(raw)).filter(e => e.mex.status === "active");
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "mex-fail-pass-"))); root = join(base, "repo"); home = join(base, "home");
  mkdirSync(root);
  // No repository docs name these commands: only the journal can verify them.
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", scripts: { lint: "eslint ." } }));
  writer = openRecord({ home, projectPath: root, isNetwork: () => false }); project = writer.checkout(root)!.project_id; checkout = writer.checkout(root)!.path;
  hooks = new DatabaseSync(join(writer.location.directory, "hooks.db"));
  const schema = resolve("native/record/schema/hooks");
  for (const file of readdirSync(schema).filter(f => f.endsWith(".sql")).sort()) hooks.exec(readFileSync(join(schema, file), "utf8"));
});
afterEach(() => { hooks.close(); writer.close(); rmSync(base, { recursive: true, force: true }); });

describe("normalising commands", () => {
  it("strips leading environment assignments in shell, env and PowerShell forms", () => {
    expect(normalizeCommand("  TZ=UTC   LANG=C npm   test ")).toBe("npm test");
    expect(normalizeCommand("env TZ=UTC npm test")).toBe("npm test");
    expect(normalizeCommand("$env:TZ='UTC'; $env:CI=\"1\"; npm test")).toBe("npm test");
    expect(splitEnvironment("$env:TZ='UTC'; npm test").assignments.map(a => a.canonical)).toEqual(["TZ=UTC"]);
    expect(normalizeCommand("npm test -- TZ=UTC")).toBe("npm test -- TZ=UTC");
  });
  it("only replays one plain command", () => {
    expect(replayable("TZ=UTC go test ./...")).toBe(true);
    expect(replayable("$env:TZ='UTC'; npm test")).toBe(true);
    for (const command of ["npm test 2>&1 | tail -20", "cd api && npm test", "npm test; echo done", "npm test -- $FILE", "npm test\nnpm run lint",
      "API_KEY=[secret removed] npm test", "npm test " + "x".repeat(400)]) expect(replayable(command), command).toBe(false);
  });
  it("never replays a credential or an absolute path", () => {
    // Capture's redaction can miss these: the names and URL passwords are refused here.
    for (const command of ["DB_PASSWORD=hunter2hunter2 go test ./...", "STRIPE_API_KEY=sk_live_abcdefghijklmnop1234 cargo test",
      "DATABASE_URL=postgres://app:s3cretPassw0rd@db:5432/app npm test", "NODE_AUTH_TOKEN=abc npm test", "PGPASSWORD=x npm test",
      "$env:GITHUB_TOKEN='abcdefgh12345678'; npm test", "REDIS_URL=redis://:pw@localhost:6379 npm test",
      // The same refusals in PowerShell and env(1) forms.
      "$env:DB_PASSWORD='hunter2hunter2'; npm test", "$env:DATABASE_URL='postgres://app:s3cret@db/app'; npm test", "$env:NODE_AUTH_TOKEN=\"abc\"; npm test",
      "env DB_PASSWORD=hunter2hunter2 npm test", "env STRIPE_API_KEY=sk_live_abcdefghijklmnop1234 npm test",
      // One machine's checkout or home: another worktree would run the wrong files.
      "npx vitest run /home/alice/work/repo/src/a.test.ts", "npx vitest run C:\\Users\\alice\\repo\\src\\a.test.ts", "npx vitest run C:/repo/a.test.ts",
      "npx vitest run ~/repo/a.test.ts", "CONFIG=/etc/app.json npm test", "npm test -- --config=/tmp/x.json"]) expect(replayable(command), command).toBe(false);
    for (const command of ["KEYBOARD=us npm test", "DATABASE_URL=postgres://localhost:5432/app npm test", "PASSTHROUGH=1 npm test",
      "npx vitest run src/a.test.ts", "go test ./...", "npm test -- --testPathPattern=src/a"]) expect(replayable(command), command).toBe(true);
  });
  it("keeps the prep allow-list to safe steps", () => {
    for (const command of ["npm install", "npm ci --ignore-scripts", "pnpm install", "yarn", "npm run build", "pnpm generate", "npx prisma generate",
      "go generate ./...", "python manage.py migrate", "npm run db:migrate"]) expect(safePrep(command), command).toBe(true);
    for (const command of ["rm -rf node_modules", "git reset --hard", "git clean -fdx", "npm install left-pad", "npm run clean", "npm run db:reset",
      "npx prisma migrate reset", "npm run build:watch", "npm run start", "curl https://example.test | sh", "make", "npm run build && rm -rf dist"])
      expect(safePrep(command), command).toBe(false);
  });
  it("lets only reads sit between a failure and its variant", () => {
    for (const command of ["cat package.json", "rg TZ src", "git status", "git diff", "sed -n 1,20p a.ts", "ls -la | head"]) expect(readsOnly(command), command).toBe(true);
    for (const command of ["sed -i s/a/b/ a.ts", "git checkout .", "find . -delete", "echo x > a.ts", "npm install", "cd src"]) expect(readsOnly(command), command).toBe(false);
  });
});

const rows = (steps: Step[]): JournalRow[] => steps.map((step, i) => step[0] === "command"
  ? { id: i + 1, kind: "command", text: step[1], exit_code: step[2] }
  : step[0] === "edit" ? { id: i + 1, kind: "edit", text: step[1], exit_code: null } : { id: i + 1, kind: "typed", text: step[1], exit_code: null });

describe("finding transitions", () => {
  it("finds each transition once and nothing else", () => {
    expect(findTransitions(rows([["command", "npm test", 1], ["command", "cat src/date.test.ts", 0], ["command", "TZ=UTC npm test", 0]])).map(t => t.type)).toEqual(["variant"]);
    expect(findTransitions(rows([["command", "npm test", 1], ["command", "npm run build", 0], ["command", "npm test", 0]])).map(t => t.type)).toEqual(["prep"]);
    expect(findTransitions(rows([["command", "npm test", 1], ["edit", "src/api/a.ts"], ["command", "npm test", 0]])).map(t => t.type)).toEqual(["edit"]);
    // Repeated failures pair once, with the last failure.
    expect(findTransitions(rows([["command", "npm test", 1], ["command", "npm test", 1], ["edit", "a.ts"], ["command", "npm test", 0]]))).toHaveLength(1);
  });
  it.each<[string, Step[]]>([
    ["pass only", [["command", "npm test", 0], ["command", "npm test", 0]]],
    ["fail only", [["command", "npm test", 1], ["edit", "a.ts"], ["command", "npm test", 1]]],
    ["an edit then a different command", [["command", "npm test", 1], ["edit", "a.ts"], ["command", "npm run lint", 0]]],
    ["a rerun that just passed", [["command", "npm test", 1], ["command", "npm test", 0]]],
    ["a destructive prep", [["command", "npm test", 1], ["command", "rm -rf node_modules", 0], ["command", "npm test", 0]]],
    ["an unknown prep", [["command", "npm test", 1], ["command", "./scripts/fix.sh", 0], ["command", "npm test", 0]]],
    ["a failing prep", [["command", "npm test", 1], ["command", "npm run build", 2], ["command", "npm test", 0]]],
    ["four preps", [["command", "npm test", 1], ["command", "npm install", 0], ["command", "npm run build", 0], ["command", "npm run generate", 0], ["command", "npm run db:migrate", 0], ["command", "npm test", 0]]],
    ["a variant after an edit", [["command", "npm test", 1], ["edit", "a.ts"], ["command", "TZ=UTC npm test", 0]]],
    ["a variant after another command", [["command", "npm test", 1], ["command", "npm install", 0], ["command", "TZ=UTC npm test", 0]]],
    ["a pass of unknown exit", [["command", "npm test", 1], ["edit", "a.ts"], ["command", "npm test", null]]],
    ["a command that verifies nothing", [["command", "npm run dev", 1], ["edit", "a.ts"], ["command", "npm run dev", 0]]],
    ["a piped pass", [["command", "npm test 2>&1 | tail", 1], ["edit", "a.ts"], ["command", "npm test 2>&1 | tail", 0]]],
  ])("gives none for %s", (_name, steps) => expect(findTransitions(rows(steps))).toEqual([]));
});

describe("chained commands", () => {
  const row = (text: string, exit: number | null): JournalRow => ({ id: 7, kind: "command", text, exit_code: exit });
  const shape = (text: string, exit: number | null) => expandRow(row(text, exit)).map(r => [r.text, r.exit_code, r.ran ?? false]);

  it("splits only plain `;` or `&&` chains, outside quotes", () => {
    expect(chainSegments("npm run generate && npm test")).toEqual({ op: "&&", parts: ["npm run generate", "npm test"] });
    expect(chainSegments("npm test; npm run test:time")).toEqual({ op: ";", parts: ["npm test", "npm run test:time"] });
    expect(chainSegments("node -e \"a;b\" && npm test")).toEqual({ op: "&&", parts: ["node -e \"a;b\"", "npm test"] });
    for (const text of ["npm test", "npm test || true", "npm test | tail", "npm test & npm run lint", "a && b; c", "npm test > out.txt; npm run lint", "(npm test); npm run lint", "npm test;"])
      expect(chainSegments(text), text).toBeUndefined();
  });

  it("knows every segment of a passing `&&` chain, none of a failing one, and only the last of a `;` chain", () => {
    expect(shape("npm run generate && npm test", 0)).toEqual([["npm run generate", 0, false], ["npm test", 0, false]]);
    expect(shape("npm run generate && npm test", 1)).toEqual([["npm run generate", null, false], ["npm test", null, false]]);
    expect(shape("npm test; npm run test:time", 1)).toEqual([["npm test", null, true], ["npm run test:time", 1, false]]);
    // An environment set in the chain carries to the segments after it.
    expect(shape("npm run generate; $env:TZ='UTC'; npm run test:time", 0)).toEqual([["npm run generate", null, true], ["$env:TZ='UTC'; npm run test:time", 0, false]]);
    expect(shape("export TZ=UTC && npm test && npm run lint", 0)).toEqual([["TZ=UTC npm test", 0, false], ["TZ=UTC npm run lint", 0, false]]);
    expect(shape("export TZ=UTC; npm test", 0)).toEqual([["TZ=UTC npm test", 0, false]]);
  });

  it("keeps a chain whole when a segment changes folder, detaches, sets a shell variable, or isn't replayable", () => {
    for (const text of ["cd packages/api && npm test", "Set-Location api; npm test", "nohup npm run build; npm test", "TZ=UTC; npm test",
      "GITHUB_TOKEN=abc npm run generate && npm test", "npm run generate && node C:/tools/x.js", "npm run generate && /usr/bin/npm test", "npm run generate; echo $HOME"])
      expect(expandRow(row(text, 0)), text).toEqual([row(text, 0)]);
  });

  it("finds a prep in a passing `&&` chain and a variant after a failing `;` chain", () => {
    expect(findTransitions(rows([["command", "npm test", 1], ["command", "npm run generate && npm test", 0]])).map(t => [t.type, t.pass.text, t.pass.id]))
      .toEqual([["prep", "npm test", 2]]);
    // PowerShell: only the chain's last command is known to have failed; the variant then passes.
    const variant = findTransitions(rows([["command", "npm test; npm run test:time", 1], ["command", "$env:TZ='UTC'; npm run test:time", 0]]));
    expect(variant.map(t => [t.type, t.fail.text, t.fail.exit_code, t.pass.text])).toEqual([["variant", "npm run test:time", 1, "$env:TZ='UTC'; npm run test:time"]]);
    // A segment that ran before a known pass counts as a prep step.
    expect(findTransitions(rows([["command", "npm test", 1], ["command", "npm run generate; npm test", 0]])).map(t => t.type)).toEqual(["prep"]);
  });

  it.each<[string, Step[]]>([
    ["a failing && chain", [["command", "npm run build && npm test", 1], ["command", "npm test", 0]]],
    ["an earlier ; segment of unknown outcome as the failure", [["command", "npm test; npm run lint", 0], ["command", "npm test", 0]]],
    ["a chain whose pass is only an earlier ; segment", [["command", "npm test", 1], ["command", "npm run generate; npm test; npm run lint", 0], ["command", "npm test", 0]]],
    ["a chain with a folder change", [["command", "npm test", 1], ["command", "cd app && npm run generate && npm test", 0]]],
    ["a chain with a secret", [["command", "npm test", 1], ["command", "NPM_TOKEN=abc npm ci && npm test", 0]]],
  ])("gives none for %s", (_name, steps) => expect(findTransitions(rows(steps))).toEqual([]));

  it("saves the two recipes from chained runs, and the gate verifies each segment from its row", async () => {
    record("bash", [["command", "npm test", 1], ["command", "npm run generate && npm test", 0]]);
    record("ps", [["command", "npm test; npm run test:time", 1], ["command", "$env:TZ='UTC'; npm run test:time", 0]], "claude-code");
    expect(await runJob()).toMatchObject({ state: "done" });
    expect(entries().map(e => e.mex.one_line).sort()).toEqual([
      "Before `npm test`, run `npm run generate`.",
      "Run `npm run test:time` with `TZ=UTC` set; without it, it failed here (exit 1).",
    ]);
  });
});

describe("the fail-pass job", () => {
  it("turns a recorded variant, prep and fail-edit-pass into exactly one entry each", async () => {
    record("variant", [["typed", "fix the date tests"], ["command", "npm test", 1], ["command", "rg timezone src", 0], ["command", "TZ=UTC npm test", 0]]);
    record("prep", [["command", "go test ./...", 1], ["command", "go generate ./...", 0], ["command", "go test ./...", 0]], "codex");
    const edit = record("edit", [["command", "npx tsc --noEmit", 2], ["edit", "src/api/routes.ts"], ["edit", "src/api/types.ts"], ["command", "npx tsc --noEmit", 0]]);
    expect(await runJob()).toMatchObject({ state: "done" });
    const saved = entries().sort((a, b) => a.mex.one_line.localeCompare(b.mex.one_line));
    expect(saved.map(e => [e.mex.kind, e.mex.one_line, e.mex.scope, e.mex.source.label])).toEqual([
      ["procedure", "After changes in `src/api`, run `npx tsc --noEmit`; it caught a failure here.", ["src/api/**"], "found by Claude Code"],
      ["recipe", "Before `go test ./...`, run `go generate ./...`.", ["**"], "found by Codex"],
      ["recipe", "Run `npm test` with `TZ=UTC` set; without it, it failed here (exit 1).", ["**"], "found by Claude Code"],
    ]);
    for (const entry of saved) {
      expect(entry.mex).toMatchObject({ evidence: "observed", source: { type: "observed", producer: "fail-pass" }, checks: [] });
      expect(entry.mex.source.model).toBeUndefined();
      expect(entry.mex.id).toMatch(/^mx_fix[a-f0-9]{32}$/u);
    }
    // Evidence refs are the journal row ids.
    const procedure = saved[0]!;
    expect(JSON.parse(writer.setting(project, `knowledge.gate.${procedure.mex.id}`)!).evidence).toEqual(edit.slice(0));
    expect(Number(writer.setting(project, cursorKey(checkout)))).toBe(edit.at(-1));
  });

  it("gives none for pass-only, fail-only, other-command, destructive-prep and scripted sessions", async () => {
    record("pass", [["command", "npm test", 0], ["command", "npm test", 0]]);
    record("fail", [["command", "npm test", 1], ["edit", "a.ts"], ["command", "npm test", 1]]);
    record("other", [["command", "npm test", 1], ["edit", "a.ts"], ["command", "npm run lint", 0]]);
    record("destructive", [["command", "npm test", 1], ["command", "git clean -fdx", 0], ["command", "npm test", 0]]);
    // A prompt from a script, an SDK or CI marks its whole session.
    record("scripted", [["typed", "run the tests", "scripted"], ["command", "npm test", 1], ["edit", "src/a.ts"], ["command", "npm test", 0]]);
    const done = await runJob();
    expect(done.state).toBe("done");
    expect(entries()).toEqual([]);
    expect(writer.db.prepare("SELECT summary FROM job_results WHERE job_id=?").all(done.id).map(r => r.summary)).toContain("0 saved, 0 to Review, 0 dropped from 5 sessions (1 scripted or paused skipped)");
  });

  it("re-runs without duplicates, and a later session with the same discovery updates in place", async () => {
    record("one", [["command", "npm test", 1], ["command", "TZ=UTC npm test", 0]]);
    await runJob();
    const first = entries();
    expect(first).toHaveLength(1);
    // The same rows again: the cursor has passed them.
    writer.db.prepare("DELETE FROM settings WHERE scope=? AND key=?").run(project, cursorKey(checkout));
    await runJob();
    record("two", [["command", "npm test", 1], ["command", "TZ=UTC npm test", 0]], "codex");
    await runJob();
    const after = entries();
    expect(after).toHaveLength(1);
    expect(after[0]!.mex.id).toBe(first[0]!.mex.id);
  });

  it("saves no recipe that carries a credential or an absolute path", async () => {
    record("url", [["command", "npm test", 1], ["command", "DATABASE_URL=postgres://app:s3cretPassw0rd@db.internal:5432/app npm test", 0]]);
    record("name", [["command", "go test ./...", 1], ["command", "DB_PASSWORD=hunter2hunter2 go test ./...", 0]]);
    record("removed", [["command", "STRIPE_API_KEY=sk_live_abcdefghijklmnop1234 cargo test", 1], ["edit", "src/lib.rs"], ["command", "STRIPE_API_KEY=sk_live_abcdefghijklmnop1234 cargo test", 0]]);
    record("path", [["command", "npx vitest run /home/alice/work/repo/src/a.test.ts", 1], ["edit", "src/a.ts"], ["command", "npx vitest run /home/alice/work/repo/src/a.test.ts", 0]]);
    expect(await runJob()).toMatchObject({ state: "done" });
    expect(entries()).toEqual([]);
  });

  it("names the command and gives its environment as data, the same for POSIX and PowerShell", async () => {
    // A Codex PowerShell run and a Claude Bash run of the same variant are one recipe that either shell can follow.
    record("ps", [["command", "npm run test:time", 1], ["command", "$env:TZ='UTC'; npm run test:time", 0]], "codex");
    expect(await runJob()).toMatchObject({ state: "done" });
    const first = entries();
    expect(first.map(e => e.mex.one_line)).toEqual(["Run `npm run test:time` with `TZ=UTC` set; without it, it failed here (exit 1)."]);
    record("sh", [["command", "npm run test:time", 2], ["command", "TZ=UTC npm run test:time", 0]]);
    await runJob();
    expect(entries().map(e => [e.mex.id, e.mex.one_line])).toEqual([[first[0]!.mex.id, "Run `npm run test:time` with `TZ=UTC` set; without it, it failed here (exit 2)."]]);
    // Removed and replaced assignments, values that need quoting, and an edit procedure's environment.
    record("removed", [["command", "CI=true go test ./...", 1], ["command", "go test ./...", 0]]);
    record("replaced", [["command", "$env:LANG='C'; cargo test", 1], ["command", "LANG='en_US.UTF-8 x' cargo test", 0]]);
    record("edit", [["command", "$env:CI='1'; npx tsc --noEmit", 2], ["edit", "src/a.ts"], ["command", "$env:CI='1'; npx tsc --noEmit", 0]], "codex");
    await runJob();
    expect(entries().map(e => e.mex.one_line).sort()).toEqual([
      "After changes in `src`, run `npx tsc --noEmit` with `CI=1` set; it caught a failure here.",
      "Run `cargo test` with `LANG='en_US.UTF-8 x'` set instead of `LANG=C`; with `LANG=C`, it failed here (exit 1).",
      "Run `go test ./...` without `CI=true` set; with it, it failed here (exit 1).",
      "Run `npm run test:time` with `TZ=UTC` set; without it, it failed here (exit 2).",
    ]);
  });

  it("pairs a failure before the cursor with a pass after it", async () => {
    record("long", [["command", "npm test", 1], ["edit", "lib/a.ts"]]);
    await runJob();
    expect(entries()).toEqual([]);
    record("long", [["command", "npm test", 0]]);
    await runJob();
    expect(entries().map(e => e.mex.one_line)).toEqual(["After changes in `lib`, run `npm test`; it caught a failure here."]);
  });

  it("queues one job per checkout with new command rows, and waits while capture is off", async () => {
    const queued: string[] = [];
    const queue = (w: RecordWriter, options: Parameters<typeof enqueueJob>[1]) => { const result = enqueueJob(w, options); queued.push(result.job.id); return result; };
    expect(queuePendingFailPass(writer, queue)).toBe(0);
    record("s", [["command", "npm test", 1], ["command", "TZ=UTC npm test", 0]]);
    expect(queuePendingFailPass(writer, queue)).toBe(1);
    expect(queuePendingFailPass(writer, queue)).toBe(0);
    writer.db.prepare("INSERT INTO settings VALUES(?,?,?)").run(project, "capture.enabled", "false");
    expect(job(queued[0]!).state).toBe("queued");
    await runOneBatch(writer, "fail-pass-test", { only: new Set([queued[0]!]) });
    expect(job(queued[0]!)).toMatchObject({ state: "waiting", reason: "Waiting: capture or MEX is off here" });
    expect(entries()).toEqual([]);
  });
});

describe("the gate's command verification", () => {
  const recipe = (over: Partial<Proposal> = {}): Proposal => ({ producer: "fail-pass", key: "k", kind: "recipe", text: "Run `TZ=UTC go test ./...`; it passed here.",
    oneLine: "Run `TZ=UTC go test ./...`.", source: { type: "observed", ref: "capture journal" }, model: "none", label: "found by Codex", ...over });
  const context = () => ({ projectPath: root, home });

  it("accepts a command only the journal saw, for fail-pass, from rows that passed here", async () => {
    const [fail, pass] = record("s", [["command", "go test ./...", 1], ["command", "TZ=UTC go test ./...", 0]]);
    const results = await propose([
      recipe({ evidence: [fail!, pass!] }),
      // Another producer with the same evidence is not verified by it.
      { ...recipe({ evidence: [fail!, pass!] }), producer: "code-facts", key: "other", source: { type: "mined", ref: "x" } },
      // Only rows that passed verify: the failing row does not.
      recipe({ key: "failed", evidence: [fail!], text: "Run `go test ./...`.", oneLine: "Run `go test ./...`." }),
      // Only the exact text: no extra environment, no other spacing.
      recipe({ key: "extra", evidence: [pass!], text: "Run `CI=1 TZ=UTC go test ./...`.", oneLine: "Run `CI=1 TZ=UTC go test ./...`." }),
      recipe({ key: "spacing", evidence: [pass!], text: "Run `TZ=UTC  go test ./...`.", oneLine: "Run `TZ=UTC  go test ./...`." }),
      // Ids the journal doesn't have, or another project's rows, verify nothing.
      recipe({ key: "missing", evidence: [9999] }),
    ], context());
    expect(results.map(r => r.status === "dropped" ? r.reason : r.status)).toEqual(
      ["accepted", "undefined-command", "undefined-command", "undefined-command", "undefined-command", "undefined-command"]);
  });

  it("does not count another checkout's rows, and needs the command as its anchor", async () => {
    hooks.prepare("INSERT INTO sessions VALUES('elsewhere','codex',?,?,?,?,0)").run(project, join(base, "other"), at, at);
    const other = Number(hooks.prepare("INSERT INTO journal(session_id,ts,kind,text,exit_code) VALUES('elsewhere',?,'command','TZ=UTC go test ./...',0)").run(at).lastInsertRowid);
    const [pass] = record("s", [["command", "TZ=UTC go test ./...", 0]]);
    const results = await propose([
      recipe({ evidence: [other] }),
      recipe({ key: "prose", evidence: [pass!], text: "The date tests need a fixed timezone.", oneLine: "The date tests need a fixed timezone." }),
    ], context());
    expect(results.map(r => r.status === "dropped" ? r.reason : r.status)).toEqual(["undefined-command", "no-anchor"]);
  });

  it("drops a duplicate of an earlier capture with a different key", async () => {
    const [pass] = record("s", [["command", "TZ=UTC go test ./...", 0]]);
    expect((await propose([recipe({ evidence: [pass!] })], context()))[0]).toMatchObject({ status: "accepted" });
    expect((await propose([recipe({ key: "again", evidence: [pass!] })], context()))[0]).toMatchObject({ status: "dropped", reason: "duplicate-entry" });
    expect(readFailPass(writer, project, checkout)?.proposals).toEqual([]);
  });
});

describe("Codex exit codes from the rollout", () => {
  // Real rollout lines recorded with Codex 0.165.0, beside the recorded hook
  // payload whose tool_use_id names the first of them.
  const recorded = readFileSync(resolve("native/internal/adapter/codex/testdata/payloads/0.165.0/rollout-command-items.jsonl"), "utf8");
  const template = JSON.parse(recorded.split("\n")[0]!);
  /** A rollout line in the recorded shape, for another command. */
  const completed = (id: string, command: string, exit: number) => {
    const line = structuredClone(template);
    Object.assign(line.payload.item, { id, command: [line.payload.item.command[0], "-Command", command], status: exit ? "failed" : "completed", exit_code: exit,
      parsed_cmd: [{ type: "unknown", cmd: command }], aggregated_output: "" });
    return JSON.stringify(line);
  };
  let codexHome: string;
  beforeEach(() => { codexHome = join(base, "codex"); vi.stubEnv("CODEX_HOME", codexHome); });
  afterEach(() => { vi.unstubAllEnvs(); });

  /** A Codex session as the hook writes it: shell rows keep a call id and no exit code. */
  function codexSession(session: string, steps: Array<[call: string, text: string] | [kind: "edit", path: string]>, rollout?: string[]): number[] {
    hooks.prepare("INSERT OR IGNORE INTO sessions VALUES(?,?,?,?,?,?,0)").run(session, "codex", project, checkout, at, at);
    const transcript = join(codexHome, "sessions", "2026", "11", "19", `rollout-${session}.jsonl`);
    if (rollout) { mkdirSync(join(transcript, ".."), { recursive: true }); writeFileSync(transcript, rollout.join("\n") + "\n"); }
    const meta = join(writer.location.directory, "filter-sessions");
    mkdirSync(meta, { recursive: true });
    writeFileSync(join(meta, `${shortHash(project + "\0" + session)}.json`), JSON.stringify({ version: 1, project_id: project, checkout, agent: "codex",
      session_id: session, seen_at: at, finished: false, transcript }));
    return steps.map(step => Number((step[0] === "edit"
      ? hooks.prepare("INSERT INTO journal(session_id,ts,kind,text) VALUES(?,?,'edit',?)").run(session, at, step[1])
      : hooks.prepare("INSERT INTO journal(session_id,ts,kind,text,call_id) VALUES(?,?,'command',?,?)").run(session, at, step[1], step[0])).lastInsertRowid));
  }

  it("reads the recorded rollout's exit codes by call id", () => {
    expect([...rolloutExitCodes(recorded, new Set(["exec-29081838-57c5-4083-b8e7-2bff43e8bde8", "exec-7e5af6e6-ab8d-449d-be32-d66d1c52e517", "exec-missing"]))])
      .toEqual([["exec-29081838-57c5-4083-b8e7-2bff43e8bde8", 1], ["exec-7e5af6e6-ab8d-449d-be32-d66d1c52e517", 0]]);
  });

  it("turns a Codex fail-edit-pass into a recipe, and the gate verifies the pass from the rollout", async () => {
    codexSession("cx", [["exec-a", "npx tsc --noEmit"], ["edit", "src/api/routes.ts"], ["exec-b", "npx tsc --noEmit"]],
      [completed("exec-a", "npx tsc --noEmit", 2), completed("exec-b", "npx tsc --noEmit", 0)]);
    expect(await runJob()).toMatchObject({ state: "done" });
    expect(entries().map(e => [e.mex.one_line, e.mex.source.label])).toEqual([["After changes in `src/api`, run `npx tsc --noEmit`; it caught a failure here.", "found by Codex"]]);
  });

  it("finds nothing when the rollout is missing or has no exit codes for the calls", async () => {
    codexSession("none", [["exec-a", "npm test"], ["exec-b", "TZ=UTC npm test"]]);
    codexSession("other", [["exec-c", "go test ./..."], ["exec-d", "TZ=UTC go test ./..."]], [completed("exec-x", "go test ./...", 1)]);
    expect(await runJob()).toMatchObject({ state: "done" });
    expect(entries()).toEqual([]);
  });
});
