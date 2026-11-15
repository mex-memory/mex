import { KnowledgeError } from "./entry.js";

/** Input bound for the hook's request: a project path and one typed note. */
const MAX_INPUT = 64 * 1024;

export interface HookNoteResult { ok: boolean; id?: string; message?: string; }

/**
 * `mex note: ...` typed in a session. The hook shim runs `node <cli>
 * __hook-note` with `{"project","text"}` on stdin and shows the person one
 * line. The note goes through the same writer and gates as `mex note`; no AI.
 */
export async function hookNote(input: string): Promise<HookNoteResult> {
  let request: { project?: unknown; text?: unknown };
  try { request = JSON.parse(input) as typeof request; } catch { return { ok: false, message: "MEX couldn't read the note." }; }
  if (typeof request.project !== "string" || typeof request.text !== "string" || !request.project || !request.text.trim()) {
    return { ok: false, message: "MEX couldn't read the note." };
  }
  try {
    const { note } = await import("./store.js");
    const saved = note({ text: request.text }, { projectPath: request.project });
    const { queueNativeRebuild } = await import("./native-queue.js");
    queueNativeRebuild(request.project);
    return { ok: true, id: saved.entry.mex.id };
  } catch (error) {
    if (error instanceof KnowledgeError) return { ok: false, message: `MEX didn't save that note: ${error.message}` };
    return { ok: false, message: "MEX couldn't save the note: knowledge storage could not be written." };
  }
}

export async function runHookNote(): Promise<void> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += (chunk as Buffer).length;
    if (size > MAX_INPUT) { console.log(JSON.stringify({ ok: false, message: "That note is too long for a session; use `mex note`." })); return; }
    chunks.push(chunk as Buffer);
  }
  console.log(JSON.stringify(await hookNote(Buffer.concat(chunks).toString("utf8"))));
}
