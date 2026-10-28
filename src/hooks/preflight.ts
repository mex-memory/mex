/** Cheap rejection before the runner, graph or composers are imported. */
import { resolve } from "node:path";
import { bashReads, bashSearchSegment, shellRelative } from "./shell.js";
import { parseApplyPatch } from "./patch.js";
import { hookSwitches } from "./switches.js";
export { hookSwitches } from "./switches.js";

export async function preflightHook(raw: string, cwd: string, projectDir?: string): Promise<boolean> {
  let payload;
  try { payload = JSON.parse(raw); } catch { return false; }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const switches = hookSwitches();
  if (payload.hook_event_name === "Stop") return switches.stop;
  if (payload.hook_event_name === "UserPromptSubmit") return switches.prompt && typeof payload.prompt === "string" && payload.prompt.trim() !== "" && !/^\s*<task-notification>/.test(payload.prompt);
  if (payload.hook_event_name !== "PostToolUse") return false;
  const tool = payload.tool_name;
  const input = payload.tool_input ?? {};
  const response = payload.tool_response;
  const hasOutput = typeof response === "string" ? response.trim() !== "" : response && typeof response === "object" && (
    (typeof response.stdout === "string" && response.stdout.trim() !== "") ||
    (typeof response.content === "string" && response.content.trim() !== "") ||
    (Array.isArray(response.filenames) && response.filenames.length > 0)
  );
  if (tool === "Grep") return switches.grep && Boolean(hasOutput);
  if (tool === "apply_patch") {
    if (!switches.edit || typeof input.command !== "string") return false;
    const { resolveContextRoot } = await import("../context/root.js");
    const root = [projectDir, payload.cwd, cwd].filter((d): d is string => typeof d === "string").map(d => resolveContextRoot(d)).find(Boolean);
    return root !== undefined && root !== null && parseApplyPatch(input.command, root.projectRoot, payload.cwd ?? root.projectRoot).length > 0;
  }
  if (["Edit", "Write", "MultiEdit"].includes(tool)) return switches.edit;
  if (tool === "Bash" && !switches.bash) return false;
  const command = typeof input.command === "string" ? input.command : "";
  if (tool === "Bash" && switches.search && bashSearchSegment(command) !== null && hasOutput) return true;
  if (tool === "Bash" && switches.edit) return true;
  if (!switches.read || !["Read", "Bash"].includes(tool)) return tool === "Bash" && switches.edit;
  const { resolveContextRoot } = await import("../context/root.js");
  const root = [projectDir, payload.cwd, cwd].filter((d): d is string => typeof d === "string" && d !== "").map(d => resolveContextRoot(d)).find(Boolean);
  if (!root) return false;
  const shellCwd = typeof payload.cwd === "string" ? payload.cwd : root.projectRoot;
  const reads = tool === "Bash" ? bashReads(command, shellCwd).map(r => ({ ...r, file: shellRelative(root.projectRoot, resolve(shellCwd, r.file)) })) : typeof input.file_path === "string" ? [{ file: shellRelative(root.projectRoot, input.file_path) }] : [];
  if (reads.length === 0) return false;
  const { loadContextIndex } = await import("../context/index-file.js");
  const index = loadContextIndex(root.localDir).index;
  if (!index) return false;
  const { isValidSessionId, loadShown } = await import("../context/session.js");
  const shown = isValidSessionId(payload.session_id) ? loadShown(root.localDir, payload.session_id) : new Set<string>();
  return index.entities.some(e => e.type === "fact" && !shown.has(e.id) && reads.some(r => r.file !== null && e.code.includes(r.file)));
}
