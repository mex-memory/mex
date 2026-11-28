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
  try {
    input.setRawMode(true);
    return await new Promise<Key>((resolve, reject) => {
      const cleanup = () => {
        input.removeListener("keypress", onKey);
        input.removeListener("end", onEnd);
        input.removeListener("error", onError);
        signal?.removeEventListener("abort", onAbort);
      };
      const done = (key: Key) => { cleanup(); resolve(key); };
      const onAbort = () => done("quit");
      const onEnd = () => done("quit");
      const onError = (error: Error) => { cleanup(); reject(error); };
      const onKey = (text: string | undefined, key: { name?: string; ctrl?: boolean } | undefined) => {
        if (key?.ctrl && (key.name === "c" || key.name === "d")) return done("quit");
        if (key?.name === "return" || key?.name === "enter") return done("enter");
        if (key?.name === "escape") return done("quit");
        if (key?.name === "up" || key?.name === "down" || key?.name === "tab") return done(key.name);
        if (key?.name === "space" || text === " ") return done("space");
        if (text && text.length === 1 && text >= " ") return done(text);
      };
      input.on("keypress", onKey);
      input.once("end", onEnd);
      input.once("error", onError);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (input.readableEnded || signal?.aborted) done("quit");
      else input.resume();
    });
  } finally {
    input.setRawMode(wasRaw ?? false);
    input.pause();
  }
}

/** A numbered menu with ten or more rows needs the complete reply. */
export function readChoiceLine(input: NodeJS.ReadStream = process.stdin): Promise<Key> {
  return readLine(input, undefined, true);
}

async function readLine(input: NodeJS.ReadStream, signal?: AbortSignal, full = false): Promise<Key> {
  const reader = createInterface({ input, terminal: false });
  try {
    const answer = await new Promise<string | undefined>(resolve => {
      reader.once("close", () => resolve(undefined));
      reader.once("line", resolve);
      signal?.addEventListener("abort", () => resolve(undefined), { once: true });
    });
    if (answer === undefined) return "quit";
    const trimmed = answer.trim();
    return trimmed === "" ? "enter" : full ? trimmed : trimmed.slice(0, 1);
  } finally { reader.close(); }
}
