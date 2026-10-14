import { describe, expect, it } from "vitest";
import { formatPacket, liveStateFrom, PACKET_CHAR_LIMIT, type PacketEntry } from "../packet.js";
import type { ContextEntity } from "../types.js";

function entity(i: number, overrides: Partial<ContextEntity> = {}): ContextEntity {
  return {
    id: `mx_01ENTITY000000000000000${i}`,
    type: "fact",
    title: `Fact ${i}`,
    body: "A short statement about the code.",
    aliases: [],
    file: "context/notes.md",
    line: 10 + i,
    level: 3,
    groundings: [],
    code: [],
    symbols: [],
    ...overrides,
  };
}

const entry = (i: number, extra?: string): PacketEntry => ({ entity: entity(i), live: { health: "fresh", locations: [] }, ...(extra ? { extra } : {}) });

describe("packet options", () => {
  it("accepts any channel label and shows an entry's own line under its code line", () => {
    const { text } = formatPacket([entry(1, "if this change makes it false, rewrite its prose at .mex/context/notes.md:11")], "edit");
    const lines = text.split("\n");
    expect(lines[0]).toBe("MEX knowledge (fresh · edit) — Fact 1");
    expect(lines.at(-1)).toBe("if this change makes it false, rewrite its prose at .mex/context/notes.md:11");
    expect(lines.at(-2)).toContain("more: mex wiki show");
  });

  it("honours an entry cap and puts a footer after the last entry", () => {
    const { text, shown } = formatPacket([entry(1), entry(2), entry(3)], "read", { maxEntries: 3, footer: ["+4 more facts: mex wiki show a b c"] });
    expect(shown).toHaveLength(3);
    expect(text.endsWith("\n\n+4 more facts: mex wiki show a b c")).toBe(true);
  });

  it("counts the footer toward the cap and never exceeds the packet limit, even when asked for more", () => {
    const huge = { ...entry(1), entity: entity(1, { body: "word ".repeat(2000) }) };
    const footer = "F".repeat(600);
    const { text } = formatPacket([huge], "read", { footer: [footer], charLimit: 2000 });
    expect(text.length).toBeLessThanOrEqual(2000);
    expect(text.endsWith(footer)).toBe(true);
    expect(formatPacket([huge], "read", { charLimit: 99999 }).text.length).toBeLessThanOrEqual(PACKET_CHAR_LIMIT);
  });
});

describe("liveStateFrom", () => {
  it("reads unchecked, with the indexed locations, when there is no graph handle", () => {
    const grounded = entity(1, {
      groundings: [{ node: "n1", file: "src/a.ts", bodyHash: "h" }],
      symbols: [{ node: "n1", name: "a", file: "src/a.ts", start: 1, end: 5, bodyHash: "h" }],
    });
    const state = liveStateFrom(null, [grounded])(grounded);
    expect(state.health).toBe("unchecked");
    expect(state.locations).toEqual([{ file: "src/a.ts", start: 1, end: 5, name: "a" }]);
    expect(liveStateFrom(null, [entity(2)])(entity(2)).health).toBe("none");
  });
});
