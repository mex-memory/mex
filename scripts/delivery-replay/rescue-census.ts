/**
 * Rescue and history census over saved sessions.
 *
 * Replays saved sessions against the real source checkouts, each with a real
 * file index and fix history, through the real hook binary, with the rescue
 * and history surfaces switched on. Tool commands are never run.
 *
 * The sessions ran without MEX, so "acted" here means the agent reached the
 * named file on its own within the next 40 calls: a precision check on what
 * a rescue would have said, not a measure of its effect. Only live or shadow
 * use settles a gate.
 *
 * npx vite-node scripts/delivery-replay/rescue-census.ts -- --qset <dir> --sessions <dir>
 *   --sources <repos.json> --binary <mex-hook> --output <dir> [--work <dir>]
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { buildIndex } from "../../src/file-index/build.js";
import { writeFixTable, writeWorkingSet } from "../../src/working-set/compute.js";
import { buildCodeFacts } from "../../src/repo-start/history/job.js";
import { writeFactFile } from "../../src/repo-start/facts.js";
import type { RecordLocation } from "../../src/record/location.js";
// @ts-expect-error plain JavaScript helpers shared with the replay
import { convert, transcript } from "./convert.mjs";

const SURFACES = ["rescue-wrong-path", "rescue-search", "rescue-wide", "rescue-glob-timeout", "bug-history"];

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(name);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1]!;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing ${name}`);
}

function rows(file: string): Array<Record<string, string>> {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
}

interface Event { kind: string; tool?: { name: string; output?: { ok: boolean; text: string } }; batch?: Array<{ name: string; output?: { ok: boolean; text: string } }> }

/** What happened in the sessions that a rescue could answer, rescue or not. */
function triggers(events: Event[]): Record<string, number> {
  const out = { failedReads: 0, failedEdits: 0, failedShell: 0, searches: 0, zeroSearches: 0, globFailures: 0 };
  for (const ev of events) {
    const tools = ev.tool ? [ev.tool] : ev.batch ?? [];
    for (const t of tools) {
      const failed = ev.kind === "post_tool_failure";
      if (failed && t.name === "read") out.failedReads++;
      if (failed && t.name === "edit") out.failedEdits++;
      if (failed && t.name === "shell") out.failedShell++;
      if (failed && t.name === "glob") out.globFailures++;
      if (t.name === "search" || t.name === "glob") {
        out.searches++;
        const text = (t.output?.text ?? "").trim();
        if (!failed && (text === "" || text === "No matches found" || text === "No files found" || text.startsWith("Found 0 "))) out.zeroSearches++;
      }
    }
  }
  return out;
}

async function main(): Promise<void> {
  const qset = resolve(arg("--qset")), sessions = resolve(arg("--sessions")), binary = resolve(arg("--binary")), output = resolve(arg("--output"));
  const sources = JSON.parse(readFileSync(resolve(arg("--sources")), "utf8")) as Record<string, string>;
  const work = resolve(arg("--work", join(output, "work"))), home = join(work, "home"), record = join(home, ".mex");
  mkdirSync(record, { recursive: true });
  const labels = [...rows(join(qset, "sessions", "dev.jsonl")), ...rows(join(qset, "sessions", "test.jsonl"))].filter((label) => sources[label.repo]);
  const projects: Record<string, { project: string; root: string }> = {};
  for (const [repo, root] of Object.entries(sources)) {
    const project = "g-" + createHash("sha256").update(repo).digest("hex").slice(0, 24);
    projects[repo] = { project, root: resolve(root) };
    const started = Date.now();
    await buildIndex({ root: projects[repo]!.root, projectId: project, recordDirectory: record, workers: 0 });
    const location: RecordLocation = { home, directory: record, record: join(record, "record.db"), hooks: join(record, "hooks.db") };
    let fixFiles = 0;
    const facts = await buildCodeFacts(projects[repo]!.root, project, location, undefined, (commits) => {
      writeFixTable(record, project, projects[repo]!.root, commits);
      fixFiles = commits.length;
    });
    writeFactFile(location, project, "code-facts.json", facts);
    const set = await writeWorkingSet({ root: projects[repo]!.root, projectId: project, recordDirectory: record, home, location });
    console.log(`${repo}: index, code facts and working set in ${((Date.now() - started) / 1000).toFixed(1)} s; ${fixFiles} commits read, ${set.hops.length} hops`);
  }
  const surfaces = JSON.stringify(Object.fromEntries(SURFACES.map((s) => [s, "on"])));
  const hook = spawn(binary, ["--delivery-replay"], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, MEX_HOME: home, MEX_TELEMETRY: "0", MEX_DELIVERY_SURFACES: surfaces } });
  const lines = createInterface({ input: hook.stdout });
  const waiting: Array<(value: { reply: { context?: string }; failed: boolean; error?: string }) => void> = [];
  lines.on("line", (line) => waiting.shift()?.(JSON.parse(line)));
  const send = (ev: unknown) => new Promise<{ reply: { context?: string }; failed: boolean; error?: string }>((done) => { waiting.push(done); hook.stdin.write(JSON.stringify(ev) + "\n"); });

  const counts = { sessions: 0, events: 0, failedEvents: 0, triggers: {} as Record<string, number> };
  const examples: Record<string, string[]> = {};
  const failures: string[] = [];
  for (let i = 0; i < labels.length; i++) {
    const label = labels[i]!, target = projects[label.repo]!;
    const file = join(sessions, label.session);
    if (!existsSync(file)) continue;
    const events = convert(await transcript(file), { session: `census-${i}`, project: target.project, checkout: target.root, oldRoot: label.checkout_root, subagent: label.session.includes("/subagents/") }) as Event[];
    // The converter remaps input paths; result text still names the session's
    // old root, so map it too or every result would look outside the checkout.
    const roots = [label.checkout_root!, label.checkout_root!.replaceAll("\\", "/")];
    for (const ev of events) {
      for (const t of ev.tool ? [ev.tool] : ev.batch ?? []) {
        if (t.output?.text) for (const old of roots) t.output.text = t.output.text.split(old).join(target.root);
      }
    }
    counts.sessions++;
    for (const [k, v] of Object.entries(triggers(events))) counts.triggers[k] = (counts.triggers[k] ?? 0) + v;
    for (const ev of events) {
      const r = await send(ev);
      counts.events++;
      if (r.failed) { counts.failedEvents++; if (failures.length < 10) failures.push(r.error ?? "unknown"); }
      for (const block of (r.reply.context ?? "").split(/\n\n(?=\[mex )/)) {
        const text = block.replace(/^\[mex [a-f0-9]+\]\n/, "");
        const kind = text.startsWith("No file at") ? "rescue-wrong-path" : text.startsWith("No matches for") ? "rescue-search"
          : text.startsWith("Not in these results") ? "rescue-wide" : text.startsWith("Glob ") ? "rescue-glob-timeout" : text.startsWith("History:") ? "bug-history" : "";
        if (kind && (examples[kind] ??= []).length < 12) {
          const tools = (ev as Event).tool ? [(ev as Event).tool!] : (ev as Event).batch ?? [];
          const searched = tools.filter((t) => t.name === "search" || t.name === "glob" || t.name === "shell").map((t) => JSON.stringify((t as unknown as { input: unknown }).input).slice(0, 200));
          examples[kind]!.push(`${label.repo}: ${text.split("\n")[0]} <= ${searched.join(" | ")}`);
        }
      }
    }
  }
  hook.stdin.end();
  await new Promise((done) => hook.on("exit", done));

  const ledger: Record<string, unknown> = {};
  for (const [repo, target] of Object.entries(projects)) {
    const report = spawnSync(binary, ["--surfaces"], { input: JSON.stringify({ project: target.project, checkout: target.root }), encoding: "utf8", windowsHide: true, timeout: 10_000,
      env: { ...process.env, MEX_HOME: home, MEX_BACKGROUND: "1", MEX_TELEMETRY: "0" } });
    if (report.status !== 0) throw new Error(report.stderr || report.stdout);
    const parsed = JSON.parse(report.stdout) as { surfaces?: Array<{ surface: string }> };
    ledger[repo] = (parsed.surfaces ?? []).filter((s) => SURFACES.includes(s.surface));
  }
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, "census.json"), JSON.stringify({
    definition: "Saved sessions replayed against the current source checkouts with real file indexes and fix history. Rescue and history surfaces on. The sessions ran without MEX: 'acted' means the agent reached a named file or ran tests on its own within 40 calls, a precision check on the suggestion, not an effect. Paths and history come from today's checkouts, not the sessions' commits.",
    ...counts, failures, examples, ledger,
  }, null, 2) + "\n");
  console.log(JSON.stringify({ ...counts, examples }, null, 2));
}

main().catch((error) => { console.error(error); process.exit(1); });
