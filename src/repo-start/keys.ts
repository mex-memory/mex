/**
 * One key from the terminal, for the setup screen's choices: Enter takes the suggested
 * answer, a letter or number picks one. Raw mode where the terminal has it, so no Enter
 * is needed after a letter; a line otherwise. Ctrl+C and a closed input read as "quit",
 * which every caller treats as skipping, never as consent.
 */
import { createInterface, emitKeypressEvents } from "node:readline";

export type Key = "enter" | "quit" | string;

/** `signal` stops waiting (it reads as "quit") and gives the terminal back, so a finished watch never holds the process. */
export async function readKey(input: NodeJS.ReadStream = process.stdin, signal?: AbortSignal): Promise<Key> {
  if (signal?.aborted) return "quit";
  if (!input.isTTY || typeof input.setRawMode !== "function") return readLine(input, signal);
  emitKeypressEvents(input);
  const wasRaw = input.isRaw;
  input.setRawMode(true);
  input.resume();
  try {
    return await new Promise<Key>(resolve => {
      const done = (key: Key) => { input.removeListener("keypress", onKey); input.removeListener("end", onEnd); signal?.removeEventListener("abort", onAbort); resolve(key); };
      const onAbort = () => done("quit");
      signal?.addEventListener("abort", onAbort, { once: true });
      const onEnd = () => done("quit");
      const onKey = (text: string | undefined, key: { name?: string; ctrl?: boolean } | undefined) => {
        if (key?.ctrl && (key.name === "c" || key.name === "d")) return done("quit");
        if (key?.name === "return" || key?.name === "enter") return done("enter");
        if (key?.name === "escape") return done("quit");
        if (text && text.length === 1 && text >= " ") return done(text);
      };
      input.on("keypress", onKey);
      input.once("end", onEnd);
    });
  } finally {
    input.setRawMode(wasRaw ?? false);
    input.pause();
  }
}

async function readLine(input: NodeJS.ReadStream, signal?: AbortSignal): Promise<Key> {
  const reader = createInterface({ input, terminal: false });
  try {
    const answer = await new Promise<string | undefined>(resolve => {
      reader.once("close", () => resolve(undefined));
      reader.once("line", resolve);
      signal?.addEventListener("abort", () => resolve(undefined), { once: true });
    });
    if (answer === undefined) return "quit";
    const trimmed = answer.trim();
    return trimmed === "" ? "enter" : trimmed.slice(0, 1);
  } finally { reader.close(); }
}
