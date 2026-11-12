import { spawn } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
import { registerJobKind, type BatchResult } from "./jobs.js";
import { refreshOwnUsage, type OwnUsageOptions } from "./own-usage.js";

/**
 * Built-in job kinds. Later tickets add theirs (learning, judging, graph builds) the
 * same way; see the rules at the top of jobs.ts.
 */

/** Reads the person's own agent usage in bounded batches until it has caught up. */
registerJobKind<OwnUsageOptions, { runs: number }>({
  name: "own-usage",
  label: "Usage refresh",
  scope: "machine",
  machineExclusive: true,
  // The reader commits its own cursors and is safe to run twice from any point.
  sideEffects: "idempotent",
  runBatch({ writer, params, checkpoint }) {
    const statuses = refreshOwnUsage(writer, params ?? {});
    const runs = (checkpoint?.runs ?? 0) + 1;
    const pending = statuses.some((status) => status.status === "partial");
    const files = statuses.reduce((sum, status) => sum + status.files, 0);
    return {
      checkpoint: { runs }, results: files, done: !pending,
      gaps: !pending && statuses.some((status) => status.status === "unreadable"),
      progress: pending ? "reading your agent logs" : null,
      summary: statuses.map((status) => `${status.agent}: ${status.status}`).join(", "),
    } as BatchResult<{ runs: number }>;
  },
});

/**
 * A job for demos and tests only: batches with a delay, an optional induced failure and an
 * optional wait condition. Registered only when MEX_JOBS_DEMO=1, so it never shows up in
 * normal use.
 */
export interface DemoParams {
  batches?: number; delayMs?: number; failAt?: number;
  /** While this file exists, the job waits. */
  waitFile?: string;
  /** Each batch start is appended here, so tests can count redone batches. */
  traceFile?: string;
}
export function demoJobsEnabled(): boolean { return process.env.MEX_JOBS_DEMO === "1"; }
if (demoJobsEnabled()) {
  registerJobKind<DemoParams, { next: number }>({
    name: "demo",
    label: "Demo job",
    scope: "project",
    sideEffects: "idempotent",
    async runBatch({ params, checkpoint }) {
      const total = Math.max(1, Math.floor(params.batches ?? 5));
      const batch = checkpoint?.next ?? 0;
      if (params.traceFile) appendFileSync(params.traceFile, `${batch}\n`);
      if (params.waitFile && existsSync(params.waitFile)) {
        return { checkpoint: { next: batch }, wait: "Waiting for the test condition to clear", progress: `batch ${batch + 1} of ${total}` };
      }
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, params.delayMs ?? 200)));
      if (params.failAt !== undefined && batch === params.failAt) throw new Error(`Demo failure at batch ${batch + 1}`);
      const next = batch + 1;
      return { checkpoint: { next }, results: 1, summary: `batch ${next}`, done: next >= total, progress: `batch ${Math.min(next + 1, total)} of ${total}` };
    },
    ready(job) {
      const params = JSON.parse(job.params || "{}") as DemoParams;
      return !params.waitFile || !existsSync(params.waitFile);
    },
  });
}

/**
 * Compares tsrs with tsgo on one whole repository and keeps the verdict in
 * the record (settings, scope = project id, key `typescript.server-check`).
 * Graph builds read it: tsrs builds the repository only once this check
 * agreed, and a later disagreement moves it back to tsgo. The comparison runs
 * in its own `mex __typescript-check` process, so the compilers and their
 * memory stay out of the long-lived background process.
 */
registerJobKind<{ root: string; entry?: string }, Record<string, never>>({
  name: "typescript-server-check",
  label: "TypeScript compiler check",
  scope: "project",
  // Writing the same verdict twice changes nothing.
  sideEffects: "idempotent",
  async runBatch({ job, params, writer }) {
    const output = await new Promise<string>((resolvePromise, reject) => {
      const child = spawn(process.execPath, [params.entry ?? process.argv[1]!, "__typescript-check", params.root], {
        env: { ...process.env, MEX_BACKGROUND: "1" }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
      child.on("error", reject);
      child.on("close", (code) => code === 0 ? resolvePromise(stdout)
        : reject(new Error(`The TypeScript compiler check exited with ${code}: ${stderr.trim().split(/\r?\n/u).at(-1) ?? ""}`)));
    });
    const verdict = JSON.parse(output.trim().split(/\r?\n/u).at(-1)!) as { server: "tsrs" | "tsgo"; reason?: string };
    if (job.project_id) {
      writer.db.prepare("INSERT INTO settings(scope,key,value) VALUES(?,?,?) ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value")
        .run(job.project_id, "typescript.server-check", JSON.stringify(verdict));
    }
    return {
      checkpoint: {},
      done: true,
      results: 1,
      summary: verdict.server === "tsrs" ? "tsrs matches tsgo on the whole repository" : verdict.reason ?? "tsgo chosen",
    };
  },
});
