import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import type { RunningMachineHub } from "./serve.js";

/**
 * Runs the Hub for the background process: started when `mex hub` or an open tab asks
 * (background.hub_until in the future), stopped once nobody has asked for `idleMs`. Until
 * then the background process carries no Hub code or memory at all.
 */

/** Old-space cap for the Hub thread; it serves small pages and SQL counts, nothing more. */
export const HUB_WORKER_HEAP_MB = 192;

export interface HubHostOptions {
  readonly home?: string;
  readonly cache?: string;
  readonly log?: (line: string) => void;
}

export class BackgroundHubHost {
  #worker: Worker | undefined;
  #inProcess: RunningMachineHub | undefined;
  #starting: Promise<void> | undefined;
  #failures = 0;
  #retryAt = 0;

  constructor(private readonly options: HubHostOptions = {}) {}

  get running(): boolean { return this.#worker !== undefined || this.#inProcess !== undefined || this.#starting !== undefined; }

  /** Called every loop pass with the lease row's `hub_until`. */
  async tick(hubUntil: string | null, now: number, idleMs: number): Promise<void> {
    const until = hubUntil === null ? Number.NaN : Date.parse(hubUntil);
    const wanted = Number.isFinite(until) && until > now;
    if (wanted && !this.running && now >= this.#retryAt) {
      this.#starting = this.#start(now).finally(() => { this.#starting = undefined; });
      await this.#starting;
    } else if (this.running && !this.#starting && (!Number.isFinite(until) || now > until + idleMs)) await this.stop();
  }

  /** Stops the Hub, waiting for one that is still starting so it never outlives this call. */
  async stop(): Promise<void> {
    if (this.#starting) await this.#starting;
    const worker = this.#worker;
    const inProcess = this.#inProcess;
    this.#worker = undefined;
    this.#inProcess = undefined;
    if (worker) {
      const exited = new Promise<void>((resolve) => worker.once("exit", () => resolve()));
      worker.postMessage("stop");
      const timer = setTimeout(() => void worker.terminate(), 3_000);
      await exited;
      clearTimeout(timer);
    }
    await inProcess?.close();
  }

  async #start(now: number): Promise<void> {
    try {
      const script = workerScript();
      if (script) this.#worker = await this.#startWorker(script);
      else {
        // Running from source (tests): no built worker, so serve on this thread.
        const { startMachineHub } = await import("./serve.js");
        this.#inProcess = await startMachineHub({ home: this.options.home, cache: this.options.cache, mode: "background" });
      }
      this.#failures = 0;
    } catch (error) {
      this.#failures += 1;
      // Back off so a Hub that cannot start never turns the job loop into a spin.
      this.#retryAt = now + Math.min(60_000, 2_000 * 2 ** this.#failures);
      this.options.log?.(`hub: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
    }
  }

  #startWorker(script: string): Promise<Worker> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(script, {
        workerData: { home: this.options.home, cache: this.options.cache },
        resourceLimits: { maxOldGenerationSizeMb: HUB_WORKER_HEAP_MB },
      });
      worker.unref();
      const onMessage = (message: { type?: string; message?: string }) => {
        if (message?.type === "ready") { cleanup(); resolve(worker); }
        else if (message?.type === "error") { cleanup(); reject(new Error(message.message ?? "The Hub could not start.")); }
      };
      const onExit = (code: number) => { cleanup(); reject(new Error(`The Hub thread stopped (code ${code}).`)); };
      const cleanup = () => { worker.off("message", onMessage); worker.off("exit", onExit); };
      worker.on("message", onMessage);
      worker.once("exit", onExit);
      worker.once("exit", () => { if (this.#worker === worker) this.#worker = undefined; });
    });
  }
}

/** The built worker next to the CLI bundle; absent when running from source. */
function workerScript(): string | undefined {
  try {
    const file = fileURLToPath(new URL("./hub-worker.js", import.meta.url));
    return existsSync(file) ? file : undefined;
  } catch {
    return undefined;
  }
}
