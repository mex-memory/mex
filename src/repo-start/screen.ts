/**
 * The first screen: one header line, one
 * line per finding, then short notes. Lines with nothing found are left out by
 * the caller, not here.
 *
 * Plain mode (no terminal on stdout, NO_COLOR, TERM=dumb, or a window under 60
 * columns) prints the same lines with ASCII marks, no colour and no cursor
 * movement, wrapped to the window when its width is known. Legacy Windows
 * consoles get ASCII marks as well.
 */

export type FindingState = "ok" | "background" | "attention";
export interface Finding { state: FindingState; text: string; details?: string[]; }
export interface ScreenModel {
  name: string;
  /** Measured from command start to the screen. */
  ms: number;
  /** Cost of the free setup. */
  costUsd: number;
  /** True only when MEX's block is in the exclude file, so nothing it wrote shows in `git status`. */
  hidden: boolean;
  findings: Finding[];
  notes: string[];
}
export interface ScreenMode { plain: boolean; ascii: boolean; color: boolean; width: number | undefined; }

export const PLAIN_BELOW_COLUMNS = 72;

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
  cyan: (text: string) => `\x1b[36m${text}\x1b[39m`,
};
/** Rich lines sit under the header with this margin; plain lines have none. */
const MARGIN = "  ";

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

/** The header names the repository. */
export function renderHeader(model: Pick<ScreenModel, "name"> & Partial<Pick<ScreenModel, "ms" | "costUsd" | "hidden">>, mode: ScreenMode): string[] {
  const dot = mode.ascii ? " - " : " · ";
  const lines = wrapHeader(["MEX", model.name], dot, mode.width);
  if (!mode.color) return lines;
  return lines.map((line, index) => {
    if (index > 0 || !line.startsWith(`MEX${dot}${model.name}`)) return paint.dim(line);
    const rest = line.slice(`MEX${dot}${model.name}`.length);
    return `${paint.bold(paint.cyan("MEX"))}${paint.dim(dot)}${paint.bold(model.name)}${rest ? paint.dim(rest) : ""}`;
  });
}

/** One line per finding: a mark, then the text, wrapped with a hanging indent. */
export function renderFindings(findings: readonly Finding[], mode: ScreenMode): string[] {
  const lines: string[] = [];
  const margin = mode.color ? MARGIN : "";
  const width = mode.width === undefined ? undefined : mode.width - margin.length;
  for (const finding of findings) {
    const mark = MARKS[finding.state][mode.ascii ? 1 : 0];
    const wrapped = wrap(`${mark} ${finding.text}`, width, mark.length + 1);
    const details = (finding.details ?? []).flatMap(detail => wrap(`    ${mode.ascii ? detail.replace(/…/gu, "...") : detail}`, width, 4));
    if (!mode.color) { lines.push(...wrapped, ...details); continue; }
    if (finding.state === "background") { for (const line of wrapped) lines.push(margin + paint.dim(line)); continue; }
    const style = finding.state === "ok" ? paint.green : paint.yellow;
    lines.push(margin + style(mark) + wrapped[0]!.slice(mark.length));
    lines.push(...wrapped.slice(1).map(line => margin + line));
    lines.push(...details.map(line => margin + line));
  }
  return lines;
}

/** Notes after the findings, quieter. */
export function renderNotes(notes: readonly string[], mode: ScreenMode): string[] {
  const margin = mode.color ? MARGIN : "";
  const width = mode.width === undefined ? undefined : mode.width - margin.length;
  return notes.flatMap(note => wrap(note, width, CONTINUATION_INDENT).map(line => mode.color ? margin + paint.dim(line) : line));
}

/** The closing line once the work `mex` waited for is done. */
export function renderDone(ms: number, mode: ScreenMode): string[] {
  const text = `Done in ${formatSeconds(ms)}${mode.ascii ? " - " : " · "}$0`;
  return mode.color ? ["", MARGIN + paint.dim(text)] : [text];
}

/**
 * The first note a person tries. It is their own fact: setup already gives the
 * agents everything the repo's files say, such as its test command, so a note
 * repeating one of those would show nothing. Double quotes keep `<` and `>`
 * literal in every shell, cmd.exe included.
 */
export const NOTE_EXAMPLE = 'mex note "<something your agents keep getting wrong here, and why>"';
export const STATEMENTS_ON = "mex config set learning.statements on";
export const STATEMENTS_OFF = "mex config set learning.statements off";
export const STATEMENTS_INTRO = 'MEX can also learn from what you tell your agents, like "we use pnpm here".';
export const STATEMENTS_USAGE = "it uses your agent's smallest model, within 3% of your plan.";
export const UNDO_LINE = "To undo: mex off turns MEX off in this repo · mex uninstall removes MEX from this computer.";

export function renderNext(options: { short: boolean; learning?: string; agents?: readonly string[]; hooksOff?: boolean; summary?: readonly string[] }, mode: ScreenMode): string[] {
  // Without the native hook nothing reaches an agent, so nothing here may promise it.
  if (options.hooksOff) return renderNotes([
    "Nothing reaches your agents yet: MEX's native hook is missing. Reinstall MEX, then run mex install.",
    ...(options.summary ? ["", ...options.summary, "", UNDO_LINE] : []),
  ], mode);
  if (options.short) return renderNotes(['Saved notes reach new sessions; mex note "<fact>" adds one.'], mode);
  // Learning from typed statements is opt-in; anything but "on" is off.
  const learning = options.learning === "on"
    ? `${STATEMENTS_INTRO} It's on now: ${STATEMENTS_USAGE} Turn it off with ${STATEMENTS_OFF}.`
    : `${STATEMENTS_INTRO} It's off now. Turn it on with ${STATEMENTS_ON}: ${STATEMENTS_USAGE}`;
  const agents = options.agents?.length ? options.agents : ["Claude Code", "Codex"];
  const names = (last: string) => agents.length <= 1 ? agents.join("") : `${agents.slice(0, -1).join(", ")} ${last} ${agents.at(-1)}`;
  return renderNotes([
    "", `From now on, in ${names("and")}`,
    "· Notes you save reach every new session. A note the code has made false is held back.", `· ${learning}`,
    "", "Try it", `  ${NOTE_EXAMPLE}`,
    `  Then start a new ${names("or")} session and ask about it.`,
    ...(options.summary ? ["", ...options.summary] : []), "", UNDO_LINE,
  ].map(line => mode.ascii ? line.replace(/·/gu, "-").replace(/…/gu, "...") : line), mode);
}

export function renderScreen(model: ScreenModel, mode: ScreenMode): string[] {
  return [
    ...renderHeader(model, mode),
    ...(mode.color && model.findings.length ? [""] : []),
    ...renderFindings(model.findings, mode),
    ...renderNotes(model.notes, mode),
  ];
}

const SPINNER = { unicode: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], ascii: ["|", "/", "-", "\\"] };
const BAR_WIDTH = 20;

/** One live line: a spinner, the step, and a bar when the total is known. Never wider than the window. */
export function progressLine(step: string, detail: string | undefined, fraction: number | undefined, frame: number, mode: ScreenMode): string {
  const spin = (mode.ascii ? SPINNER.ascii : SPINNER.unicode)[frame % (mode.ascii ? SPINNER.ascii.length : SPINNER.unicode.length)]!;
  let bar = "";
  if (fraction !== undefined) {
    const filled = Math.max(0, Math.min(BAR_WIDTH, Math.round(fraction * BAR_WIDTH)));
    const [on, off] = mode.ascii ? ["#", "-"] : ["━", "─"];
    bar = `  ${paint.cyan(on.repeat(filled))}${paint.dim(off.repeat(BAR_WIDTH - filled))}`;
  }
  const text = `${MARGIN}${paint.cyan(spin)} ${step}${bar}${detail ? `  ${paint.dim(detail)}` : ""}`;
  const visible = text.replace(/\x1b\[[0-9;]*m/gu, "");
  // Too wide for the window: drop the detail, then the bar, so the line never wraps (a wrapped live line can't be redrawn).
  if (mode.width !== undefined && visible.length >= mode.width) {
    const short = `${MARGIN}${paint.cyan(spin)} ${step}`;
    return short.replace(/\x1b\[[0-9;]*m/gu, "").length < mode.width ? short : short.slice(0, mode.width - 1);
  }
  return text;
}

/**
 * A line redrawn in place while `mex` waits on its own work, only in a colour terminal. The
 * spinner turns on a timer; `update` changes the words. `stop` clears it, so the result lines
 * that follow take its place.
 */
export class LiveLine {
  private frame = 0;
  private timer: NodeJS.Timeout | undefined;
  private step = "";
  private detail: string | undefined;
  private fraction: number | undefined;
  constructor(private readonly mode: ScreenMode, private readonly out: (text: string) => void = text => { process.stdout.write(text); }) {}
  start(step: string): void {
    this.step = step; this.detail = undefined; this.fraction = undefined;
    this.draw();
    this.timer ??= setInterval(() => { this.frame++; this.draw(); }, 90);
  }
  update(detail: string | undefined, fraction?: number): void { this.detail = detail; this.fraction = fraction; this.draw(); }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.out("\r\x1b[2K");
  }
  private draw(): void { this.out(`\r\x1b[2K${progressLine(this.step, this.detail, this.fraction, this.frame, this.mode)}`); }
}
