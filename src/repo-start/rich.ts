/**
 * The rich first screen, for a person at a colour terminal at least
 * RICH_MIN_COLUMNS wide: each step ticks live as it runs and settles into an
 * aligned list, then what happens from now on, what to try, and at the end the
 * mascot says what the run found. Everyone else (agents, pipes, NO_COLOR,
 * TERM=dumb, narrow or legacy consoles) gets the plain screen in screen.ts.
 */
import type { Finding } from "./screen.js";
import { formatSeconds, NOTE_EXAMPLE } from "./screen.js";

export const RICH_MIN_COLUMNS = 72;

type Rgb = readonly [number, number, number];
/** Each colour in 24-bit and its nearest xterm-256 entry, for terminals without truecolor. */
const PALETTE = {
  orange: [[232, 132, 92], 173], green: [[94, 140, 90], 65], dgreen: [[70, 116, 68], 22],
  lens: [[24, 24, 24], 234], frame: [[80, 80, 80], 240], paper: [[243, 227, 195], 223], line: [[190, 150, 95], 180],
  ok: [[126, 200, 120], 114], warn: [[240, 190, 85], 221], ink: [[30, 24, 20], 234],
} as const satisfies Record<string, readonly [Rgb, number]>;
type Colour = keyof typeof PALETTE;

function truecolor(env: NodeJS.ProcessEnv): boolean {
  return /truecolor|24bit/iu.test(env.COLORTERM ?? "") || !!env.WT_SESSION
    || /^(?:iTerm\.app|vscode|WezTerm|ghostty)$/iu.test(env.TERM_PROGRAM ?? "");
}
const R = "\x1b[0m", BOLD = "\x1b[1m", DIM = "\x1b[2m";

export class Rich {
  private readonly full: boolean;
  constructor(env: NodeJS.ProcessEnv = process.env, private readonly width = 100) { this.full = truecolor(env); }
  fg(c: Colour): string { const [rgb, n] = PALETTE[c]; return this.full ? `\x1b[38;2;${rgb.join(";")}m` : `\x1b[38;5;${n}m`; }
  bg(c: Colour): string { const [rgb, n] = PALETTE[c]; return this.full ? `\x1b[48;2;${rgb.join(";")}m` : `\x1b[48;5;${n}m`; }
  paint(c: Colour, text: string): string { return `${this.fg(c)}${text}${R}`; }
  dim(text: string): string { return `${DIM}${text}${R}`; }
  bold(text: string): string { return `${BOLD}${text}${R}`; }
  cmd(text: string): string { return this.paint("orange", text); }
  pill(text: string, c: Colour): string { return `${this.bg(c)}${this.fg("ink")}${BOLD} ${text} ${R}`; }

  /** The mascot from mex-mascot.jpg, one letter per pixel, two pixel rows per text row. */
  mascot(): string[] {
    const key: Record<string, Colour> = { G: "green", g: "dgreen", O: "orange", K: "lens", S: "frame", P: "paper", p: "line" };
    const rows: string[] = [];
    for (let y = 0; y < MASCOT.length; y += 2) {
      let line = "";
      for (let x = 0; x < 16; x++) {
        const top = key[MASCOT[y]![x]!], bottom = key[MASCOT[y + 1]?.[x] ?? "."];
        if (!top && !bottom) line += " ";
        else if (top && !bottom) line += `${this.fg(top)}▀${R}`;
        else if (!top && bottom) line += `${this.fg(bottom)}▄${R}`;
        else line += `${this.fg(top!)}${this.bg(bottom!)}▀${R}`;
      }
      rows.push(line);
    }
    return rows;
  }

  /** A rounded speech bubble whose tail points left, at the mascot. */
  bubble(lines: readonly string[]): string[] {
    const w = Math.max(...lines.map(visible)) + 2;
    return [
      this.dim(`╭${"─".repeat(w)}╮`),
      ...lines.map((line, i) => `${this.dim(i === 1 ? "┤" : "│")} ${pad(line, w - 1)}${this.dim("│")}`),
      this.dim(`╰${"─".repeat(w)}╯`),
    ];
  }

  /** One finding as an aligned row: mark, label, text; details as a small table under it. */
  rows(input: readonly Finding[]): string[] {
    const findings = [...input];
    // Read before judged: "Rule files" leads its own "Out of date" row.
    for (let i = 0; i + 1 < findings.length; i++) {
      if (labelled(findings[i]!.text).label === "Out of date" && labelled(findings[i + 1]!.text).label === "Rule files") {
        [findings[i], findings[i + 1]] = [findings[i + 1]!, findings[i]!];
        i++;
      }
    }
    const out: string[] = [];
    for (const finding of findings) {
      let { label, text } = labelled(finding.text);
      const table = this.details(finding.details ?? []);
      if (label === "Out of date" && table.file) text = text.replace(" in your rule files", ` in ${table.file}`);
      const mark = finding.state === "ok" ? this.paint("ok", "✓") : finding.state === "attention" ? this.paint("warn", "!") : this.dim("◌");
      const body = finding.state === "background" ? this.dim(text) : text;
      const first = `${MARGIN}${mark} ${pad(this.bold(label), LABEL)}`;
      const wrapped = wrapText(body, Math.max(30, this.width - visible(first) - 1));
      out.push(first + wrapped[0], ...wrapped.slice(1).map(line => `${INDENT}${line}`), ...table.lines);
    }
    return out;
  }

  /** Notes after the list, quieter, on the same margin. */
  notes(notes: readonly string[]): string[] {
    if (!notes.length) return [];
    const width = Math.max(30, this.width - MARGIN.length - 1);
    return ["", ...notes.flatMap(note => wrapText(note, width).map(line => `${MARGIN}${this.dim(line)}`))];
  }

  /** "path:19  `x`: file not found" lines as a table under one file: "19  x  file not found". */
  private details(details: readonly string[]): { file?: string; lines: string[] } {
    const parsed = details.map(d => /^(.+?):(\d+)\s{2}`([^`]+)`: (.+)$/u.exec(d));
    if (!details.length || parsed.some((m, i) => !m && !details[i]!.startsWith("…"))) return { lines: details.map(d => `${INDENT}${d}`) };
    const files = new Set(parsed.filter(Boolean).map(m => m![1]!));
    const file = files.size === 1 ? [...files][0] : undefined;
    const what = Math.max(...parsed.filter(Boolean).map(m => m![3]!.length));
    const lines: string[] = [];
    for (let i = 0; i < details.length; i++) {
      const m = parsed[i];
      if (!m) {
        const more = /^… and (\d+) more: (.+)$/u.exec(details[i]!);
        lines.push(more ? `${INDENT}  ${this.dim(`+ ${more[1]} more · `)}${this.cmd(more[2]!)}` : `${INDENT}${this.dim(details[i]!)}`);
        continue;
      }
      const where = file ? m[2]!.padStart(4) : `${m[1]}:${m[2]}`;
      lines.push(`${INDENT}${this.dim(where)}  ${m[3]!.padEnd(what)}  ${this.dim(m[4]!)}`);
    }
    return { ...(file ? { file } : {}), lines };
  }

  /** A section of the run: a pill, then a quiet line saying what it is. */
  section(title: string, note?: string): string[] {
    return ["", `${this.pill(title, "paper")}${note ? `  ${this.dim(note)}` : ""}`, ""];
  }

  /** Plain text lines on the step margin, wrapped; quiet when `dim`. */
  text(lines: readonly string[], dim = false): string[] {
    const width = Math.max(30, this.width - MARGIN.length - 1);
    return lines.flatMap(line => wrapText(line, width).map(part => `${MARGIN}${dim ? this.dim(part) : part}`));
  }

  /** The keys a choice takes, on one line: "[Enter] start  [s] skip". */
  keys(keys: ReadonlyArray<readonly [key: string, label: string]>): string {
    return `${MARGIN}${keys.map(([key, label]) => `${this.paint("orange", `[${key}]`)} ${label}`).join("  ")}`;
  }

  /** One setup question: number, text, then its choices and keys. */
  question(input: { index: number; total: number; text: string; choices: ReadonlyArray<{ key: string; label: string }>; suggested?: string }): string[] {
    const width = Math.max(30, this.width - MARGIN.length - 5);
    const [first, ...rest] = wrapText(input.text, width);
    const keys: Array<[string, string]> = input.choices.map(choice => [choice.key, choice.label]);
    const enter = input.choices.find(choice => choice.key === input.suggested);
    return [
      `${MARGIN}${this.paint("orange", `${input.index + 1}/${input.total}`)} ${first}`,
      ...rest.map(line => `${MARGIN}    ${line}`),
      `${this.keys(keys)}  ${this.dim(`· Enter ${enter ? enter.key : "skips"} · s skip · S skip all`)}`,
    ];
  }

  /** The result under a question, on the step margin. */
  answered(state: "ok" | "attention" | "skipped", text: string): string {
    const mark = state === "ok" ? this.paint("ok", "✓") : state === "attention" ? this.paint("warn", "!") : this.dim("–");
    return `${MARGIN}${mark} ${state === "skipped" ? this.dim(text) : text}`;
  }

  next(options: { learning?: string; agents?: readonly string[] }): string[] {
    const learning = options.learning === "on"
      ? `${this.dim("Learning from what you type is on: your agent's smallest model, at most 3% of your usage · off: ")}${this.cmd("mex config set learning.statements off")}`
      : `${this.dim("Learning from what you type is off · ")}${this.cmd("mex config set learning.statements on")}`;
    const agents = options.agents?.length ? options.agents : ["Claude Code", "Codex"];
    return [
      "", this.pill("FROM NOW ON", "green"), "",
      `${MARGIN}Notes you save reach every new ${listNames(agents)} session.`,
      `${MARGIN}A note the code has made false is held back, never sent.`,
      `${MARGIN}${learning}`,
      "", this.pill("TRY IT", "paper"), "",
      `${MARGIN}${this.paint("orange", "1")}  ${this.cmd(NOTE_EXAMPLE)}`,
      `${MARGIN}${this.paint("orange", "2")}  Open ${listNames(agents, "or")} and ask about it`,
    ];
  }

  /** The mascot says what the run found, then the undo line. */
  end(summary: readonly string[]): string[] {
    const left = this.mascot(), right = this.bubble(summary);
    const top = Math.max(0, Math.floor((left.length - right.length) / 2));
    const lw = Math.max(...left.map(visible));
    const lines = Array.from({ length: Math.max(left.length, right.length + top) }, (_, i) => `  ${pad(left[i] ?? "", lw)}  ${right[i - top] ?? ""}`.trimEnd());
    return ["", ...lines, "", `${MARGIN}${this.dim("undo ")}${this.cmd("mex off")}${this.dim(" this repo · ")}${this.cmd("mex uninstall")}${this.dim(" everything")}`, ""];
  }

  header(name: string, hidden: boolean): string[] {
    return [this.pill("MEX", "orange") + `  ${this.bold(name)}  ${this.dim(`· $0${hidden ? " · nothing added to git" : ""}`)}`, ""];
  }

  /** What the mascot says: the time and cost, what the agents get, what needs a look. */
  summary(input: { name: string; ms: number; commandsSaved: boolean; findings: readonly Finding[]; answers?: number; learning?: "queued" | "running" | "waiting" }): string[] {
    if (input.findings.some(f => /^MEX is off everywhere/u.test(f.text))) {
      return [this.bold("MEX is off everywhere, so I read nothing."), `${this.cmd("mex on --all")} turns it back on.`];
    }
    const lines = [this.bold(`Read ${input.name} in ${formatSeconds(input.ms)}, for $0.`)];
    lines.push(input.commandsSaved ? "Your agents now get its test and build commands." : "Notes you save reach your agents from the next session.");
    if (input.answers) lines.push(`Your ${input.answers === 1 ? "answer reaches" : `${input.answers} answers reach`} them as "you said".`);
    if (input.learning) lines.push(`Learn deeper ${input.learning === "running" ? "is running" : "will run"} in the background · ${this.cmd("mex jobs")}`);
    const stale = input.findings.map(f => /^(\d+) lines? in your rule files (?:is|are) out of date/u.exec(f.text)).find(Boolean);
    const attention = input.findings.filter(f => f.state === "attention").length;
    if (stale) lines.push(`${this.paint("warn", `${stale[1]} ${stale[1] === "1" ? "line" : "lines"}`)} in your rule files ${stale[1] === "1" ? "is" : "are"} out of date.`);
    else if (attention) lines.push(`${this.paint("warn", `${attention} ${attention === 1 ? "thing" : "things"}`)} above ${attention === 1 ? "needs" : "need"} a look.`);
    else lines.push("Nothing needs a look. You're set.");
    return lines;
  }
}

/** A spinner on the step running now; cleared when it ends, so its result row takes its place. */
export class RichStep {
  private timer: NodeJS.Timeout | undefined;
  private frame = 0;
  private started = 0;
  constructor(private readonly rich: Rich, private readonly out: (text: string) => void = text => { process.stdout.write(text); }) {}
  async run<T>(label: string, work: () => Promise<T> | T): Promise<T> {
    this.started = Date.now();
    const draw = () => this.out(`\r\x1b[2K${MARGIN}${this.rich.paint("orange", SPIN[this.frame++ % SPIN.length]!)} ${this.rich.dim(`${label}…`)}`);
    draw();
    this.timer = setInterval(draw, 80);
    this.timer.unref();
    try { return await work(); } finally {
      // A step under a blink would flash; hold it just long enough to be seen.
      const left = MIN_STEP_MS - (Date.now() - this.started);
      if (left > 0) await new Promise(resolve => setTimeout(resolve, left));
      clearInterval(this.timer);
      this.out("\r\x1b[2K");
    }
  }
}

const MASCOT = [
  "................", ".....GGGGGG.....", "....GGgGGgGG....", "....GGgGGgGG....",
  ".....GgGGgGG....", "...OOOOOOOOOO..P", "O.OOOKKSSKKOOO.p", "OOOOOKKOOKKOOOOO",
  "...OOOOOOOOOO...", "...OOOOOOOOOO...", "....O.O..O.O....", "....O.O..O.O....",
];
const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const MIN_STEP_MS = 150;
const MARGIN = "   ", LABEL = 13, INDENT = " ".repeat(MARGIN.length + 2 + LABEL);

const visible = (s: string) => s.replace(/\x1b\[[0-9;]*m/gu, "").length;
const pad = (s: string, n: number) => s + " ".repeat(Math.max(0, n - visible(s)));

/** Plain words for each kind of finding the first screen shows. */
export function labelled(text: string): { label: string; text: string } {
  let m: RegExpExecArray | null;
  if ((m = /^Test and build commands for (.+?)(?: \(build (.+?) first\))?((?:; .+?)?)(?: · your agents get .+)?$/u.exec(text))) {
    return { label: "Commands", text: `test and build for ${m[1]}${m[2] ? ` · build ${m[2]} first` : ""}${m[3] ? ` ·${m[3].slice(1)}` : ""}` };
  }
  if ((m = /^(\d+ lines?) in your rule files (.+)$/u.exec(text))) {
    const mixed = / or disagree$/u.test(m[2]!), disagree = /^disagrees?$/u.test(m[2]!);
    return { label: disagree ? "Disagree" : "Out of date", text: `${m[1]} in your rule files${mixed ? " · some disagree" : ""}` };
  }
  if ((m = /^(\d+) rule files? read \((.+)\)(?:; they agree)?$/u.exec(text))) return { label: "Rule files", text: `${m[1]} read · ${m[2]}` };
  if ((m = /^(\d+ notes?) from your (.+?) memory, offered to your agents as hints$/u.exec(text))) return { label: "Agent memory", text: `${m[1]} from ${m[2]}, offered as hints` };
  if ((m = /^Indexed (.+)$/u.exec(text))) return { label: "Your code", text: `${m[1]} indexed` };
  if ((m = /^Git history \((.+?)\):/u.exec(text))) return { label: "Git history", text: `${m[1]} read` };
  if ((m = /^Git history: (.+)$/u.exec(text))) return { label: "Git history", text: m[1]! };
  if ((m = /^Hooks: (.+?), in your user settings\.$/u.exec(text))) return { label: "Hooks", text: m[1]! };
  if (/^No test or build commands found/u.test(text)) return { label: "Commands", text: "none found in package files" };
  if ((m = /^(?:Git history and the file index|The file index): in the background \(`mex jobs`\)(.*)$/u.exec(text))) {
    return { label: "Your code", text: `indexing in the background · mex jobs${m[1] ? ` ·${m[1].replace(/^;/u, "")}` : ""}` };
  }
  if (/^The rest finishes in the background/u.test(text)) return { label: "Your code", text: "the rest finishes in the background · mex jobs" };
  if ((m = /^Learn deeper(?: later)?:? (.+)$/u.exec(text))) return { label: "Learn deeper", text: m[1]! };
  if ((m = /^Code map (?:built|refreshed): (.+)$/u.exec(text))) return { label: "Code map", text: m[1]!.replace(/; /gu, " · ") };
  if ((m = /^The code map was already current(.*)$/u.exec(text))) return { label: "Code map", text: `already current${m[1]!.replace(/; /gu, " · ")}` };
  if (/^Code map: building in the background/u.test(text)) return { label: "Code map", text: "building in the background · mex jobs" };
  if ((m = /^(.+?) didn't finish(.*)$/u.exec(text))) return { label: /history/iu.test(m[1]!) ? "Git history" : /code map/iu.test(m[1]!) ? "Code map" : "Your code", text: `didn't finish${m[2]}` };
  if (/^MEX is off everywhere/u.test(text)) return { label: "MEX", text: "off everywhere, so nothing was read · mex on --all turns it back on" };
  if (/^Couldn't hide \.mex/u.test(text)) return { label: "Git", text: text.replace(/^Couldn't hide \.mex\/ in git's exclude file: /u, "couldn't hide .mex/: ") };
  if (/commands could not be saved|could not be saved for your agents/iu.test(text)) return { label: "Commands", text };
  if (/test commands for|CI step/iu.test(text)) return { label: "Commands", text };
  return { label: "Note", text };
}

/** "Claude Code, Codex and Gemini CLI". */
export function listNames(names: readonly string[], last = "and"): string {
  return names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} ${last} ${names.at(-1)}`;
}

function wrapText(text: string, width: number): string[] {
  if (visible(text) <= width) return [text];
  const words = text.split(" "), lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (line && visible(`${line} ${word}`) > width) { lines.push(line); line = word; }
    else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines;
}
