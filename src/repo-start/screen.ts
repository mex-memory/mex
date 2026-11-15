/**
 * The first screen: one header line with the measured time and the cost, one
 * line per finding, then short notes. Lines with nothing found are left out by
 * the caller, not here.
 *
 * Plain mode (no terminal on stdout, NO_COLOR, TERM=dumb, or a window under 60
 * columns) prints the same lines with ASCII marks, no colour and no cursor
 * movement, wrapped to the window when its width is known. Legacy Windows
 * consoles get ASCII marks as well.
 */

export type FindingState = "ok" | "background" | "attention";
export interface Finding { state: FindingState; text: string; }
export interface ScreenModel {
  name: string;
  /** Measured from command start to the screen. */
  ms: number;
  /** Always zero here; the screen shows it so the cost is never a guess. */
  costUsd: number;
  /** True only when MEX's block is in the exclude file, so nothing it wrote shows in `git status`. */
  hidden: boolean;
  findings: Finding[];
  notes: string[];
}
export interface ScreenMode { plain: boolean; ascii: boolean; color: boolean; width: number | undefined; }

export const PLAIN_BELOW_COLUMNS = 60;

export interface ScreenModeInput {
  env?: NodeJS.ProcessEnv;
  stdoutTTY?: boolean;
  columns?: number;
  platform?: NodeJS.Platform;
}

/** Windows consoles outside Windows Terminal, VS Code and other modern hosts may not draw Unicode marks. */
function legacyConsole(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): boolean {
  return platform === "win32" && !env.WT_SESSION && !env.TERM_PROGRAM && !env.ConEmuANSI && !env.TERM;
}

export function screenMode(input: ScreenModeInput = {}): ScreenMode {
  const env = input.env ?? process.env;
  const tty = input.stdoutTTY ?? process.stdout.isTTY === true;
  const columns = input.columns ?? (tty ? process.stdout.columns : undefined);
  const width = tty && columns && columns > 0 ? columns : undefined;
  const noColor = env.NO_COLOR !== undefined && env.NO_COLOR !== "";
  const plain = !tty || noColor || env.TERM === "dumb" || (width !== undefined && width < PLAIN_BELOW_COLUMNS);
  return { plain, ascii: plain || legacyConsole(env, input.platform ?? process.platform), color: !plain, width };
}

const MARKS: Record<FindingState, [unicode: string, ascii: string]> = {
  ok: ["✓", "ok"],
  background: ["◌", ".."],
  attention: ["!", "!!"],
};
const paint = {
  bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
  dim: (text: string) => `\x1b[2m${text}\x1b[22m`,
  green: (text: string) => `\x1b[32m${text}\x1b[39m`,
  yellow: (text: string) => `\x1b[33m${text}\x1b[39m`,
};

export function formatSeconds(ms: number): string {
  const seconds = Math.max(0, ms) / 1000;
  return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} s`;
}

/** Break on spaces; a word longer than the room is cut so no line exceeds the width. */
export function wrap(text: string, width: number | undefined, indent: number): string[] {
  if (!width || text.length <= width) return [text];
  const room = Math.max(10, width);
  const lines: string[] = [];
  let line = "";
  const push = () => { lines.push(line); line = " ".repeat(indent); };
  for (const word of text.split(" ")) {
    let rest = word;
    while (rest.length > 0) {
      const sep = line.trim() === "" ? "" : " ";
      if (line.length + sep.length + rest.length <= room) { line += sep + rest; rest = ""; }
      else if (line.trim() === "") { const take = room - line.length; line += rest.slice(0, take); rest = rest.slice(take); push(); }
      else push();
    }
  }
  if (line.trim() !== "") lines.push(line);
  return lines;
}

/** Hanging indent for a header or note that runs onto more lines. */
const CONTINUATION_INDENT = 4;

/** The header breaks only between its parts, so "nothing added to git" never splits; long parts still wrap. */
function wrapHeader(parts: readonly string[], dot: string, width: number | undefined): string[] {
  const whole = parts.join(dot);
  if (!width || whole.length <= width) return [whole];
  const pad = " ".repeat(CONTINUATION_INDENT);
  const lines: string[] = [];
  let line = "";
  for (const part of parts) {
    if (line === "") { line = part; continue; }
    if (line.length + dot.length + part.length <= width) { line += dot + part; continue; }
    lines.push(line);
    line = pad + part;
  }
  lines.push(line);
  // Only a continuation line can be too long (a part longer than the window): wrap its text under the indent.
  return lines.flatMap(text => text.length <= width ? [text]
    : wrap(text.slice(CONTINUATION_INDENT), width - CONTINUATION_INDENT, 0).map(part => pad + part));
}

export function renderScreen(model: ScreenModel, mode: ScreenMode): string[] {
  const dot = mode.ascii ? " - " : " · ";
  const parts = ["MEX", model.name, formatSeconds(model.ms), `$${model.costUsd.toFixed(model.costUsd === 0 ? 0 : 2)}`]
    .concat(model.hidden ? ["nothing added to git"] : []);
  const lines: string[] = [];
  const add = (text: string, indent: number, style?: (text: string) => string) => {
    for (const line of wrap(text, mode.width, indent)) lines.push(style && mode.color ? style(line) : line);
  };
  for (const line of wrapHeader(parts, dot, mode.width)) lines.push(mode.color ? paint.bold(line) : line);
  for (const finding of model.findings) {
    const mark = MARKS[finding.state][mode.ascii ? 1 : 0];
    const text = `${mark} ${finding.text}`;
    if (!mode.color) { add(text, mark.length + 1); continue; }
    const wrapped = wrap(text, mode.width, mark.length + 1);
    if (finding.state === "background") { for (const line of wrapped) lines.push(paint.dim(line)); continue; }
    const style = finding.state === "ok" ? paint.green : paint.yellow;
    lines.push(style(mark) + wrapped[0]!.slice(mark.length));
    lines.push(...wrapped.slice(1));
  }
  for (const note of model.notes) add(note, CONTINUATION_INDENT, paint.dim);
  return lines;
}
