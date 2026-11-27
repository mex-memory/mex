import { readChoiceLine, readKey } from "./keys.js";
import { MARGIN, pad, Rich, visible, wrappedRows, wrapText } from "./rich.js";
import { screenMode } from "./screen.js";
import { stripVTControlCharacters } from "node:util";

type Write = (text: string) => void;
const writeStdout: Write = text => { process.stdout.write(text); };

/** The terminal reflows soft-wrapped rows when its width changes. */
export function terminalRows(lines: readonly string[], columns: number): number {
  return lines.reduce((rows, line) => rows + wrappedRows(line, Math.max(1, columns)), 0);
}

export class TerminalBlock {
  private lines: readonly string[] = [];

  constructor(
    private readonly write: Write = writeStdout,
    private readonly columns = () => process.stdout.columns || 100,
  ) {}

  private rewind(): string {
    const rows = terminalRows(this.lines, this.columns());
    return rows ? `\x1b[${rows}A\r\x1b[0J` : "";
  }

  draw(lines: readonly string[]): void {
    const next = lines.flatMap(line => line.split(/\r?\n/u));
    this.write(this.rewind() + next.map(line => `${line}\r\n`).join(""));
    this.lines = next;
  }

  clear(): void {
    const rewind = this.rewind();
    this.lines = [];
    if (rewind) this.write(rewind);
  }
}

export interface SelectOption<T> {
  value: T;
  label: string;
  note?: string;
  disabled?: boolean;
}

export interface MultiSelectOption<T> extends SelectOption<T> {
  details?: readonly string[];
  checked?: boolean;
  group?: string;
}

interface SelectOptions {
  title?: readonly string[];
  footer?: readonly string[];
  hint?: string;
  focus?: number;
  rich?: Rich | null;
  input?: NodeJS.ReadStream;
  write?: Write;
  columns?: () => number;
  rows?: () => number;
  read?: () => Promise<string>;
}

interface MultiSelectOptions<T> extends SelectOptions {
  onCheck?: (option: MultiSelectOption<T>) => Promise<boolean | null | undefined>;
  onDropUnticked?: (drop: boolean) => void;
  compact?: boolean;
  plainHint?: string;
}

export async function select<T>(options: readonly SelectOption<T>[], settings: SelectOptions = {}): Promise<T | null> {
  const answer = await choose(options, settings);
  return answer === null ? null : options[answer.focus]!.value;
}

export async function multiSelect<T>(options: readonly MultiSelectOption<T>[], settings: MultiSelectOptions<T> = {}): Promise<T[] | null> {
  const answer = await choose(options, settings, true);
  return answer === null ? null : options.filter((_, i) => answer.checked.has(i)).map(option => option.value);
}

async function choose<T>(
  options: readonly MultiSelectOption<T>[],
  settings: MultiSelectOptions<T>,
  multiple = false,
): Promise<{ focus: number; checked: Set<number> } | null> {
  const input = settings.input ?? process.stdin;
  const write = settings.write ?? writeStdout;
  const enabled = options.flatMap((option, i) => option.disabled ? [] : [i]);
  if ((!input.isTTY && !settings.read) || !enabled.length) return null;

  let position = Math.max(0, enabled.indexOf(settings.focus ?? 0));
  let dropUnticked = false;
  const checked = new Set(enabled.filter(i => options[i]!.checked));
  const toggle = (i: number) => { if (checked.has(i)) checked.delete(i); else checked.add(i); };
  const mode = screenMode();
  const rich = settings.rich === undefined && !mode.plain && !mode.ascii ? new Rich() : settings.rich;
  const columns = settings.columns ?? (() => process.stdout.columns || 100);
  const decorated = rich && columns() >= 72 ? rich : null;
  const block = decorated ? new TerminalBlock(write, columns) : undefined;
  const read = settings.read ?? (() => !block && options.length >= 10 ? readChoiceLine(input) : readKey(input));
  const rows = settings.rows ?? (() => process.stdout.rows || 24);
  const labelWidth = !multiple && options.some(option => option.note)
    ? Math.max(...options.map(option => visible(option.label))) : 0;
  const numberWidth = String(options.length).length;
  const hint = decorated
    ? settings.hint ?? (multiple ? "↑↓ move · Space keep or drop · Enter save" : "↑↓ choose · Enter confirm")
    : settings.plainHint ?? (multiple ? "Enter saves. Type a number to keep or drop a rule." : `Enter chooses ${enabled[position]! + 1}.`);
  const draw = () => {
    const focus = enabled[position]!;
    const title = [...(settings.title ?? [])];
    const rowsByOption: string[][] = [];
    for (const [i, option] of options.entries()) {
      const lines: string[] = [];
      if (option.group && option.group !== options[i - 1]?.group) {
        lines.push(decorated ? `${MARGIN}${decorated.dim(option.group)}` : option.group);
      }
      const tick = multiple ? (checked.has(i) ? "[✓] " : "[ ] ") : "";
      if (decorated) {
        const pointer = i === focus ? decorated.paint("orange", "›") : " ";
        const box = multiple ? checked.has(i) ? decorated.paint("ok", tick) : decorated.dim(tick) : "";
        const label = option.disabled ? decorated.paint("muted", option.label) : i === focus ? decorated.bold(option.label) : option.label;
        const indent = `${MARGIN}  ${" ".repeat(tick.length)}`;
        const note = option.note && (option.disabled ? decorated.paint("muted", option.note) : decorated.dim(option.note));
        const text = note ? `${pad(label, labelWidth)}  ${note}` : label;
        const wrapped = wrapText(text, Math.max(12, Math.min(100, columns() - 1) - indent.length));
        lines.push(`${MARGIN}${pointer} ${box}${wrapped[0]}`, ...wrapped.slice(1).map(line => indent + line));
        lines.push(...(option.details ?? []).map(line => indent + line));
        if (multiple && !settings.compact && i < options.length - 1) lines.push("");
      } else {
        const number = String(option.disabled ? "-" : i + 1).padStart(numberWidth);
        const label = option.note ? `${pad(option.label, labelWidth)}  (${option.note})` : option.label;
        lines.push(`${number}. ${tick.replace("✓", "x")}${label}`, ...(option.details ?? []).map(line => `   ${line}`));
      }
      rowsByOption.push(lines);
    }
    const marked = "Enter drops unticked trials. Press d to undo.";
    const footer = [...(settings.footer ?? []), "",
      ...(dropUnticked ? [decorated ? `${MARGIN}${decorated.dim(marked)}` : marked] : []),
      decorated ? `${MARGIN}${decorated.dim(hint)}` : hint];
    if (block) {
      const budget = Math.max(1, rows() - 1 - terminalRows([...title, ...footer], columns()));
      let start = 0, end = rowsByOption.length;
      if (terminalRows(rowsByOption.flat(), columns()) > budget) {
        start = focus;
        end = focus + 1;
        let used = terminalRows(rowsByOption[focus]!, columns());
        while (start > 0 && used + terminalRows(rowsByOption[start - 1]!, columns()) <= budget) {
          used += terminalRows(rowsByOption[--start]!, columns());
        }
        while (end < rowsByOption.length && used + terminalRows(rowsByOption[end]!, columns()) <= budget) {
          used += terminalRows(rowsByOption[end++]!, columns());
        }
      }
      block.draw([...title, ...rowsByOption.slice(start, end).flat(), ...footer]);
    } else write(`${stripVTControlCharacters([...title, ...rowsByOption.flat(), ...footer].join("\n"))}\n`);
  };

  if (block) write("\x1b[?25l");
  if (block && !settings.columns) process.stdout.on("resize", draw);
  try {
    for (;;) {
      draw();
      const key = await read();
      const focus = enabled[position]!;
      if (key === "quit" || multiple && key === "q") return null;
      if (key === "enter") return { focus, checked };
      if (block && (key === "up" || key === "down" || key === "tab")) {
        position = (position + (key === "up" ? enabled.length - 1 : 1)) % enabled.length;
      } else if (block && key === "space" && multiple) {
        toggle(focus);
      } else if (key === "d" && settings.onDropUnticked) {
        dropUnticked = !dropUnticked;
        settings.onDropUnticked(dropUnticked);
      } else if (key === "v" && settings.onCheck) {
        const key = block ? String(focus + 1) : await read();
        if (key === "quit" || key === "q") return null;
        const picked = Number(key) - 1;
        if (!enabled.includes(picked)) continue;
        block?.clear();
        if (block && !settings.columns) process.stdout.removeListener("resize", draw);
        if (block) write("\x1b[?25h");
        try {
          const checkedAfter = await settings.onCheck(options[picked]!);
          if (checkedAfter === null) return null;
          if (checkedAfter !== undefined) {
            if (checkedAfter) checked.add(picked);
            else checked.delete(picked);
          }
        } finally {
          if (block) write("\x1b[?25l");
          if (block && !settings.columns) process.stdout.on("resize", draw);
        }
      } else if (!block && /^\d+$/u.test(key)) {
        const picked = Number(key) - 1;
        if (!enabled.includes(picked)) continue;
        if (!multiple) return { focus: picked, checked };
        position = enabled.indexOf(picked);
        toggle(picked);
      }
    }
  } finally {
    if (block) {
      process.stdout.removeListener("resize", draw);
      try { block.clear(); } finally { write("\x1b[?25h"); }
    }
  }
}
