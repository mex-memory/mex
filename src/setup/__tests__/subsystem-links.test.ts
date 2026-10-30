import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { parse } from "yaml";
import { readSetupBatch, reconcileSetupNavigation } from "../subsystem-links.js";
import { createPlanState } from "../subsystem-state.js";

const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mex-navigation-")); roots.push(root);
  const write = (file: string, content: string) => { const path = join(root, ".mex", file); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); };
  for (const file of ["ROUTER.md", "context/a.md", "context/architecture.md", "context/conventions.md", "patterns/INDEX.md"]) write(file, "---\nname: example\ndescription: example\n---\n# Existing content\n");
  const state = createPlanState({ source: "tree", ranking: "size", sourceFiles: 50, target: { min: 1, max: 2 }, candidates: ["a", "b"].map((slug) => ({ path: `src/${slug}`, files: 20, commits: null, budget: { min: 4, max: 6 } })) });
  state.shared.state = "done"; state.subsystems[0]!.state = "done"; state.subsystems[1]!.state = "skipped";
  return { root, state, write, read: (file: string) => readFileSync(join(root, ".mex", file), "utf8") };
}
it("writes conditioned edges, back-links, routes and pattern rows deterministically; omits missing targets", () => {
  const f = fixture();
  const content = "---\nname: trace\ndescription: when tracing requests\n---\n# Trace\n" + ["Context", "Steps", "Gotchas", "Verify", "Debug", "Update Scaffold"].map((heading) => `## ${heading}\nConcrete instructions\n`).join("");
  f.write("local/setup-ops/a.json", JSON.stringify([{ opId: "setup_a_one", setup: { links: [{ target: "context/architecture.md", condition: "when tracing request ownership" }, { target: "context/b.md", condition: "when handling storage" }], patterns: [{ file: "patterns/trace.md", content }] } }]));
  const batch = readSetupBatch(join(f.root, ".mex/local/setup-ops/a.json"));
  expect(batch.operations).toEqual([{ opId: "setup_a_one" }]);
  reconcileSetupNavigation(f.root, f.state);
  const before = ["ROUTER.md", "context/a.md", "context/architecture.md", "patterns/INDEX.md", "patterns/trace.md"].map(f.read);
  const fm = (file: string) => parse(/^---\n([\s\S]*?)\n---/u.exec(f.read(file))![1]!);
  expect(fm("context/a.md").edges).toEqual([{ target: "context/architecture.md", condition: "when tracing request ownership" }]);
  expect(fm("context/architecture.md").edges).toContainEqual({ target: "context/a.md", condition: "when tracing request ownership" });
  expect(f.read("ROUTER.md")).toContain("| Working in src/a/ | `context/a.md` |");
  expect(f.read("ROUTER.md")).not.toContain("context/b.md");
  expect(f.read("patterns/INDEX.md")).toContain("when tracing requests");
  // The pattern is reachable from the context file it relies on.
  expect(fm("context/architecture.md").edges).toContainEqual({ target: "patterns/trace.md", condition: "when doing this task: when tracing requests" });
  reconcileSetupNavigation(f.root, f.state);
  expect(["ROUTER.md", "context/a.md", "context/architecture.md", "patterns/INDEX.md", "patterns/trace.md"].map(f.read)).toEqual(before);
});
it("accepts old batches and rejects escaping targets or malformed patterns before Wiki apply", () => {
  const f = fixture();
  f.write("local/batch.json", JSON.stringify([{ opId: "old" }]));
  expect(readSetupBatch(join(f.root, ".mex/local/batch.json")).extended).toBe(false);
  f.write("local/batch.json", JSON.stringify([{ setup: { links: [{ target: "../outside.md", condition: "x" }] } }]));
  expect(() => readSetupBatch(join(f.root, ".mex/local/batch.json"))).toThrow("scaffold target");
  f.write("local/batch.json", JSON.stringify([{ setup: { patterns: [{ file: "patterns/task.md", content: "bad" }] } }]));
  expect(() => readSetupBatch(join(f.root, ".mex/local/batch.json"))).toThrow("README.md");
});

it("admits patterns in stable shared/plan order up to the total cap and preserves authored files", () => {
  const f = fixture();
  const pattern = (name: string) => ({ file: `patterns/${name}.md`, content: `---\nname: ${name}\ndescription: task ${name}\n---\n` + ["Context", "Steps", "Gotchas", "Verify", "Debug", "Update Scaffold"].map((heading) => `## ${heading}\nConcrete task\n`).join("") });
  f.write("patterns/authored.md", pattern("authored").content);
  f.write("local/setup-ops/shared.json", JSON.stringify([{ setup: { patterns: [pattern("one"), pattern("two"), pattern("three")] } }]));
  f.write("local/setup-ops/a.json", JSON.stringify([{ setup: { patterns: [pattern("four")] } }]));
  f.state.subsystems[1]!.state = "done";
  f.write("context/b.md", "---\nname: b\ndescription: b\n---\n# B\n");
  f.write("local/setup-ops/b.json", JSON.stringify([{ setup: { patterns: [pattern("five")] } }]));
  reconcileSetupNavigation(f.root, f.state);
  expect(existsSync(join(f.root, ".mex/patterns/four.md"))).toBe(true);
  expect(existsSync(join(f.root, ".mex/patterns/five.md"))).toBe(false);
  expect(f.read("patterns/authored.md")).toContain("## Steps\nConcrete task");
});
