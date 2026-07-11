import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkToolConfigSync } from "../src/drift/checkers/tool-config-sync.js";

const roots: string[] = [];
const embedded = ["CLAUDE.md", ".cursorrules", ".windsurfrules", "copilot-instructions.md"];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("shipped code-graph agent guidance", () => {
  it("is identical across embedded tool configs and covers all agent responsibilities", () => {
    const contents = embedded.map((name) => readFileSync(join("templates/.tool-configs", name), "utf-8"));
    expect(new Set(contents).size).toBe(1);
    expect(contents[0]).toContain("mex impact <symbol|file>");
    expect(contents[0]).toContain("mex graph query <who-calls|what-calls|where-defined> <symbol>");
    expect(contents[0]).toContain("adjudicate any AMBIGUOUS grounding");
    expect(contents[0]).toContain("refreshed grounding is re-emitted");
  });

  it("keeps maintained equivalents aligned and OpenCode delegated to guided AGENTS.md", () => {
    const maintained = embedded.map((name) => readFileSync(join(".tool-configs", name), "utf-8"));
    expect(new Set(maintained).size).toBe(1);
    expect(maintained[0]).toContain("mex impact <symbol|file>");
    const agents = readFileSync("templates/AGENTS.md", "utf-8");
    expect(agents).toContain("mex graph query <who-calls|what-calls|where-defined> <symbol>");
    for (const file of ["templates/.tool-configs/opencode.json", ".tool-configs/opencode.json"]) {
      expect(JSON.parse(readFileSync(file, "utf-8")).instructions).toContain(".mex/AGENTS.md");
    }
  });

  it("passes tool-config-sync after installation", () => {
    const root = mkdtempSync(join(tmpdir(), "mex-tool-configs-"));
    roots.push(root);
    const content = readFileSync("templates/.tool-configs/CLAUDE.md", "utf-8");
    for (const path of ["CLAUDE.md", "AGENTS.md", ".cursorrules", ".windsurfrules", ".github/copilot-instructions.md"]) {
      const destination = join(root, path);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, content);
    }
    expect(checkToolConfigSync(root)).toEqual([]);
  });
});
