import { statSync } from "node:fs";
import { join } from "node:path";
import { discoverGraphConfigSources } from "../manifest.js";
import { runGraphEngine, type EngineStagedFile } from "../native-engine.js";

export async function stageEcmaScript(binary: string, root: string, paths: readonly string[], threads = 1) {
  const files: EngineStagedFile[] = [];
  const job = await runGraphEngine(binary, {
    mode: "stage",
    root,
    files: paths.map(path => ({ path, size: statSync(join(root, path)).size })),
    configs: [...discoverGraphConfigSources(root)].map(([path, source]) => ({ path, source })),
    languages: ["typescript", "tsx", "javascript", "jsx"],
    frameworks: true,
    limits: { memoryMb: 512, deadlineMs: 15_000, threads },
  }, {
    onEvent: event => { if (event.type === "staged") files.push(event); },
  });
  if (job.exitCode !== 0 || !job.result || files.length !== paths.length) {
    throw new Error(`Engine stage failed: ${job.error?.message ?? job.exitCode}`);
  }
  return { files };
}
