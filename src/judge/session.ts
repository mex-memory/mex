import { lstatSync } from "node:fs";
import { join } from "node:path";
import { openHooksReadOnly, type RecordWriter } from "../record/index.js";
import { shortHash } from "../record/project.js";

/** The pause mirror covers the interval before Go commits its session row. */
export function sessionWorkEnabled(writer: Pick<RecordWriter, "location">, agent: string, sessionId?: string): boolean {
  if (!sessionId) return true;
  const host = agent === "claude" ? "claude-code" : agent;
  try { lstatSync(join(writer.location.directory, "hook-paused", shortHash(`${host}\0${sessionId}`))); return false; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false; }
  let hooks: ReturnType<typeof openHooksReadOnly>;
  try {
    hooks = openHooksReadOnly({ home: writer.location.home });
    if (!hooks) return true;
    if (hooks.diagnostic) return false;
    const session = hooks.get<{ agent: string; paused: number }>("SELECT agent,paused FROM sessions WHERE session_id=?", sessionId);
    return !session || (session.agent === host && session.paused === 0);
  } catch { return false; }
  finally { hooks?.close(); }
}
