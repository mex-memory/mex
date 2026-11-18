import { spawnSync } from "node:child_process";
import { isAbsolute, relative, resolve } from "node:path";
import { nativeBinary } from "./check.js";
import { knowledgeProject, type KnowledgeOptions } from "./context.js";
import { KnowledgeError } from "./contract.js";

export interface BriefPreview {
  ok: true;
  text: string;
  token_bound: number;
  items: Array<{ id: string; line: string; level: string; verdict: string; tokens: number }>;
  coverage: { files: Array<{ path: string; agents: string[]; scope: string[]; ids: string[]; hash: string }> };
}

/** Preview the native hook's projection without registering, recording a
 * delivery, scanning rule files, or rebuilding generated files. */
export function previewBrief(options: KnowledgeOptions, agent: string, area?: string): BriefPreview {
  if (agent !== "claude-code" && agent !== "codex") throw new KnowledgeError("INVALID_AGENT", "Brief previews support claude-code or codex.");
  const project = knowledgeProject(options);
  const path = relative(project.root, resolve(project.root, area ?? ".")).split("\\").join("/");
  if (path === ".." || path.startsWith("../") || isAbsolute(path)) throw new KnowledgeError("INVALID_PATH", "The brief's path must be inside this checkout.");
  const binary = nativeBinary(options.env);
  if (!binary) throw new KnowledgeError("CHECKS_UNAVAILABLE", "A brief needs MEX's native check evaluator; reinstall MEX or set MEX_HOOK_BINARY.");
  const result = spawnSync(binary, ["--brief-run"], {
    input: JSON.stringify({ checkout: project.root, mex_home: project.location.home, record_directory: project.location.directory, project_id: project.projectId, agent, path }),
    encoding: "utf8", timeout: 5000, maxBuffer: 512 * 1024, windowsHide: true,
    env: { ...process.env, ...options.env, MEX_BACKGROUND: "1" },
  });
  let parsed: BriefPreview | { ok: false; error?: string };
  try { parsed = JSON.parse(result.stdout); }
  catch { throw new KnowledgeError("BRIEF_UNAVAILABLE", "The native evaluator gave no brief."); }
  if (result.error || result.status !== 0 || !parsed.ok) throw new KnowledgeError("BRIEF_UNAVAILABLE", "The session-start brief could not be read.");
  return parsed;
}
