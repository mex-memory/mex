import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkBatchFile } from "../subsystem-apply.js";
import { ScopeGuard } from "../subsystem-scope.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function folder(): string {
  const root = mkdtempSync(join(tmpdir(), "mex-batch-scope-"));
  roots.push(root);
  return root;
}

const SCOPE = { opIdPrefix: "setup_router_", files: ["context/router.md"] };
const entry = (opId: string, file = "context/router.md", type = "create-entry") => ({ opId, type, payload: { file, type: "fact" } });

describe("a batch stays in its lane before the Wiki engine sees it", () => {
  it("accepts create-entry operations under the unit's prefix into its file", () => {
    const path = join(folder(), "router.json");
    writeFileSync(path, JSON.stringify([entry("setup_router_a"), entry("setup_router_b", ".mex/context/router.md")]));
    expect(checkBatchFile(path, SCOPE)).toMatchObject({ ok: true, envelopes: [expect.any(Object), expect.any(Object)] });
  });

  it("reports a missing file, invalid JSON, and every out-of-lane operation by index", () => {
    const root = folder();
    expect(checkBatchFile(join(root, "absent.json"), SCOPE)).toEqual({ ok: "missing" });
    writeFileSync(join(root, "broken.json"), "[{");
    expect(checkBatchFile(join(root, "broken.json"), SCOPE)).toMatchObject({ ok: false, problems: [{ code: "MALFORMED_OPERATION" }] });
    writeFileSync(join(root, "wide.json"), JSON.stringify([
      entry("setup_router_ok"),
      entry("setup_shared_x"),
      entry("setup_router_y", "context/architecture.md"),
      entry("setup_router_z", "context/router.md", "set-grounding"),
      entry("setup_router_ok"),
      "not an object",
    ]));
    const checked = checkBatchFile(join(root, "wide.json"), SCOPE);
    expect(checked.ok).toBe(false);
    const messages = checked.ok === false ? checked.problems.map((problem) => problem.message) : [];
    expect(messages).toEqual([
      'Operation 1 (setup_shared_x): every opId must start with "setup_router_" and be unique.',
      'Operation 2 (setup_router_y): "file" must be "context/router.md"; found "context/architecture.md".',
      'Operation 3 (setup_router_z): setup batches hold create-entry operations only; found "set-grounding".',
      "Operation 5: is not an operation envelope object.",
      'opId "setup_router_ok" is used twice; every opId must be unique.',
    ]);
  });
});

describe("scope guard", () => {
  it("names changed scaffold and tracked source files once, ignoring local state and databases", () => {
    const root = folder();
    execFileSync("git", ["init", "-q"], { cwd: root });
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, ".mex", "local"), { recursive: true });
    writeFileSync(join(root, "src", "app.ts"), "export const a = 1;\n");
    writeFileSync(join(root, ".mex", "ROUTER.md"), "# Router\n");
    execFileSync("git", ["add", "src"], { cwd: root });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "base"], { cwd: root });
    const guard = new ScopeGuard(root);
    expect(guard.take()).toEqual([]);
    writeFileSync(join(root, ".mex", "local", "batch.json"), "[]");
    writeFileSync(join(root, ".mex", "graph.db"), "binary");
    writeFileSync(join(root, ".mex", "ROUTER.md"), "# Router, edited\n");
    writeFileSync(join(root, "src", "app.ts"), "export const a = 2;\n");
    expect(guard.take()).toEqual([".mex/ROUTER.md", "src/app.ts"]);
    expect(guard.take()).toEqual([]);
    writeFileSync(join(root, "src", "app.ts"), "export const a = 3; // edited again\n");
    expect(guard.take()).toEqual(["src/app.ts"]);
  });
});
