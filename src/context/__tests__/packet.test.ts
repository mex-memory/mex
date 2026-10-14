import { describe, expect, it } from "vitest";
import { formatPacket, PACKET_CHAR_LIMIT, PACKET_MAX_ENTRIES, type PacketEntry } from "../packet.js";
import type { ContextEntity } from "../types.js";

function entity(overrides: Partial<ContextEntity> = {}): ContextEntity {
  return {
    id: "mx_01ENTITY0000000000000000A",
    type: "fact",
    title: "Route registration goes through #addRoute",
    body: "All verbs end in addRoute, which merges the base path and stores the handler.",
    aliases: [],
    file: "context/routing.md",
    line: 98,
    level: 3,
    groundings: [],
    code: [],
    symbols: [],
    ...overrides,
  };
}

const live = (health: PacketEntry["live"]["health"] = "fresh", locations: PacketEntry["live"]["locations"] = []): PacketEntry["live"] => ({
  health,
  locations,
});

describe("packet format", () => {
  it("renders the compact header, text, code line and pointer", () => {
    const { text } = formatPacket(
      [
        {
          entity: entity({ id: "mx_01ENTITY0000000000000000A" }),
          live: live("fresh", [{ file: "src/hono-base.ts", start: 388, end: 399, name: "#addRoute" }]),
        },
      ],
      "lexical",
    );
    expect(text.split("\n")).toEqual([
      "MEX knowledge (fresh · lexical) — Route registration goes through #addRoute",
      "All verbs end in addRoute, which merges the base path and stores the handler.",
      "code: src/hono-base.ts:388-399 #addRoute · more: mex wiki show mx_01ENTITY0000000000000000A",
    ]);
  });

  it("points at the .mex file and line for an entry with no linked code", () => {
    const { text } = formatPacket([{ entity: entity({ type: "convention" }), live: live("none") }], "lexical");
    expect(text).toContain("MEX knowledge (convention · lexical)");
    expect(text).toContain("source: .mex/context/routing.md:98 · more: mex wiki show");
  });

  it("labels the live health and the channel that selected the entry", () => {
    const changed = formatPacket([{ entity: entity(), live: live("changed") }], "semantic").text;
    expect(changed.split("\n")[0]).toContain("changed ⚠");
    expect(changed.split("\n")[0]).toContain("semantic");
    expect(formatPacket([{ entity: entity(), live: live("missing") }], "lexical").text).toContain("missing ⚠");
    expect(formatPacket([{ entity: entity(), live: live("unverified") }], "lexical").text).toContain("(unverified");
  });

  it("never exceeds two entries or 4000 characters, however large the facts are", () => {
    const huge = "word ".repeat(2000).trim();
    const entries: PacketEntry[] = Array.from({ length: 5 }, (_, i) => ({
      entity: entity({ id: `mx_01ENTITY000000000000000${i}`, title: `Fact number ${i}`, body: huge }),
      live: live("fresh", Array.from({ length: 6 }, (_, k) => ({ file: `src/very/long/path/segment/number/${k}/module.ts`, start: 1, end: 900, name: `symbolNumber${k}` }))),
    }));
    const { text, shown } = formatPacket(entries, "semantic");
    expect(text.length).toBeLessThanOrEqual(PACKET_CHAR_LIMIT);
    expect(shown.length).toBeLessThanOrEqual(PACKET_MAX_ENTRIES);
    // Shortening prose must not cost a pointer: every shown entry keeps its `more:`.
    expect(text.match(/more: mex wiki show/g)).toHaveLength(shown.length);
  });

  it("drops the second entry rather than cut the first when the limit is still exceeded", () => {
    const longTitle = "T".repeat(3500);
    const { text, shown } = formatPacket(
      [
        { entity: entity({ id: "mx_01ENTITY0000000000000000A", title: longTitle, body: "x" }), live: live() },
        { entity: entity({ id: "mx_01ENTITY0000000000000000B", title: longTitle, body: "y" }), live: live() },
      ],
      "lexical",
    );
    expect(text.length).toBeLessThanOrEqual(PACKET_CHAR_LIMIT);
    expect(shown).toHaveLength(1);
  });
});
