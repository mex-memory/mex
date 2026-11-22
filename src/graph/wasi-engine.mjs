// Run the trusted, bundled engine with Node's WASI Preview 1 host. The main
// thread owns the start barrier and can enforce limits while Wasm is running.
import { readFileSync, rmSync } from "node:fs";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { WASI } from "node:wasi";

async function run({ module, mode, request, preopens }) {
  const args = ["mex-graph", mode];
  if (request) args.push("--request", request);
  const wasi = new WASI({ version: "preview1", args, preopens, returnOnExit: true });
  const compiled = await WebAssembly.compile(readFileSync(module));
  const instance = await WebAssembly.instantiate(compiled, wasi.getImportObject());
  return wasi.start(instance);
}

async function supervise(invocation) {
  const { deadlineMs, memoryMb, output, hostRequest } = invocation;
  const started = performance.now();
  let worker;
  let sample;
  let finishing = false;
  const deadline = setTimeout(() => void finish(4, "graph_deadline"), deadlineMs);

  async function finish(code, reason) {
    if (finishing) return;
    finishing = true;
    clearInterval(sample);
    clearTimeout(deadline);
    process.stdin.pause();
    if (worker) await worker.terminate();
    if (code !== 0) {
      if (output) {
        for (const suffix of ["", "-journal", "-wal", "-shm"]) rmSync(output + suffix, { force: true });
      }
      rmSync(hostRequest, { force: true });
    }
    process.exitCode = code;
    if (reason === "graph_parent_gone") return;
    const stats = process.resourceUsage();
    const usage = {
      wallMs: Math.round(performance.now() - started),
      cpuMs: Math.round((stats.userCPUTime + stats.systemCPUTime) / 1000),
      peakRssMb: Math.ceil(stats.maxRSS / 1024),
    };
    if (reason) console.log(JSON.stringify({ type: "error", code: reason, message: "The WASI host stopped the graph job." }));
    console.log(JSON.stringify({ type: "usage", usage }));
  }

  let barrier = "";
  process.stdin.on("data", (chunk) => {
    if (worker || finishing) return;
    barrier += chunk.toString("utf8");
    if ("start\n".startsWith(barrier) && barrier !== "start\n") return;
    if (barrier !== "start\n") { void finish(5, "graph_parent_gone"); return; }
    worker = new Worker(new URL(import.meta.url), { workerData: invocation });
    worker.once("message", (code) => void finish(code));
    worker.once("error", (error) => { console.error(error.message); void finish(6, "graph_wasi_failed"); });
    worker.once("exit", () => void finish(6, "graph_wasi_failed"));
    sample = setInterval(() => {
      if (process.memoryUsage.rss() > memoryMb * 1024 ** 2) void finish(3, "graph_memory_limit");
    }, 10);
  });
  process.stdin.once("end", () => void finish(5, "graph_parent_gone"));
  process.stdin.once("error", () => void finish(5, "graph_parent_gone"));
}

if (!isMainThread) {
  parentPort.postMessage(await run(workerData));
} else {
  const [module, mode, options] = process.argv.slice(2);
  const invocation = { module, mode, ...JSON.parse(options ?? "{}") };
  if (mode === "version") process.exitCode = await run(invocation);
  else await supervise(invocation);
}
