import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type crossSpawn from "cross-spawn";
import { expect, it, vi } from "vitest";
import { launchHeadlessSetupPopulation } from "../headless-population.js";

it.each([true, false])("uses stdout inactivity rather than elapsed time (active=%s)", async active => {
  const root = mkdtempSync(join(tmpdir(), "inactivity-"));
  mkdirSync(join(root, ".mex"));
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
  let spawned!: () => void;
  const started = new Promise<void>(resolve => { spawned = resolve; });
  vi.useFakeTimers();
  const run = launchHeadlessSetupPopulation({ selectedTools: ["codex"], prompt: "test", projectRoot: root,
    __internal: { isAvailable: async () => true, spawn: (() => { spawned(); return child; }) as unknown as typeof crossSpawn } });
  void run.catch(() => {});
  try {
    await started;
    if (active) {
      for (let i = 0; i < 5; i++) {
        await vi.advanceTimersByTimeAsync(10 * 60_000);
        child.stdout.write('{"type":"unknown-record"}\n');
      }
      child.stdout.write('{"type":"turn.completed"}\n');
      child.emit("close", 0, null);
      await expect(run).resolves.toMatchObject({ completed: true });
    } else {
      await vi.advanceTimersByTimeAsync(15 * 60_000);
      child.emit("close", null, "SIGKILL");
      await expect(run).rejects.toThrow("no activity for 15 minutes");
    }
  } finally { vi.useRealTimers(); rmSync(root, { recursive: true, force: true }); }
});

