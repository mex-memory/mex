import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vitest";
import { Rich, visible } from "./rich.js";
import { multiSelect, select, TerminalBlock, terminalRows } from "./select.js";

function terminal() {
  const input = Object.assign(new PassThrough(), {
    isTTY: true,
    isRaw: false,
    setRawMode(raw: boolean) { this.isRaw = raw; return this; },
  }) as unknown as NodeJS.ReadStream;
  const writes: string[] = [];
  return {
    input, rich: new Rich({}), columns: () => 80,
    write: (text: string) => { writes.push(text); },
    async press(key: string) {
      await new Promise<void>(resolve => setImmediate(resolve));
      input.write(key);
    },
    output: () => writes.join(""),
  };
}

const choices = [
  { value: "first", label: "First" },
  { value: "unavailable", label: "Unavailable", disabled: true },
  { value: "last", label: "Last" },
];

describe("terminal selectors", () => {
  it("moves past disabled rows and selects on Enter", async () => {
    const tty = terminal();
    const answer = select(choices.map(option => ({ ...option, note: `Note for ${option.label}` })), tty);
    await tty.press("\x1b[B");
    await tty.press("\r");
    expect(await answer).toBe("last");
    expect(tty.output()).toContain("›");
    expect(tty.output()).toContain(tty.rich.paint("muted", "Unavailable"));
    expect(tty.output()).toContain(tty.rich.paint("muted", "Note for Unavailable"));
    const firstDraw = stripVTControlCharacters(tty.output()).split("\r\n").slice(0, 3);
    expect(firstDraw.map(line => line.indexOf("Note for"))).toEqual([18, 18, 18]);
    expect(tty.output()).toContain("\x1b[?25l");
    expect(tty.output()).toMatch(/\x1b\[\?25h$/u);
    expect(tty.input.isRaw).toBe(false);
  });

  it("toggles the focused row with Space and preserves other checks", async () => {
    const tty = terminal();
    const answer = multiSelect([{ ...choices[0]!, checked: true }, ...choices.slice(1)], tty);
    await tty.press("\x1b[A");
    await tty.press(" ");
    await tty.press("\r");
    expect(await answer).toEqual(["first", "last"]);
  });

  it.each(["\x1b", "\x03"])("restores the cursor and raw input when dismissed", async key => {
    const tty = terminal();
    const answer = select(choices, tty);
    await tty.press(key);
    expect(await answer).toBeNull();
    expect(tty.output()).toMatch(/\x1b\[\?25h$/u);
    expect(tty.input.isRaw).toBe(false);
  });

  it("prints numbered choices with no terminal controls in plain mode", async () => {
    const tty = terminal();
    const answer = select(choices, { ...tty, rich: null, focus: 2 });
    await tty.press("\r");
    expect(await answer).toBe("last");
    expect(tty.output()).toContain("3. Last");
    expect(tty.output()).not.toContain("\x1b");
  });

  it("does not prompt a pipe", async () => {
    const tty = terminal();
    const input = new PassThrough() as unknown as NodeJS.ReadStream;
    expect(await select(choices, { ...tty, input })).toBeNull();
    expect(tty.output()).toBe("");
  });

  it("counts wrapped lines at the new width before clearing", () => {
    let width = 20;
    const writes: string[] = [];
    const block = new TerminalBlock(text => writes.push(text), () => width);
    const rich = new Rich({ WT_SESSION: "test" });
    const linked = rich.link("PR #42", "https://example.test/pull/42");
    expect(visible(linked)).toBe(6);
    const lines = [linked, "a".repeat(30), ""];
    expect(terminalRows(lines, width)).toBe(4);
    block.draw(lines);
    width = 10;
    block.draw(["Short answer"]);
    expect(writes[1]).toBe("\x1b[5A\r\x1b[0JShort answer\r\n");
  });

  it("uses the terminal width of wide characters and combining marks", () => {
    expect(visible("日本語 e\u0301")).toBe(8);
    expect(terminalRows(["日本語 e\u0301"], 7)).toBe(2);
    expect(terminalRows(["日本語"], 3)).toBe(3);
  });

  it("restores the cursor if reading a key fails", async () => {
    const tty = terminal();
    await expect(select(choices, { ...tty, read: async () => { throw new Error("input failed"); } })).rejects.toThrow("input failed");
    expect(tty.output()).toMatch(/\x1b\[\?25h$/u);
  });
});
