import { existsSync, lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { createGraphEngine, GraphSourceStagingError } from "./engine-impl.js";
import type { GraphEngine } from "./engine.js";
import {
  boundedCandidateMessage,
  graphCandidateRequest,
  type GraphCandidateMessage,
  type GraphCandidateRequest,
} from "./candidate-protocol.js";
import { startGraphCandidateWatchdog } from "./candidate-watchdog.js";
import { createGraphCandidateProgressSender } from "./candidate-progress.js";
import { flushGraphPhaseTimings } from "./phase-timing.js";

function checkDirectory(path: string, expected: GraphCandidateRequest["workspaceIdentity"]): void {
  const stats = lstatSync(path, { bigint: true });
  if (!stats.isDirectory() || stats.isSymbolicLink()
    || String(stats.dev) !== expected.dev || String(stats.ino) !== expected.ino
    || realpathSync(path) !== expected.realPath) throw new Error("Candidate directory changed.");
}

function checkPaths(request: GraphCandidateRequest): void {
  if (!isAbsolute(request.projectRoot) || !isAbsolute(request.workspace)
    || dirname(request.candidatePath) !== join(request.projectRoot, ".mex")
    || !/^graph\.db\.candidate-[a-f0-9]{32,128}$/u.test(basename(request.candidatePath))) {
    throw new Error("Invalid candidate path.");
  }
  checkDirectory(dirname(request.candidatePath), request.mexIdentity);
  checkDirectory(request.workspace, request.workspaceIdentity);
  const path = relative(realpathSync(request.projectRoot), request.mexIdentity.realPath);
  if (isAbsolute(path) || path === ".." || path.startsWith("../") || path.startsWith("..\\")) {
    throw new Error("Candidate escaped the project.");
  }
  if (existsSync(request.candidatePath)) {
    const stats = lstatSync(request.candidatePath);
    if (!stats.isFile() || stats.isSymbolicLink()) throw new Error("Unsafe candidate file.");
  }
}

function send(message: GraphCandidateMessage): Promise<void> {
  if (!boundedCandidateMessage(message) || !process.send || !process.connected) {
    return Promise.reject(new Error("Invalid candidate protocol state."));
  }
  return new Promise((resolve, reject) => {
    process.send!(message, (error: Error | null) => error ? reject(error) : resolve());
  });
}

function failureCategory(error: unknown): "compatibility" | "staging" | "failed" {
  if (error instanceof GraphSourceStagingError) return "staging";
  const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
  const message = error instanceof Error ? error.message : "";
  if ((error instanceof Error && error.name === "GraphRebuildRequiredError")
    || ["ERR_SQLITE_CORRUPT", "ERR_SQLITE_NOTADB", "ERR_SQLITE_SCHEMA", "SQLITE_CORRUPT", "SQLITE_NOTADB", "SQLITE_SCHEMA"].includes(code.toUpperCase())
    || /(?:database disk image is malformed|file is not a database|malformed database schema|no such (?:table|column)|duplicate column name|unsupported graph schema)/iu.test(message)) {
    return "compatibility";
  }
  return "failed";
}

async function main(): Promise<void> {
  if (!process.send || !process.connected) throw new Error("Candidate construction requires its private parent channel.");
  const stopWatchdog = await startGraphCandidateWatchdog();
  process.once("message", async (raw: unknown) => {
    let engine: GraphEngine | undefined;
    let outcome: GraphCandidateMessage;
    try {
      const request = graphCandidateRequest.parse(raw);
      checkPaths(request);
      const check = () => checkPaths(request);
      engine = createGraphEngine({
        rootDir: request.projectRoot,
        dbPath: request.candidatePath,
        __internalGraphEngineHooks: {
          sourceSpoolDirectory: request.workspace,
          onBuildProgress: createGraphCandidateProgressSender(),
          beforeDatabaseOpen: check,
          afterSemanticInputsStaged: check,
          afterCompilerExtraction: check,
          beforePublication: check,
        },
      } as Parameters<typeof createGraphEngine>[0]);
      const result = request.operation === "refresh" ? await engine.sync([]) : await engine.build();
      flushGraphPhaseTimings(`candidate-${request.operation}`);
      engine.close();
      engine = undefined;
      outcome = { type: "complete", result };
      if (!boundedCandidateMessage(outcome)) throw new Error("Graph result exceeded its private message bound.");
    } catch (error) {
      try { engine?.close(); } catch { /* The supervisor removes the unpublished candidate after close. */ }
      outcome = { type: "failed", category: failureCategory(error) };
    }
    try {
      await send(outcome);
      await stopWatchdog();
      process.exitCode = outcome.type === "complete" ? 0 : 1;
      process.disconnect();
    } catch {
      process.exit(1);
    }
  });
  await send({ type: "ready" });
}

main().catch(() => process.exit(1));
