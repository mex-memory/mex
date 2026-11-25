import { execFile, spawnSync } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { nativeBinary } from "./check.js";
import { knowledgeProject, type KnowledgeOptions, type KnowledgeProject } from "./context.js";
import { KnowledgeError } from "./contract.js";

type BriefItem = { id: string; line: string; level: string; verdict: string; tokens: number };
type BriefTarget = Pick<KnowledgeProject, "root" | "location" | "projectId">;
const processLimits = { encoding: "utf8" as const, timeout: 5_000, maxBuffer: 512 * 1024, windowsHide: true };

export interface BriefPreview {
  ok: true;
  text: string;
  token_bound: number;
  items: BriefItem[];
  corrections?: BriefItem[];
  coverage: { files: Array<{ path: string; agents: string[]; scope: string[]; ids: string[]; hash: string }> };
}

function checkAgent(agent: string) {
  if (agent !== "claude-code" && agent !== "codex") throw new KnowledgeError("INVALID_AGENT", "Brief previews support claude-code or codex.");
}

const invalidPath = () => new KnowledgeError("INVALID_PATH", "The brief's path must be inside this checkout.");
function relativeBriefPath(root: string, area = ".") {
  const path = relative(root, resolve(root, area)).split("\\").join("/");
  if (path === ".." || path.startsWith("../") || isAbsolute(path)) throw invalidPath();
  return path;
}

function briefCommand(project: BriefTarget, agent: string, path: string, env?: NodeJS.ProcessEnv) {
  const binary = nativeBinary(env);
  if (!binary) throw new KnowledgeError("CHECKS_UNAVAILABLE", "A brief needs MEX's native check evaluator; reinstall MEX or set MEX_HOOK_BINARY.");
  const input = JSON.stringify({
    checkout: project.root, mex_home: project.location.home, record_directory: project.location.directory,
    project_id: project.projectId, agent, path,
  });
  return { binary, input, env: { ...process.env, ...env, MEX_BACKGROUND: "1" } };
}

function readBrief(stdout: string, success: boolean): BriefPreview {
  let parsed: BriefPreview | { ok: false; error?: string };
  try { parsed = JSON.parse(stdout); }
  catch { throw new KnowledgeError("BRIEF_UNAVAILABLE", "The native evaluator gave no brief."); }
  if (!success || !parsed?.ok) throw new KnowledgeError("BRIEF_UNAVAILABLE", "The session-start brief could not be read.");
  return parsed;
}

/** Preview the native hook's projection without registering, recording a
 * delivery, scanning rule files, or rebuilding generated files. */
export function previewBrief(options: KnowledgeOptions, agent: string, area?: string): BriefPreview {
  checkAgent(agent);
  const project = knowledgeProject(options);
  const { binary, input, env } = briefCommand(project, agent, relativeBriefPath(project.root, area), options.env);
  const result = spawnSync(binary, ["--brief-run"], { ...processLimits, input, env });
  return readBrief(result.stdout, !result.error && result.status === 0);
}

async function checkedBriefPath(root: string, area?: string) {
  if (area && /[\x00\r\n]/u.test(area)) throw invalidPath();
  const path = relativeBriefPath(root, area);
  if (!path) return path;
  // The Go runner accepts a normalized checkout-relative path of at most 2 KiB.
  const parts = path.split("/");
  if (Buffer.byteLength(path) > 2048 || path.includes(":") || parts.some(part => !part || part === "." || part === "..")) {
    throw invalidPath();
  }
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        // A dangling or external link cannot prove containment.
        current = await realpath(current).catch(() => { throw invalidPath(); });
        relativeBriefPath(root, current);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw invalidPath();
    }
  }
  return path;
}

/** The Hub already resolved the registration. Run the same evaluator without blocking its event loop. */
export async function previewBriefAsync(
  project: BriefTarget, agent: string, area: string | undefined, options: { env?: NodeJS.ProcessEnv; signal?: AbortSignal },
): Promise<BriefPreview> {
  checkAgent(agent);
  const path = await checkedBriefPath(project.root, area);
  const { binary, input, env } = briefCommand(project, agent, path, options.env);
  options.signal?.throwIfAborted();
  return new Promise((complete, reject) => {
    const child = execFile(binary, ["--brief-run"], { ...processLimits, env, signal: options.signal, killSignal: "SIGKILL" },
      (error, stdout) => {
        try { complete(readBrief(stdout, !error)); }
        catch (error) { reject(error); }
      });
    child.stdin?.on("error", () => { /* The evaluator may exit before reading stdin. */ });
    child.stdin?.end(input);
  });
}
