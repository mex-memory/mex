import { openRecord } from "../record/index.js";
import { grepSaved, listSavedOutputs, readSavedOutput, savedOutputDirectory } from "./saved.js";

export interface OutOptions { grep?: string; ignoreCase?: boolean; context?: number; json?: boolean; cwd?: string; home?: string }

/** The saved-output folder for the project of a folder, without registering anything. */
function locate(cwd: string, home?: string): string | undefined {
  const writer = openRecord(home ? { home } : {});
  try {
    const row = writer.checkout(cwd);
    return row ? savedOutputDirectory(writer.location.directory, row.project_id) : undefined;
  } finally { writer.close(); }
}

/** `mex out [n] [--grep X]`: list saved outputs, show one, or search one. */
export function runOut(number: string | undefined, options: OutOptions, write: (line: string) => void = (line) => console.log(line)): number {
  const directory = locate(options.cwd ?? process.cwd(), options.home);
  if (!directory) {
    write("MEX isn't on in this folder, so it has saved no output here.");
    return 1;
  }
  if (number === undefined) {
    const saved = listSavedOutputs(directory);
    if (options.json) { write(JSON.stringify(saved, null, 2)); return 0; }
    if (saved.length === 0) { write("No saved output yet. MEX saves a command's full output when it shortens it."); return 0; }
    for (const s of saved.slice(0, 20)) {
      write(`${String(s.n).padStart(4)}  ${s.created_at}  exit ${s.exit_code}  ${s.lines} lines  ${s.command}`);
    }
    if (saved.length > 20) write(`… and ${saved.length - 20} older. Show one with \`mex out <n>\`.`);
    return 0;
  }
  if (!/^\d+$/.test(number)) { write(`Expected the number of a saved output, got "${number}".`); return 1; }
  const found = readSavedOutput(directory, Number(number));
  if (!found) { write(`No saved output ${number} here. \`mex out\` lists what is saved.`); return 1; }
  if (options.grep === undefined) {
    if (options.json) { write(JSON.stringify({ ...found.meta, text: found.text }, null, 2)); return 0; }
    write(found.text.endsWith("\n") ? found.text.slice(0, -1) : found.text);
    return 0;
  }
  const lines = grepSaved(found.text, options.grep, { ignoreCase: options.ignoreCase, context: options.context });
  if (options.json) { write(JSON.stringify(lines, null, 2)); return lines.some((l) => l.match) ? 0 : 1; }
  let last = 0;
  for (const l of lines) {
    if (last && l.line > last + 1) write("--");
    write(`${l.line}${l.match ? ":" : "-"}${l.text}`);
    last = l.line;
  }
  return lines.some((l) => l.match) ? 0 : 1;
}
