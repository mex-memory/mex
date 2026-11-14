import { appendFileSync, existsSync } from "node:fs";
import crossSpawn from "cross-spawn";
import { openRecord } from "../../../record/index.js";
import { enqueueJob, registerJobKind, requeueReadyJobs, runOneBatch } from "../../../record/jobs.js";
import { runModel } from "../../index.js";
import { acquireModelAdmission, ModelWaitError } from "../../budget-queue.js";
import { REFERENCE_BATCH } from "../../budget-prices.js";

const [mode, projectRoot, trace, barrier, identity] = process.argv.slice(2);
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const agent = Number(identity) % 2 ? "codex" : "claude";
const model = agent === "claude" ? "opus" : "gpt-6.1-sol";
const spawn = ((_command: string, _args: string[], options: Parameters<typeof crossSpawn>[2]) => crossSpawn(process.execPath, ["-e", `
const fs=require('node:fs'); const trace=${JSON.stringify(trace)};
const log=kind=>fs.appendFileSync(trace,JSON.stringify({kind,pid:process.pid})+String.fromCharCode(10));
process.stdin.resume();log('start');setTimeout(()=>{
 log('end');const events=${JSON.stringify(agent === "claude"
  ? [{ type: "result", subtype: "success", result: "synthetic", usage: { input_tokens: 4000, output_tokens: 1000 } }]
  : [{ type: "item.completed", item: { type: "agent_message", text: "synthetic" } }, { type: "turn.completed", usage: { input_tokens: 4000, output_tokens: 1000 } }])};
 for(const event of events)process.stdout.write(JSON.stringify(event)+String.fromCharCode(10));
},200);`], options)) as typeof crossSpawn;
const call = () => runModel({ agent, prompt: "Synthetic task", projectRoot, purpose: "test.concurrent",
  ...(mode === "explicit" ? {} : { automatic: { estimate: { ...REFERENCE_BATCH } } }), __internal: { spawn } });
while (!existsSync(barrier)) await pause(10);
if (mode === "crash") {
  const batch = await acquireModelAdmission({ agent, model, projectPath: projectRoot, automatic: { estimate: { ...REFERENCE_BATCH } } });
  process.stdout.write(JSON.stringify({ admitted: batch!.id }) + "\n");
  setInterval(() => {}, 1000);
} else if (mode === "job") {
  const writer = openRecord({ projectPath: projectRoot });
  try {
    const kind = `synthetic-${identity}`;
    registerJobKind({ name: kind, label: "Synthetic model work", scope: "project", sideEffects: "none", async runBatch() {
      await call(); return { checkpoint: 1, done: true };
    } });
    const job = enqueueJob(writer, { kind, projectId: writer.checkout(projectRoot)!.project_id }).job;
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      requeueReadyJobs(writer);
      await runOneBatch(writer, `foreground:${process.pid}:test`);
      const state = writer.db.prepare("SELECT state FROM jobs WHERE id=?").get(job.id)!.state;
      if (state === "done") { process.stdout.write(JSON.stringify({ ok: true })); break; }
      if (state === "failed" || Date.now() + 20 >= deadline) throw new Error("Synthetic job did not finish.");
      await pause(20);
    }
  } finally { writer.close(); }
} else {
  const deadline = Date.now() + 8000;
  while (true) {
    try { await call(); process.stdout.write(JSON.stringify({ ok: true })); break; }
    catch (error) {
      if (error instanceof ModelWaitError && error.reason === "queue" && Date.now() < deadline) { await pause(25); continue; }
      if (error instanceof ModelWaitError) { process.stdout.write(JSON.stringify({ held: error.reason })); break; }
      throw error;
    }
  }
}
