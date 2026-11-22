// JSONL client for one resident Rust graph engine.
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { spawnGraphEngine, writeEngineRequest, type EngineEvent, type EngineRequest,
  type EngineRequestConfig, type EngineRequestFile, type GraphEngineBuildMetadata } from "./native-engine.js";

export interface ServeRequest extends Omit<EngineRequest, "mode" | "output"> {
  mode: "serve";
  overlay?: string;
}

export interface ServeEdit {
  output: string;
  files: EngineRequestFile[];
  deleted: string[];
  configs?: EngineRequestConfig[];
  sourceDirectory?: string;
  buildMetadata: GraphEngineBuildMetadata;
  walkObservation?: string;
}

export interface ServeStamp {
  path: string;
  identity: string | null;
  directory: boolean;
}

type ServeResult = Extract<EngineEvent, { type: "result" }> & { id: number };
type Reply = ServeResult | { type: "ready" }
  | { type: "verified"; id: number; matches: boolean; wallMs: number }
  | { type: "accepted" | "discarded"; id: number };

const REPLY_TIMEOUT_MS = 120_000;
const CLOSE_TIMEOUT_MS = 1_000;
type Child = ReturnType<typeof spawnGraphEngine>;

export class NativeGraphServer {
  private nextId = 0;
  private closing = false;
  private exited = false;
  private problem: Error | undefined;
  private waiting: {
    type: Reply["type"]; id: number | undefined; resolve: (reply: Reply) => void;
    reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>;
  } | undefined;

  private constructor(private readonly child: Child, requestPath: string) {
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      try {
        const event = JSON.parse(line) as Reply | Extract<EngineEvent, { type: "error" }>;
        if (event.type === "error") {
          this.stop(new Error(event.message));
          return;
        }
        const waiting = this.waiting;
        if (event.type !== waiting?.type || ("id" in event ? event.id : undefined) !== waiting.id) {
          throw new Error("Unexpected resident graph engine reply.");
        }
        this.waiting = undefined;
        clearTimeout(waiting.timer);
        waiting.resolve(event);
      } catch (error) { this.stop(error instanceof Error ? error : new Error(String(error))); }
    });
    child.stderr.resume();
    child.stdin.on("error", (error) => this.stop(error));
    child.on("error", (error) => { this.problem ??= error; });
    child.on("close", (code, signal) => {
      this.exited = true;
      lines.close();
      try { rmSync(requestPath, { force: true }); } catch { /* the temporary is private */ }
      const waiting = this.waiting;
      this.waiting = undefined;
      if (waiting) {
        clearTimeout(waiting.timer);
        waiting.reject(this.problem ?? new Error(`Resident graph engine exited (${signal ?? code}).`));
      }
    });
  }

  static async open(binary: string, directory: string, request: ServeRequest): Promise<NativeGraphServer> {
    const requestPath = join(directory, `mex-graph-serve-${process.pid}-${randomBytes(8).toString("hex")}.json`);
    writeEngineRequest(requestPath, request);
    const server = new NativeGraphServer(spawnGraphEngine(binary, "serve", requestPath), requestPath);
    await server.send("start\n", "ready");
    rmSync(requestPath, { force: true });
    return server;
  }

  get pid(): number | undefined { return this.child.pid; }
  get live(): boolean { return !this.closing && !this.exited; }

  async edit(input: ServeEdit): Promise<ServeResult> {
    const id = ++this.nextId;
    const result = await this.command({ type: "edit", id, ...input }, "result") as ServeResult;
    if ([result.files, result.nodes, result.edges, result.shadowedFiles, result.filesReextracted]
      .some(value => typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
      || !Number.isFinite(result.usage?.wallMs) || result.usage.wallMs < 0) {
      throw new Error("Invalid resident graph engine result.");
    }
    return result;
  }

  async verify(id: number, stamps: ServeStamp[]): Promise<{ matches: boolean; wallMs: number }> {
    const reply = await this.command({ type: "verify", id, stamps }, "verified");
    if (reply.type !== "verified" || typeof reply.matches !== "boolean" || !Number.isFinite(reply.wallMs)) {
      throw new Error("Invalid resident graph verification reply.");
    }
    return reply;
  }

  async accept(id: number, overlay: string): Promise<void> {
    await this.command({ type: "accept", id, overlay }, "accepted");
  }

  async discard(id: number): Promise<void> {
    await this.command({ type: "discard", id }, "discarded");
  }

  close(): void {
    if (!this.live) return;
    this.closing = true;
    this.child.stdin.end('{"type":"close"}\n');
    const timer = setTimeout(() => {
      if (!this.exited) this.child.kill("SIGKILL");
    }, CLOSE_TIMEOUT_MS);
    timer.unref();
  }

  private stop(error: Error): void {
    this.problem ??= error;
    this.closing = true;
    if (!this.exited) this.child.kill("SIGKILL");
  }

  private command(frame: { type: string; id: number; [field: string]: unknown }, expected: Reply["type"]): Promise<Reply> {
    return this.send(`${JSON.stringify(frame)}\n`, expected, frame.id);
  }

  private send(message: string, type: Reply["type"], id?: number): Promise<Reply> {
    if (!this.live || this.waiting) return Promise.reject(this.problem ?? new Error("The resident graph engine is unavailable."));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.stop(new Error(`Resident graph engine timed out waiting for ${type}.`)), REPLY_TIMEOUT_MS);
      timer.unref();
      this.waiting = { type, id, timer, resolve, reject };
      this.child.stdin.write(message);
    });
  }
}
