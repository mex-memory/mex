import { describe, it, expect } from "vitest";
import { JobRegistry, type Job } from "../src/ui/jobs.js";

const STEPS = [
  { id: "first", label: "First" },
  { id: "second", label: "Second" },
] as const;

/** Resolve once the job reaches a terminal state, or reject after `timeoutMs`. */
function waitForCompletion(jobs: JobRegistry, id: string, timeoutMs = 2000): Promise<Job> {
  return new Promise((resolve, reject) => {
    const existing = jobs.get(id);
    if (existing && existing.status !== "running") {
      resolve(existing);
      return;
    }
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Job ${id} did not finish within ${timeoutMs}ms`));
    }, timeoutMs);
    const unsubscribe = jobs.subscribe(id, (job) => {
      if (job.status === "running") return;
      clearTimeout(timer);
      unsubscribe();
      resolve(job);
    });
  });
}

describe("JobRegistry", () => {
  it("returns a running job with every step declared up front", () => {
    const jobs = new JobRegistry();
    const job = jobs.start("setup", STEPS, async () => "done");

    expect(job.status).toBe("running");
    expect(job.steps.map((s) => s.id)).toEqual(["first", "second"]);
    expect(job.steps.every((s) => s.status === "pending")).toBe(true);
    expect(job.id).toBeTruthy();
  });

  it("records step transitions and the final result", async () => {
    const jobs = new JobRegistry();
    const started = jobs.start("setup", STEPS, async (ctx) => {
      ctx.startStep("first");
      ctx.finishStep("first", "12 files");
      ctx.skipStep("second", "not needed");
      return { count: 12 };
    });

    const job = await waitForCompletion(jobs, started.id);
    expect(job.status).toBe("succeeded");
    expect(job.result).toEqual({ count: 12 });
    expect(job.steps[0]).toMatchObject({ status: "succeeded", detail: "12 files" });
    expect(job.steps[1]).toMatchObject({ status: "skipped", detail: "not needed" });
    expect(job.finishedAt).not.toBeNull();
  });

  it("succeeds overall when a non-fatal step fails", async () => {
    const jobs = new JobRegistry();
    const started = jobs.start("setup", STEPS, async (ctx) => {
      ctx.startStep("first");
      ctx.failStep("first", "graph unavailable");
      ctx.finishStep("second");
      return "continued";
    });

    const job = await waitForCompletion(jobs, started.id);
    expect(job.status).toBe("succeeded");
    expect(job.error).toBeNull();
    expect(job.steps[0].status).toBe("failed");
  });

  it("captures a thrown error and fails the in-flight step", async () => {
    const jobs = new JobRegistry();
    const started = jobs.start("setup", STEPS, async (ctx) => {
      ctx.startStep("first");
      throw new Error("templates missing");
    });

    const job = await waitForCompletion(jobs, started.id);
    expect(job.status).toBe("failed");
    expect(job.error).toBe("templates missing");
    expect(job.steps[0]).toMatchObject({ status: "failed", detail: "templates missing" });
    expect(job.log.at(-1)).toMatchObject({ level: "error", message: "templates missing" });
  });

  it("marks a still-running step succeeded when the body resolves", async () => {
    const jobs = new JobRegistry();
    const started = jobs.start("graph-build", [{ id: "build", label: "Build" }], async (ctx) => {
      ctx.startStep("build");
      return "ok";
    });

    const job = await waitForCompletion(jobs, started.id);
    expect(job.steps[0].status).toBe("succeeded");
    expect(job.steps[0].finishedAt).not.toBeNull();
  });

  it("delivers every state change to subscribers", async () => {
    const jobs = new JobRegistry();
    const seen: string[] = [];
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const started = jobs.start("setup", STEPS, async (ctx) => {
      await gate;
      ctx.log("info", "working");
      ctx.finishStep("first");
      ctx.finishStep("second");
      return null;
    });

    jobs.subscribe(started.id, (job) => seen.push(job.status));
    release();
    await waitForCompletion(jobs, started.id);

    // Three progress emissions while running, then the terminal one.
    expect(seen.length).toBeGreaterThanOrEqual(4);
    expect(seen.at(-1)).toBe("succeeded");
  });

  it("stops notifying after unsubscribe", async () => {
    const jobs = new JobRegistry();
    let calls = 0;
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const started = jobs.start("setup", STEPS, async (ctx) => {
      await gate;
      ctx.finishStep("first");
      return null;
    });

    const unsubscribe = jobs.subscribe(started.id, () => {
      calls += 1;
    });
    unsubscribe();
    release();
    await waitForCompletion(jobs, started.id);

    expect(calls).toBe(0);
  });

  it("ignores progress calls for unknown step ids", async () => {
    const jobs = new JobRegistry();
    const started = jobs.start("setup", STEPS, async (ctx) => {
      ctx.startStep("does-not-exist");
      ctx.finishStep("does-not-exist");
      return "fine";
    });

    const job = await waitForCompletion(jobs, started.id);
    expect(job.status).toBe("succeeded");
  });

  it("does not run the body before start() returns", async () => {
    const jobs = new JobRegistry();
    let ran = false;
    const job = jobs.start("setup", STEPS, async () => {
      ran = true;
      return null;
    });
    expect(job.status).toBe("running");
    expect(job.steps.every((step) => step.status === "pending")).toBe(true);
    expect(ran).toBe(false);
    await waitForCompletion(jobs, job.id);
    expect(ran).toBe(true);
  });

  it("lists jobs newest first", async () => {
    const jobs = new JobRegistry();
    const first = jobs.start("setup", STEPS, async () => null);
    const second = jobs.start("graph-build", STEPS, async () => null);
    await Promise.all([
      waitForCompletion(jobs, first.id),
      waitForCompletion(jobs, second.id),
    ]);

    expect(jobs.list().map((job) => job.id)).toEqual([second.id, first.id]);
  });

  it("updates a running step's detail and progress", async () => {
    const jobs = new JobRegistry();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const seen: Array<{ detail: string | null; progress: { done: number; total: number } | null }> = [];

    const started = jobs.start("graph-build", [{ id: "build", label: "Build" }], async (ctx) => {
      ctx.startStep("build", "Starting…");
      await gate;
      ctx.updateStep("build", "Extracting — 10/100", { done: 10, total: 100 });
      ctx.finishStep("build", "100 files");
      return null;
    });

    jobs.subscribe(started.id, (job) => {
      const step = job.steps[0]!;
      seen.push({ detail: step.detail, progress: step.progress });
    });
    release();
    const job = await waitForCompletion(jobs, started.id);
    expect(job.steps[0]).toMatchObject({ status: "succeeded", detail: "100 files", progress: null });
    expect(seen.some((entry) => entry.detail === "Extracting — 10/100" && entry.progress?.done === 10)).toBe(true);
  });
});
