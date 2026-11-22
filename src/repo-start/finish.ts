/**
 * Finishing the free step: `mex` waits for its own deterministic work (the file index and the
 * code facts from git history) with live progress, then shows what it found. Measured on a
 * Windows laptop: Hono 3 s, django 11 s, novu 21 s. The jobs stay in MEX's queue the whole
 * time, so stopping early (Ctrl+C, or the time cap) hands them to the background process and
 * nothing is lost.
 */
import type { RecordWriter } from "../record/index.js";
import type { JobRow } from "../record/jobs.js";
import { LiveLine, type Finding, type ScreenMode } from "./screen.js";
import type { CodeFactsFile } from "./history/job.js";

export interface FinishJob {
  id: string;
  kind: "file-index" | "code-facts" | "graph-build";
  /** Run here only when the file index found at most SMALL_MAP_FILES files; otherwise the background process builds it. */
  smallOnly?: true;
}
/**
 * The code map finishes on screen up to this many indexed files; a bigger repo keeps building
 * in the background (novu takes about 450 s) and never holds the screen.
 */
export const SMALL_MAP_FILES = 3_000;
/** Test-only: a lower bound, so a fixture counts as big. */
function smallMapFiles(): number {
  const value = Number(process.env.MEX_TEST_SMALL_MAP_FILES);
  return process.env.MEX_TEST_SMALL_MAP_FILES !== undefined && Number.isInteger(value) && value >= 0 ? value : SMALL_MAP_FILES;
}
export interface FinishOptions {
  writer: RecordWriter;
  projectId: string;
  jobs: readonly FinishJob[];
  mode: ScreenMode;
  /** Redraw a progress line in place (a colour terminal); otherwise print only the results. */
  live: boolean;
  /** Stop waiting after this long and leave the rest to the background process. */
  capMs: number;
  /** Test-only: called once the first job reports progress. */
  onFirstProgress?: () => void;
  /** Lets a caller stop waiting (Ctrl+C); resolves when it wants to stop. */
  interrupt?: Promise<void>;
}
export interface FinishResult {
  findings: Finding[];
  /** Stopped before the work was done; the background process takes it over. */
  handedOff: boolean;
  /** Stopped by the caller (Ctrl+C) rather than the time cap. */
  interrupted: boolean;
}

const STEP: Record<FinishJob["kind"], string> = { "file-index": "Indexing files", "code-facts": "Reading git history", "graph-build": "Building the code map" };
const WHAT: Record<FinishJob["kind"], string> = { "file-index": "The file index", "code-facts": "Git history", "graph-build": "The code map" };
const TERMINAL = new Set(["done", "done with gaps", "failed", "cancelled"]);
const POLL_MS = 200;
const count = (n: number) => n.toLocaleString("en-US");

/** The result lines for finished jobs, in the order they ran. */
export function resultFindings(rows: readonly JobRow[], facts: CodeFactsFile | undefined, summaries: ReadonlyMap<string, string> = new Map()): Finding[] {
  const findings: Finding[] = [];
  for (const row of rows) {
    if (row.state === "failed" || row.state === "cancelled") {
      const what = WHAT[row.kind as FinishJob["kind"]] ?? "Git history";
      findings.push({ state: "attention", text: `${what} didn't finish${row.reason ? `: ${row.reason}` : ""} (\`mex jobs\`)` });
      continue;
    }
    if (row.kind === "graph-build") {
      // The job's own summary: "Code map built: 640 files, 4,210 definitions; 12 notes now checked by code fingerprint".
      const summary = summaries.get(row.id);
      findings.push({ state: row.state === "done with gaps" ? "attention" : "ok", text: summary && /^(?:The )?[Cc]ode map/u.test(summary) ? summary : `Code map built${summary ? `: ${summary}` : ""}` });
      continue;
    }
    if (row.kind === "file-index") {
      findings.push({ state: "ok", text: `Indexed ${count(row.results)} ${row.results === 1 ? "file" : "files"}${row.state === "done with gaps" ? ", some couldn't be read" : ""}` });
    } else if (facts?.skipped === "no commits") {
      findings.push({ state: "ok", text: "Git history: no commits yet" });
    } else if (facts && !facts.skipped) {
      const pairs = new Set(facts.change_together.map(pair => [pair.a, pair.b].sort().join("\0"))).size;
      const parts = [
        pairs ? `${count(pairs)} file ${pairs === 1 ? "pair changes" : "pairs change"} together` : "no files change together often enough yet",
        ...(facts.layer_rules.length ? [`${count(facts.layer_rules.length)} layer ${facts.layer_rules.length === 1 ? "rule" : "rules"}`] : []),
        ...(facts.generated.length ? [`${count(facts.generated.length)} generated ${facts.generated.length === 1 ? "file" : "files"}`] : []),
      ];
      findings.push({ state: "ok", text: `Git history (${count(facts.commits_read)} ${facts.commits_read === 1 ? "commit" : "commits"}): ${parts.join(", ")}` });
    }
  }
  return findings;
}

export async function finishWork(options: FinishOptions): Promise<FinishResult> {
  const { ownerId, recoverInterruptedJobs, releaseJobs, runOneBatch } = await import("../record/jobs.js");
  const { writer } = options;
  const self = ownerId("foreground");
  // A run killed while it waited left its jobs running under a dead process: queue them again.
  recoverInterruptedJobs(writer, self);
  const only = new Set(options.jobs.map(job => job.id));
  /** Jobs this run leaves to the background process (a big repo's code map). */
  const background = new Set<string>();
  const indexed = () => {
    const index = options.jobs.find(job => job.kind === "file-index");
    const found = index && row(index.id);
    return found && TERMINAL.has(found.state) ? found.results : undefined;
  };
  const row = (id: string) => writer.db.prepare("SELECT * FROM jobs WHERE id=?").get(id) as unknown as JobRow | undefined;
  const live = options.live ? new LiveLine(options.mode) : undefined;
  let stopped = false, interrupted = false;
  const stop = new Promise<"stop">(resolve => {
    const timer = setTimeout(() => resolve("stop"), options.capMs);
    timer.unref();
    void options.interrupt?.then(() => { interrupted = true; resolve("stop"); });
  });
  void stop.then(() => { stopped = true; });
  let shown: string | undefined, firstProgress = true;
  const show = (job: FinishJob) => { if (shown !== job.id) { shown = job.id; live?.start(STEP[job.kind]); } };
  try {
    for (;;) {
      if (stopped) break;
      const pending = options.jobs.filter(job => !TERMINAL.has(row(job.id)?.state ?? "done") && !background.has(job.id));
      if (!pending.length) break;
      // The code map waits for the index, which says how big the repo is: a big one goes to the background.
      if (pending[0]!.smallOnly && (indexed() ?? Infinity) > smallMapFiles()) {
        background.add(pending[0]!.id); only.delete(pending[0]!.id);
        continue;
      }
      const next = pending[0]!;
      show(next);
      const ran = runOneBatch(writer, self, {
        only,
        onProgress: (job, text) => {
          if (firstProgress) { firstProgress = false; options.onFirstProgress?.(); }
          const match = /^([\d,]+) of ([\d,]+)/u.exec(text);
          const fraction = match ? Number(match[1]!.replace(/,/gu, "")) / Math.max(1, Number(match[2]!.replace(/,/gu, ""))) : undefined;
          show(options.jobs.find(item => item.id === job.id) ?? next);
          live?.update(text, fraction);
        },
      });
      const outcome = await Promise.race([ran, stop]);
      if (outcome === "stop") break;
      if (outcome === "idle") {
        // Held elsewhere (the background process) or waiting: show its progress until it finishes.
        live?.update(row(next.id)?.progress ?? (row(next.id)?.state === "running" ? "running in the background process" : "waiting"));
        await Promise.race([new Promise(resolve => setTimeout(resolve, POLL_MS)), stop]);
      }
    }
  } finally { live?.stop(); }

  const summaries = new Map<string, string>();
  for (const job of options.jobs) {
    const found = writer.db.prepare("SELECT summary FROM job_results WHERE job_id=? ORDER BY batch DESC LIMIT 1").get(job.id) as { summary: string } | undefined;
    if (found) summaries.set(job.id, found.summary);
  }
  const later: Finding[] = [];
  if (background.size) {
    const { ensureBackground } = await import("../record/background.js");
    try { ensureBackground(); } catch { /* the next command starts it */ }
    later.push({ state: "background", text: "Code map: building in the background (`mex jobs`)" });
  }
  const rows = options.jobs.filter(job => !background.has(job.id)).map(job => row(job.id)).filter((item): item is JobRow => !!item);
  if (rows.some(item => !TERMINAL.has(item.state))) {
    releaseJobs(writer, self);
    const { ensureBackground } = await import("../record/background.js");
    try { ensureBackground(); } catch { /* the next command starts it */ }
    const done = rows.filter(item => TERMINAL.has(item.state));
    const facts = await readFacts(options);
    return {
      findings: [
        ...resultFindings(done, facts, summaries), ...later,
        { state: "background", text: "The rest finishes in the background (`mex jobs` shows it)" },
      ],
      handedOff: true, interrupted,
    };
  }
  return { findings: [...resultFindings(rows, await readFacts(options), summaries), ...later], handedOff: false, interrupted: false };
}

async function readFacts(options: FinishOptions): Promise<CodeFactsFile | undefined> {
  if (!options.jobs.some(job => job.kind === "code-facts")) return undefined;
  const { readFactFile } = await import("./facts.js");
  return readFactFile<CodeFactsFile>(options.writer.location, options.projectId, "code-facts.json");
}
