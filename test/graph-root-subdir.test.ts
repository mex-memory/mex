/**
 * Agent graph reads find the project from any subdirectory.
 *
 * Hooks and agents run from wherever the agent happens to be. `graph query`,
 * `scope`, `get`, `impact` and `wiki for-code` used to answer GRAPH_UNAVAILABLE
 * anywhere but the project root. They now use the working directory when it
 * holds the graph and otherwise the nearest scaffold above it, and a file
 * target written relative to the working directory is rebased onto that root.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { graphReadRoot, rebaseGraphTarget } from "../src/cli.js";
import { createGraphEngine } from "../src/graph/engine-impl.js";

const cliPath = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");
const roots: string[] = [];
let root = "";

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "mex-graph-root-")));
  roots.push(root);
  mkdirSync(join(root, "src", "billing"), { recursive: true });
  mkdirSync(join(root, "docs"), { recursive: true });
  mkdirSync(join(root, ".mex"), { recursive: true });
  writeFileSync(join(root, ".mex", "ROUTER.md"), "# Router\n");
  writeFileSync(join(root, "src", "billing", "checkout.ts"), `
export function calculateCheckoutTotal(items: number[], member: boolean): number {
  const subtotal = items.reduce((sum, item) => sum + item, 0);
  const volumeDiscount = items.length >= 5 ? subtotal * 0.10 : 0;
  const memberDiscount = member ? subtotal * 0.05 : 0;
  return subtotal - volumeDiscount - memberDiscount;
}
`);
  const engine = createGraphEngine({ rootDir: root });
  await engine.build();
  engine.close();
}, 60_000);

afterAll(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("graphReadRoot", () => {
  it("is the working directory when it holds the graph", async () => {
    expect(await graphReadRoot(root)).toBe(root);
  });

  it("finds the project from a subdirectory, a nested one and from inside .mex", async () => {
    expect(await graphReadRoot(join(root, "src"))).toBe(root);
    expect(await graphReadRoot(join(root, "src", "billing"))).toBe(root);
    expect(await graphReadRoot(join(root, ".mex"))).toBe(root);
  });

  it("falls back to the working directory outside any project", async () => {
    const stray = realpathSync(mkdtempSync(join(tmpdir(), "mex-graph-stray-")));
    roots.push(stray);
    expect(await graphReadRoot(stray)).toBe(stray);
  });
});

describe("rebaseGraphTarget", () => {
  const billing = (): string => join(root, "src", "billing");

  it("leaves a target alone at the root", () => {
    expect(rebaseGraphTarget("src/billing/checkout.ts", root, root)).toBe("src/billing/checkout.ts");
  });

  it("re-expresses a file written relative to the working directory, with POSIX separators", () => {
    expect(rebaseGraphTarget("checkout.ts", root, billing())).toBe("src/billing/checkout.ts");
    expect(rebaseGraphTarget("billing/checkout.ts", root, join(root, "src"))).toBe("src/billing/checkout.ts");
    expect(rebaseGraphTarget("../src/billing/checkout.ts", root, join(root, "docs"))).toBe("src/billing/checkout.ts");
  });

  it("keeps a :line or :start-end suffix", () => {
    expect(rebaseGraphTarget("checkout.ts:3", root, billing())).toBe("src/billing/checkout.ts:3");
    expect(rebaseGraphTarget("checkout.ts:3-5", root, billing())).toBe("src/billing/checkout.ts:3-5");
  });

  it("passes symbols, node ids, absolute paths and files that do not exist through unchanged", () => {
    expect(rebaseGraphTarget("calculateCheckoutTotal", root, billing())).toBe("calculateCheckoutTotal");
    expect(rebaseGraphTarget("function:0123456789abcdef", root, billing())).toBe("function:0123456789abcdef");
    const absolute = resolve(billing(), "checkout.ts");
    expect(rebaseGraphTarget(absolute, root, billing())).toBe(absolute);
    expect(rebaseGraphTarget("missing.ts", root, billing())).toBe("missing.ts");
  });
});

// The built CLI is what hooks and agents run; the unit tests above name the
// rule, this proves the commands apply it.
describe.skipIf(!existsSync(cliPath))("the built CLI from a subdirectory", () => {
  function mex(cwd: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
    const result = spawnSync(process.execPath, [cliPath, ...args], {
      cwd,
      encoding: "utf8",
      timeout: 30_000,
      killSignal: "SIGKILL",
      env: { ...process.env, MEX_TELEMETRY: "0", MEX_NO_UPDATE_CHECK: "1" },
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  it("answers graph query from src/billing, not GRAPH_UNAVAILABLE", () => {
    const result = mex(join(root, "src", "billing"), ["graph", "query", "where-defined", "calculateCheckoutTotal"]);
    expect(result.stdout).not.toContain("GRAPH_UNAVAILABLE");
    expect(result.stdout).toContain("calculateCheckoutTotal");
    expect(result.status).toBe(0);
  }, 40_000);

  it("answers graph scope from a subdirectory", () => {
    const result = mex(join(root, "src"), ["graph", "scope", "calculateCheckoutTotal"]);
    expect(result.stdout).not.toContain("GRAPH_UNAVAILABLE");
    expect(result.stdout).toContain("calculateCheckoutTotal");
  }, 40_000);

  it("rebases a relative file target for impact", () => {
    const result = mex(join(root, "src", "billing"), ["impact", "checkout.ts"]);
    expect(result.stdout).not.toContain("GRAPH_UNAVAILABLE");
    expect(result.stdout).not.toContain("TARGET_NOT_FOUND");
    expect(result.status).toBe(0);
  }, 40_000);
});
