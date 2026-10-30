/**
 * A reference committed as a node id alone is still recorded knowledge.
 *
 * The groundings readers return nothing for a store that holds a node-only
 * entry, so the committed-reference lookup used to answer "never committed" for
 * it. A node that later disappeared was then classed as a new authoring mistake
 * and setup finalize dropped it. It must read as committed, hence drift.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGraphEngine } from "../src/graph/engine-impl.js";
import { committedReferenceLookup } from "../src/graph/grounding-failures.js";
import { captureGroundingBaselines } from "../src/graph/runtime.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const GONE = "function:00000000000000000000000000000000";
const OTHER = "function:11111111111111111111111111111111";

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "mex-committed-node-only-"));
  roots.push(root);
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: root, stdio: "ignore" });
  git("init", "-q");
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  git("add", "-A");
  git("commit", "-q", "-m", "committed");
  return root;
}

describe("committedReferenceLookup with node-only entries in HEAD", () => {
  it("sees a node-only entry in the root grounds_to", () => {
    const root = repo({ "a.md": `---\nname: a\ngrounds_to:\n  - node: "${GONE}"\n---\n\n# A\n` });
    const lookup = committedReferenceLookup(root, join(root, "a.md"));
    expect(lookup(GONE)).toBe(true);
    expect(lookup(OTHER)).toBe(false);
  });

  it("sees a node-only entry in mex.grounds_to, and one mixed with complete entries", () => {
    const root = repo({
      "a.md": `---\nname: a\nmex:\n  id: mx_01AAAAAAAAAAAAAAAAAAAAAAAA\n  grounds_to:\n    - node: "${GONE}"\n    - node: "${OTHER}"\n      fingerprint: "mh2:64:AAAA"\n---\n\n# A\n`,
    });
    const lookup = committedReferenceLookup(root, join(root, "a.md"));
    expect(lookup(GONE)).toBe(true);
    expect(lookup(OTHER)).toBe(true);
  });

  it("sees a node-only grounding in a block entity", () => {
    const root = repo({
      "a.md": `# A\n\n<!-- mex:entity\nid: mx_01BBBBBBBBBBBBBBBBBBBBBBBB\ntype: fact\nstatus: promoted\nrevision: 1\ngrounds_to:\n  - node: "${GONE}"\n-->\n## A claim\n\nBody.\n`,
    });
    expect(committedReferenceLookup(root, join(root, "a.md"))(GONE)).toBe(true);
  });

  it("still says false for an untracked file or a node HEAD never named", () => {
    const root = repo({ "a.md": `---\nname: a\n---\n\n# A\n` });
    expect(committedReferenceLookup(root, join(root, "a.md"))(GONE)).toBe(false);
    writeFileSync(join(root, "b.md"), `---\nname: b\ngrounds_to:\n  - node: "${GONE}"\n---\n`);
    expect(committedReferenceLookup(root, join(root, "b.md"))(GONE)).toBe(false);
  });
});

describe("finalize keeps a committed node-only reference whose node is gone", () => {
  it("reports drift and leaves the file as written", async () => {
    const root = mkdtempSync(join(tmpdir(), "mex-committed-gone-"));
    roots.push(root);
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, ".mex", "patterns"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), "export function alpha(): number {\n  const x = 1;\n  const y = 2;\n  return x + y + 3;\n}\n");
    const engine = createGraphEngine({ rootDir: root });
    await engine.build();
    engine.close();
    const pattern = join(root, ".mex", "patterns", "a.md");
    const content = `---\nname: a\ngrounds_to:\n  - node: "${GONE}"\n---\n\n# A\n`;
    writeFileSync(pattern, content);
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: root, stdio: "ignore" });
    git("init", "-q");
    git("add", ".mex/patterns/a.md");
    git("commit", "-q", "-m", "recorded");

    const result = await captureGroundingBaselines({ projectRoot: root, scaffoldRoot: join(root, ".mex"), aiTools: [] });

    expect(result.captured).toBe(0);
    expect(result.driftCount).toBe(1);
    expect(result.failures!.map((failure) => [failure.node, failure.kind])).toEqual([[GONE, "drift"]]);
    expect(readFileSync(pattern, "utf-8")).toBe(content);
  }, 30_000);
});
