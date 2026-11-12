import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { requestJson } from "./http.mjs";
import { runMaintenanceJob } from "./hub.mjs";
import { createProcessTreeAccumulator, parseLinuxStat, parsePsSnapshot, startProcessTreeSampler } from "./process-tree.mjs";
import { createGraphCharacterizationFixture } from "./graph-fixture.mjs";

const row = (pid, ppid, cpuMs, rssBytes, started = "start") => ({ pid, ppid, cpuMs, rssBytes, started });

describe("process tree measurements", () => {
  it("counts descendants, preserves exited CPU, excludes unrelated processes and handles PID reuse", () => {
    const accumulator = createProcessTreeAccumulator(10);
    expect(accumulator.add([row(10, 1, 100, 20), row(99, 1, 900, 999)]).cpuMs).toBe(0);
    expect(accumulator.add([row(10, 1, 110, 22), row(11, 10, 30, 40), row(12, 11, 5, 8), row(99, 1, 990, 999)]))
      .toEqual({ rssBytes: 70, peakRssBytes: 70, cpuMs: 45, maxProcesses: 3, sampleCount: 2 });
    expect(accumulator.add([row(10, 1, 120, 20), row(12, 1, 8, 8)]).cpuMs).toBe(58);
    expect(accumulator.add([row(10, 1, 120, 20), row(11, 10, 4, 10, "new")]).cpuMs).toBe(62);
  });

  it("rejects missing roots and malformed/unbounded samples instead of reporting zero", () => {
    const accumulator = createProcessTreeAccumulator(10);
    expect(() => accumulator.add([row(11, 1, 0, 0)])).toThrow(/disappeared/u);
    expect(() => accumulator.add([row(10, 1, NaN, 0)])).toThrow(/Invalid/u);
    expect(() => accumulator.add(Array.from({ length: 257 }, (_, index) => row(10 + index, index ? 10 : 1, 0, 0))))
      .toThrow(/256/u);
    const reused = createProcessTreeAccumulator(10);
    reused.add([row(10, 1, 0, 0)]);
    expect(() => reused.add([row(10, 1, 0, 0, "reused")])).toThrow(/root PID was reused/u);
  });

  it("decodes Linux stat without splitting command names and macOS elapsed CPU formats", () => {
    const fields = Array(22).fill("0");
    fields[0] = "S"; fields[1] = "10"; fields[11] = "123"; fields[12] = "7";
    fields[19] = "456"; fields[21] = "100";
    expect(parseLinuxStat(`11 (node (helper)) ${fields.join(" ")}`, { ticks: 100, pageBytes: 4096 }))
      .toEqual(row(11, 10, 1300, 409600, "456"));
    expect(parsePsSnapshot("  11 10 Wed Sep  9 02:00:00 2026 1-02:03:04.50 400\n"))
      .toEqual([row(11, 10, 93_784_500, 409600, "Wed Sep 9 02:00:00 2026")]);
  });

  it("surfaces timer sampling failures and closes the source", async () => {
    let reads = 0;
    let closed = false;
    const sampler = await startProcessTreeSampler(10, { intervalMs: 1, source: {
      read() { if (reads++) throw new Error("sampling failed"); return [row(10, 1, 0, 20)]; },
      close() { closed = true; },
    } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await expect(sampler.stop()).rejects.toThrow("sampling failed");
    expect(closed).toBe(true);
  });

  it("includes a live descendant working set on the host platform", async () => {
    const child = spawn(process.execPath, ["-e", `
      const {spawn}=require('node:child_process');
      process.on('message', message => {
        if(message==='spawn') {
          const nested=spawn(process.execPath,['-e', "global.kept=Buffer.alloc(8*1024*1024,1);process.send('ready');setInterval(()=>{},1000)"],{stdio:['ignore','ignore','ignore','ipc']});
          nested.once('message',()=>process.send('ready'));
          process.on('disconnect',()=>{nested.kill();process.exit()});
        }
      });
      process.send('started');
    `], { stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true });
    let sampler;
    try {
      await once(child, "message");
      sampler = await startProcessTreeSampler(child.pid);
      const initial = await sampler.sample();
      const ready = once(child, "message");
      child.send("spawn");
      await ready;
      // The Windows stream can have one snapshot queued before the spawn.
      let final;
      for (let attempt = 0; attempt < 10; attempt += 1) {
        final = await sampler.sample();
        if (final.maxProcesses > initial.maxProcesses) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      // Windows also attaches a conhost.exe descendant to the console child, so
      // compare with the initial tree instead of assuming one process per node.
      expect(final.maxProcesses).toBe(initial.maxProcesses + 1);
      expect(final.peakRssBytes).toBeGreaterThan(initial.peakRssBytes + 4 * 1024 * 1024);
    } finally {
      try { await sampler?.stop(); }
      finally {
        const exited = once(child, "exit");
        child.disconnect();
        await exited;
      }
    }
  }, 15_000);
});

describe("graph characterization fixture", () => {
  it("reproduces mixed compiler ownership, dependency types and the large-body input deterministically", () => {
    const work = mkdtempSync(join(tmpdir(), "mex-graph-fixture-test-"));
    try {
      const first = createGraphCharacterizationFixture(join(work, "a"));
      const second = createGraphCharacterizationFixture(join(work, "b"));
      expect(first.digest).toBe(second.digest);
      expect(first.sourceFiles).toBe(180);
      expect(first.configFiles).toBe(5);
      expect(first.inferredFiles).toBe(20);
      const changedSource = readFileSync(join(first.root, first.mutableSource), "utf8");
      expect(changedSource.length).toBeGreaterThan(100_000);
      expect(changedSource).toContain("value += 101; // characterization-state:A");
      expect(readFileSync(join(first.root, "node_modules/@benchmark/model/index.d.ts"), "utf8")).toContain("Model127");
      const smoke = createGraphCharacterizationFixture(join(work, "smoke"), { smoke: true });
      expect(smoke.sourceFiles).toBe(10);
      expect(smoke.projects).toBe(first.projects);
      expect(() => createGraphCharacterizationFixture(first.root)).toThrow(/new fixture/u);
    } finally { rmSync(work, { recursive: true, force: true }); }
  });
});

describe("bounded benchmark HTTP", () => {
  async function withServer(handler, run) {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try { await run(`http://127.0.0.1:${server.address().port}`); }
    finally { server.closeAllConnections(); server.close(); await once(server, "close"); }
  }

  it("bounds a server that never sends headers", async () => {
    await withServer(() => {}, async (url) => {
      await expect(requestJson(url, {}, { timeoutMs: 50 })).rejects.toThrow(/exceeded/u);
    });
  });

  it("keeps the deadline active after headers arrive", async () => {
    await withServer((_, response) => { response.writeHead(200, { "content-type": "application/json" }); response.write('{"pending":'); }, async (url) => {
      await expect(requestJson(url, {}, { timeoutMs: 50 })).rejects.toThrow(/exceeded/u);
    });
  });

  it("shares one job deadline across creation and a stalled event stream", async () => {
    let requests = 0;
    let startedAt;
    await withServer((request, response) => {
      requests += 1;
      if (request.method === "POST") {
        startedAt = performance.now();
        setTimeout(() => response.end(JSON.stringify({
          id: "job_01ARZ3NDEKTSV4RRFFQ69G5FAV", scaffoldId: "test", kind: "graph_rebuild",
          generation: 1, phase: "queued", progress: null, state: "queued", cancelRequested: false,
          createdAt: "2026-08-23T00:00:00.000Z", revision: "a".repeat(64),
        })), 40);
      } else {
        expect(request.url).toBe("/api/v1/jobs/job_01ARZ3NDEKTSV4RRFFQ69G5FAV/events");
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(": heartbeat\n\n");
      }
    }, async (origin) => {
      await expect(runMaintenanceJob({ origin, child: { pid: process.pid } }, { csrfToken: "test" }, "graph_rebuild", { timeoutMs: 150 }))
        .rejects.toThrow(/exceeded|did not settle/u);
      expect(requests).toBe(2);
      expect(performance.now() - startedAt).toBeLessThan(1_500);
    });
  }, 15_000);

  it("stops an oversized streaming body before buffering the entire response", async () => {
    await withServer((_, response) => { response.writeHead(200); response.end(" ".repeat(2 * 1024 * 1024 + 1)); }, async (url) => {
      await expect(requestJson(url)).rejects.toThrow(/exceeded 2097152 bytes/u);
    });
  });

  it("returns parsed JSON and the response metadata", async () => {
    await withServer((_, response) => { response.writeHead(201); response.end('{"ok":true}'); }, async (url) => {
      const value = await requestJson(url);
      expect(value.response.status).toBe(201);
      expect(value.body).toEqual({ ok: true });
    });
  });
});
