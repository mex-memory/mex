import { describe, expect, it } from "vitest";
import { planManagedBlockEdit, planManagedBlockRemoval, type ManagedBlockSpec } from "../src/managed-block.js";

const spec: ManagedBlockSpec = {
  start: "<!-- demo:start -->",
  end: "<!-- demo:end -->",
  render: (eol) => ["<!-- demo:start -->", "## Demo", "- one", "<!-- demo:end -->"].join(eol),
  maxPreviewBytes: 4096,
};
const bytes = (text: string): Uint8Array => Buffer.from(text, "utf8");
const text = (value: Uint8Array | undefined): string => Buffer.from(value ?? new Uint8Array()).toString("utf8");

function installed(original: string | null): string {
  const edit = planManagedBlockEdit(spec, original === null ? null : bytes(original));
  return text(edit.desiredBytes);
}

describe("planManagedBlockRemoval", () => {
  it.each([
    ["a file ending in a newline", "# Mine\n\nHand written.\n"],
    ["a CRLF file", "# Mine\r\n\r\nHand written.\r\n"],
    ["a single line", "x\n"],
  ])("restores %s exactly after an append", (_name, original) => {
    const removal = planManagedBlockRemoval(spec, bytes(installed(original)));
    expect(removal.action).toBe("remove");
    expect(text(removal.desiredBytes)).toBe(original);
    expect(removal.empty).toBe(false);
  });

  it("ends a file that had no final newline with one, since the append cannot tell the cases apart", () => {
    const removal = planManagedBlockRemoval(spec, bytes(installed("# Mine\n\nHand written.")));
    expect(text(removal.desiredBytes)).toBe("# Mine\n\nHand written.\n");
  });

  it("reports an emptied file when the file held only the block", () => {
    const removal = planManagedBlockRemoval(spec, bytes(installed(null)));
    expect(removal.action).toBe("remove");
    expect(removal.empty).toBe(true);
  });

  it("keeps text on both sides of a block in the middle", () => {
    const original = `top\n\n${spec.render("\n")}\n\nbottom\n`;
    const removal = planManagedBlockRemoval(spec, bytes(original));
    expect(text(removal.desiredBytes)).toBe("top\n\n\nbottom\n");
  });

  it("is a no-op without markers and a conflict with malformed ones", () => {
    expect(planManagedBlockRemoval(spec, bytes("nothing here\n")).action).toBe("noop");
    expect(planManagedBlockRemoval(spec, null).action).toBe("noop");
    expect(planManagedBlockRemoval(spec, bytes(`${spec.start}\nno end\n`))).toMatchObject({ action: "conflict", reason: "malformed-markers" });
    expect(planManagedBlockRemoval(spec, bytes(`${spec.render("\n")}\n${spec.render("\n")}\n`)).action).toBe("conflict");
    expect(planManagedBlockRemoval(spec, new Uint8Array([0xff, 0xfe, 0xfd])).action).toBe("conflict");
  });
});
