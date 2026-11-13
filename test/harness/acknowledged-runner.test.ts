import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const cli = join(repo, "node_modules/vitest/vitest.mjs");
const run = promisify(execFile);

it("waits for a real controller acknowledgement before the next fixture", async () => {
  mkdirSync(join(repo, "test-results"), { recursive: true });
  const root = mkdtempSync(join(repo, "test-results", "runner-ack-"));
  try {
    async function probe(acknowledged: boolean): Promise<{ code: number; output: string }> {
      const fixture = join(root, acknowledged ? "acknowledged" : "control");
      mkdirSync(fixture);
      const marker = join(fixture, "acknowledged.txt");
      writeFileSync(join(fixture, "package.json"), JSON.stringify({ type: "module" }));
      writeFileSync(join(fixture, "reporter.mjs"), `
        import { writeFileSync } from 'node:fs';
        import { setTimeout } from 'node:timers/promises';
        export default class DelayedAcknowledgement {
          delayed = false;
          async onTaskUpdate(packs) {
            if (!this.delayed && packs.some(([, result]) => result?.state === 'run')) {
              this.delayed = true;
              await setTimeout(500);
              writeFileSync(${JSON.stringify(marker)}, 'acknowledged');
            }
          }
        }
      `);
      writeFileSync(join(fixture, "probe.test.mjs"), `
        import { it } from 'vitest';
        import { existsSync } from 'node:fs';
        import { setTimeout } from 'node:timers/promises';
        it('first fixture', async () => { await setTimeout(150); });
        it('next fixture', () => {
          if (!existsSync(${JSON.stringify(marker)})) throw new Error('fixture advanced before controller acknowledgement');
        });
      `);
      writeFileSync(join(fixture, "vitest.config.mjs"), `export default ${JSON.stringify({
        root: fixture,
        cacheDir: join(fixture, "cache"),
        test: {
          include: ["probe.test.mjs"],
          setupFiles: [join(repo, "test/harness/runner-yield.ts")],
          reporters: ["default", join(fixture, "reporter.mjs")],
          ...(acknowledged ? { runner: join(repo, "test/harness/acknowledged-runner.ts") } : {}),
          maxWorkers: 1,
          minWorkers: 1,
        },
      })};`);
      try {
        const result = await run(process.execPath, [cli, "run", "--config", join(fixture, "vitest.config.mjs")], {
          cwd: fixture, timeout: 20_000, maxBuffer: 1 << 20,
        });
        return { code: 0, output: result.stdout + result.stderr };
      } catch (error) {
        const result = error as { code?: number | string; stdout?: string; stderr?: string };
        return { code: typeof result.code === "number" ? result.code : -1, output: (result.stdout ?? "") + (result.stderr ?? "") };
      }
    }
    const control = await probe(false);
    expect(control.code, control.output).toBe(1);
    expect(control.output).toContain("fixture advanced before controller acknowledgement");
    const acknowledged = await probe(true);
    expect(acknowledged.code, acknowledged.output).toBe(0);
    expect(acknowledged.output).toContain("2 passed");
  } finally {
    if (readdirSync(root, { recursive: true, withFileTypes: true }).some((entry) => entry.isSymbolicLink())) {
      throw new Error("Refusing to remove a linked runner fixture");
    }
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
