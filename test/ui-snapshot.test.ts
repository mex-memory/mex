import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readSetupPlan, readSnapshot } from "../src/ui/snapshot.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mex-ui-snapshot-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeScaffold(files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, ".mex", path);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, content);
  }
}

describe("readSnapshot — project state", () => {
  it("reports `empty` when there is no .mex/ directory", () => {
    const snapshot = readSnapshot({ root });
    expect(snapshot.status).toBe("empty");
    expect(snapshot.scaffoldRoot).toBeNull();
    expect(snapshot.identity).toBeNull();
    expect(snapshot.error).toBeNull();
    expect(snapshot.graph.present).toBe(false);
  });

  it("reports `ready` for a loadable scaffold", () => {
    writeScaffold({ "ROUTER.md": "# Router\n" });
    const snapshot = readSnapshot({ root });
    expect(snapshot.status).toBe("ready");
    expect(snapshot.scaffoldRoot).toBe(join(root, ".mex"));
    expect(snapshot.error).toBeNull();
  });

  it("reports a recoverable `error` when .mex/ exists without ROUTER.md", () => {
    writeScaffold({ "AGENTS.md": "# Agents\n" });
    const snapshot = readSnapshot({ root });
    expect(snapshot.status).toBe("error");
    expect(snapshot.error?.canRunSetup).toBe(true);
    expect(snapshot.error?.message).toMatch(/ROUTER\.md/);
  });

  it("reports `error` for a root that does not exist", () => {
    const snapshot = readSnapshot({ root: join(root, "nope") });
    expect(snapshot.status).toBe("error");
    expect(snapshot.error?.canRunSetup).toBe(false);
  });

  it("never throws, whatever it finds", () => {
    writeScaffold({ "ROUTER.md": "# Router\n", "config.json": "{ not json" });
    expect(() => readSnapshot({ root })).not.toThrow();
  });
});

describe("readSnapshot — side effects", () => {
  it("does not mint a scaffold identity", () => {
    writeScaffold({ "ROUTER.md": "# Router\n" });
    const snapshot = readSnapshot({ root });
    expect(snapshot.identity).toBeNull();
    expect(existsSync(join(root, ".mex", "config.json"))).toBe(false);
  });

  it("reports an existing identity without rewriting it", () => {
    writeScaffold({
      "ROUTER.md": "# Router\n",
      "config.json": JSON.stringify({ scaffold_id: "abc-123", scaffold_name: "demo" }),
    });
    const snapshot = readSnapshot({ root });
    expect(snapshot.identity?.scaffold_id).toBe("abc-123");
    expect(snapshot.identity?.scaffold_name).toBe("demo");
  });

  it("does not create a .mex/ directory for an empty project", () => {
    readSnapshot({ root });
    expect(existsSync(join(root, ".mex"))).toBe(false);
  });
});

describe("readSnapshot — scaffold coverage", () => {
  it("separates populated files from unfilled templates", () => {
    writeScaffold({
      "ROUTER.md": "# Router\n\nReal content.\n",
      "AGENTS.md": "# [Project Name]\n\nTemplate placeholder.\n",
    });
    const snapshot = readSnapshot({ root });
    const byFile = new Map(snapshot.scaffold.files.map((f) => [f.file, f]));

    expect(byFile.get("ROUTER.md")).toMatchObject({ exists: true, populated: true });
    expect(byFile.get("AGENTS.md")).toMatchObject({ exists: true, populated: false });
    expect(byFile.get("context/stack.md")).toMatchObject({ exists: false, populated: false });

    expect(snapshot.scaffold.total).toBe(snapshot.scaffold.files.length);
    expect(snapshot.scaffold.present).toBe(2);
    expect(snapshot.scaffold.populated).toBe(1);
  });

  it("surfaces frontmatter last_updated for freshness display", () => {
    writeScaffold({
      "ROUTER.md": "---\nname: router\nlast_updated: 2026-05-14\n---\n\n# Router\n",
    });
    const file = readSnapshot({ root }).scaffold.files.find((f) => f.file === "ROUTER.md");
    expect(file?.lastUpdated).toBe("2026-05-14");
  });
});

describe("readSnapshot — graph status", () => {
  it("stats the graph database without opening it", () => {
    writeScaffold({ "ROUTER.md": "# Router\n", "graph.db": "not really sqlite" });
    const snapshot = readSnapshot({ root });
    expect(snapshot.graph.present).toBe(true);
    expect(snapshot.graph.bytes).toBeGreaterThan(0);
    expect(snapshot.graph.modifiedAt).not.toBeNull();
  });
});

describe("readSetupPlan", () => {
  it("classifies a project with no source files as fresh", () => {
    const plan = readSetupPlan({ root });
    expect(plan.state).toBe("fresh");
    expect(plan.hasScaffold).toBe(false);
    expect(plan.isMexRepo).toBe(false);
    expect(plan.scaffoldFiles).toContain("ROUTER.md");
    expect(plan.scaffoldFiles).toContain("context/stack.md");
    expect(plan.populationPrompt.length).toBeGreaterThan(80);
  });

  it("classifies a project with several source files as existing", () => {
    mkdirSync(join(root, "src"), { recursive: true });
    for (const name of ["a", "b", "c", "d", "e"]) {
      writeFileSync(join(root, "src", `${name}.ts`), `export const ${name} = 1;\n`);
    }
    expect(readSetupPlan({ root }).state).toBe("existing");
  });

  it("detects that it is pointed at the mex repository itself", () => {
    expect(readSetupPlan({ root: process.cwd() }).isMexRepo).toBe(true);
  });
});
