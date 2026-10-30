import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openGraphDatabase } from "../../graph/db/database.js";
import {
  LOW_VALUE_FOLDER_NAMES,
  SCORE_WEIGHTS,
  WORKSPACE_CONTAINERS,
  areaOf,
  computeSubsystemPlan,
  readTreeImportEdges,
  factBudgetForRank,
  isExcludedSourcePath,
  parseGitCommitFiles,
  rankSubsystemCandidates,
  readGitCommitFiles,
  readGraphSubsystemInputs,
  renderSubsystemCandidates,
  subsystemTarget,
} from "../subsystems.js";

const roots: string[] = [];
function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "mex-subsystems-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function filesIn(folder: string, count: number, ext = "ts"): string[] {
  return Array.from({ length: count }, (_, index) => `${folder}/file${index}.${ext}`);
}

/** `times` commits that each change the first file of every given folder. */
function commitsTouching(folder: string, times: number): string[][] {
  return Array.from({ length: times }, () => [`${folder}/file0.ts`]);
}

describe("subsystemTarget", () => {
  it("gets cheap dependency ranking from relative imports without parsing or opening a graph", () => {
    const root = tempRoot();
    mkdirSync(join(root, "src/feature"), { recursive: true });
    writeFileSync(join(root, "src/feature/index.ts"), "import { value } from '../shared.js'; export { value } from '../shared'; import('external');");
    writeFileSync(join(root, "src/shared.ts"), "export const value = 1;");
    writeFileSync(join(root, "src/large.ts"), " ".repeat(256 * 1024 + 1));
    const edges = readTreeImportEdges(root, ["src/feature/index.ts", "src/shared.ts", "src/large.ts", "src/missing.ts"]);
    expect(edges).toEqual([["src/feature/index.ts", "src/shared.ts"], ["src/feature/index.ts", "src/shared.ts"]]);
  });
  it.each([
    [0, 3, 4], [120, 3, 4], [299, 3, 4], [300, 5, 8], [3000, 5, 8], [3001, 8, 12], [10_000, 8, 12],
  ])("%i source files -> %i to %i subsystems", (files, min, max) => {
    expect(subsystemTarget(files)).toEqual({ min, max });
  });
});

describe("isExcludedSourcePath", () => {
  it.each([
    "src/__tests__/a.ts", "tests/unit/a.py", "src/api/user.test.ts", "pkg/foo_test.go", "pkg/test_user.py",
    "fixtures/app/main.ts", "vendor/lib/x.go", "third_party/a.c", "docs/conf.py", "src/generated/api.ts",
    "src/types/api.d.ts", "dist/index.js", "examples/basic/app.ts", "proto/user_pb2.py", "web/Tests/a.ts", "runtime-tests/a.ts", "perf-measures/a.ts", "src/test_utils/a.py", "app/e2e-suite/a.ts",
  ])("excludes %s", (path) => expect(isExcludedSourcePath(path)).toBe(true));

  it.each(["src/api/user.ts", "src/contest/a.ts", "app/attestation/a.ts", "app/models.py", "lib/core.rb", "cmd/server/main.go"])(
    "keeps %s", (path) => expect(isExcludedSourcePath(path)).toBe(false));

  it("tolerates backslashes and a leading ./", () => {
    expect(isExcludedSourcePath(".\\tests\\a.ts")).toBe(true);
  });
});

describe("factBudgetForRank", () => {
  it("gives the top third 10-15, the middle third 6-10 and the rest 4-6", () => {
    const budgets = Array.from({ length: 12 }, (_, index) => factBudgetForRank(index, 12));
    expect(budgets.slice(0, 4)).toEqual(Array(4).fill({ min: 10, max: 15 }));
    expect(budgets.slice(4, 8)).toEqual(Array(4).fill({ min: 6, max: 10 }));
    expect(budgets.slice(8)).toEqual(Array(4).fill({ min: 4, max: 6 }));
  });

  it("rounds the thirds up for small plans", () => {
    expect([0, 1, 2].map((index) => factBudgetForRank(index, 3))).toEqual([{ min: 10, max: 15 }, { min: 6, max: 10 }, { min: 4, max: 6 }]);
    expect([0, 1, 2, 3].map((index) => factBudgetForRank(index, 4).min)).toEqual([10, 10, 6, 4]);
  });
});

describe("rankSubsystemCandidates: structure", () => {
  it("keeps installed managed skill runtimes out of project coverage and its size target", () => {
    const source = [...filesIn("src/alpha", 3), ...filesIn("src/beta", 3), ...filesIn("src/gamma", 3)];
    const installed = [".claude", ".agents"].flatMap((client) =>
      filesIn(`${client}/skills/mex-statechart/upstream/scripts`, 200, "mjs"));
    expect(rankSubsystemCandidates({ files: [...source, ...installed] }))
      .toEqual(rankSubsystemCandidates({ files: source }));
  });
  it("splits a src wrapper into its folders, ranked by size when there is no history", () => {
    const files = [...filesIn("src/router", 20), ...filesIn("src/http", 12), ...filesIn("src/utils", 5), ...filesIn("scripts", 3)];
    const plan = rankSubsystemCandidates({ files });
    expect(plan.candidates.map((c) => [c.path, c.files, c.commits])).toEqual([
      ["src/router", 20, null], ["src/http", 12, null], ["src/utils", 5, null],
    ]);
    // Three files and no activity: below the plan floor once the target minimum is met.
    expect(plan.candidates.map((c) => c.path)).not.toContain("scripts");
    expect(plan.sourceFiles).toBe(40);
    expect(plan.target).toEqual({ min: 3, max: 4 });
    expect(plan.source).toBe("tree");
    expect(plan.ranking).toBe("size");
  });

  it("keeps top-level folders that are not too big", () => {
    const files = [...filesIn("api", 10), ...filesIn("core", 10), ...filesIn("web", 10), ...filesIn("web/inner", 4)];
    expect(rankSubsystemCandidates({ files }).candidates.map((c) => c.path).sort()).toEqual(["api", "core", "web"]);
  });

  it("splits a big folder at any depth and looks through single-child wrappers", () => {
    const files = [
      ...filesIn("apps/api/src/app/alpha", 40), ...filesIn("apps/api/src/app/beta", 30), ...filesIn("apps/api/src/app/gamma", 20),
      ...filesIn("libs/dal", 20),
    ];
    const plan = rankSubsystemCandidates({ files });
    expect(plan.candidates.map((c) => c.path).sort()).toEqual([
      "apps/api/src/app/alpha", "apps/api/src/app/beta", "apps/api/src/app/gamma", "libs",
    ]);
  });

  it("keeps a folder whole when it is small enough, however many parts it has", () => {
    const files = [...filesIn("lib/a", 10), ...filesIn("lib/b", 10), ...filesIn("lib/c", 10), ...filesIn("ui", 24), ...filesIn("web", 24), ...filesIn("cli", 24)];
    // 102 files / min 3 = 34: lib (30) stays as one area.
    expect(rankSubsystemCandidates({ files }).candidates.map((c) => c.path).sort()).toEqual(["cli", "lib", "ui", "web"]);
  });

  it("repeats the split until each part is under the size limit or cannot be split", () => {
    const files = [
      ...filesIn("pkg/big/inner/one", 25), ...filesIn("pkg/big/inner/two", 25), ...filesIn("pkg/big/flat", 60), ...filesIn("other", 10),
    ];
    const plan = rankSubsystemCandidates({ files });
    // 120 / 3 = 40: pkg/big/flat has no parts and stays whole; the rest splits down to depth 4.
    expect(plan.candidates.map((c) => c.path).sort()).toEqual(["other", "pkg/big/flat", "pkg/big/inner/one", "pkg/big/inner/two"]);
  });

  it("proposes a split folder's own files beside its parts", () => {
    const files = [...filesIn("src", 8), ...filesIn("src/router", 20), ...filesIn("src/jsx", 12), ...filesIn("src/tiny", 1), ...filesIn("docs-site", 3)];
    const plan = rankSubsystemCandidates({ files });
    const own = plan.candidates.find((c) => c.remainder === true)!;
    expect(own).toMatchObject({ path: "src", files: 9 });
    expect(plan.candidates.find((c) => c.path === "src/router")).toMatchObject({ files: 20 });
    expect(renderSubsystemCandidates(plan)).toContain("src/ (its own files and small subfolders) — 9 files");
  });

  it("excludes tests, fixtures, generated, vendored and docs code from counts and candidates", () => {
    const files = [
      ...filesIn("src/auth", 6), ...filesIn("tests", 30), ...filesIn("src/auth/__tests__", 9), ...filesIn("fixtures", 12),
      ...filesIn("src/generated", 20), ...filesIn("vendor/lib", 40), ...filesIn("docs", 10), "src/auth/login.test.ts", "src/api.d.ts",
    ];
    const plan = rankSubsystemCandidates({ files });
    expect(plan.candidates.map((c) => c.path)).toEqual(["src/auth"]);
    // The target scales with every indexed file; only the planned folders are filtered.
    expect(plan.sourceFiles).toBe(new Set(files).size);
  });

  it("sizes the target by indexed files, tests included", () => {
    const files = [...filesIn("src/core", 40), ...filesIn("test/core", 300)];
    const plan = rankSubsystemCandidates({ files });
    expect(plan.sourceFiles).toBe(340);
    expect(plan.target).toEqual({ min: 5, max: 8 });
    expect(plan.candidates.map((c) => c.path)).toEqual(["src/core"]);
  });

  it("drops folders below the minimum size and files directly in the root", () => {
    const plan = rankSubsystemCandidates({ files: ["main.ts", "util.ts", ...filesIn("tiny", 2), ...filesIn("real", 5)] });
    expect(plan.candidates.map((c) => c.path)).toEqual(["real"]);
  });

  it("returns no candidates for an empty or flat repository", () => {
    expect(rankSubsystemCandidates({ files: [] }).candidates).toEqual([]);
    expect(rankSubsystemCandidates({ files: ["a.ts", "b.ts", "c.ts", "d.ts"] }).candidates).toEqual([]);
  });
});

describe("rankSubsystemCandidates: ranking by recent activity", () => {
  const files = [...filesIn("src/core", 20), ...filesIn("src/web", 20), ...filesIn("src/data", 20), ...filesIn("src/cli", 5)];

  it("ranks by commits touching the folder, ahead of size", () => {
    const commits = [...commitsTouching("src/cli", 9), ...commitsTouching("src/web", 5), ...commitsTouching("src/core", 2)];
    const plan = rankSubsystemCandidates({ files, commits });
    expect(plan.ranking).toBe("activity");
    expect(plan.candidates.map((c) => [c.path, c.commits])).toEqual([["src/cli", 9], ["src/web", 5], ["src/core", 2], ["src/data", 0]]);
  });

  it("counts a commit once per folder however many of its files it touches", () => {
    const plan = rankSubsystemCandidates({
      files,
      commits: [["src/core/file0.ts", "src/core/file1.ts", "src/core/file2.ts", "src/web/file0.ts"], ["src/core/file3.ts"]],
    });
    expect(plan.candidates.find((c) => c.path === "src/core")!.commits).toBe(2);
    expect(plan.candidates.find((c) => c.path === "src/web")!.commits).toBe(1);
  });

  it("uses size as the tie-break between equally active folders", () => {
    const plan = rankSubsystemCandidates({
      files: [...filesIn("a", 10), ...filesIn("b", 30), ...filesIn("c", 20)],
      commits: [["a/file0.ts", "b/file0.ts", "c/file0.ts"]],
    });
    expect(plan.candidates.map((c) => c.path)).toEqual(["b", "c", "a"]);
  });

  it("ignores changes to files outside every folder of the plan", () => {
    const plan = rankSubsystemCandidates({ files, commits: [["README.md", "src/gone/old.ts", "tests/a.test.ts"], ["src/data/file1.ts"]] });
    expect(plan.candidates[0]).toMatchObject({ path: "src/data", commits: 1 });
  });

  it("falls back to size for empty history, or history that touches nothing in the plan", () => {
    const bySize = rankSubsystemCandidates({ files }).candidates.map((c) => c.path);
    expect(rankSubsystemCandidates({ files, commits: [] }).ranking).toBe("size");
    expect(rankSubsystemCandidates({ files, commits: [] }).candidates.map((c) => c.path)).toEqual(bySize);
    const none = rankSubsystemCandidates({ files, commits: [["README.md"]] });
    expect(none.ranking).toBe("size");
    expect(none.candidates.map((c) => c.path)).toEqual(bySize);
  });
});

describe("rankSubsystemCandidates: push-down of low-value folders", () => {
  it("documents exactly the agreed folder names", () => {
    expect([...LOW_VALUE_FOLDER_NAMES].sort()).toEqual(
      ["bin", "config", "configs", "devtools", "playground", "sandbox", "scripts", "tooling", "tools"]);
    for (const kept of ["enterprise", "utils", "helpers", "shared", "internal"]) expect(LOW_VALUE_FOLDER_NAMES.has(kept)).toBe(false);
  });

  it("ranks a busy scripts or playground folder below real product code but keeps it", () => {
    const files = [...filesIn("src/core", 20), ...filesIn("src/web", 20), ...filesIn("scripts", 20), ...filesIn("playground", 20)];
    const commits = [...commitsTouching("scripts", 9), ...commitsTouching("playground", 8), ...commitsTouching("src/core", 4), ...commitsTouching("src/web", 3)];
    const plan = rankSubsystemCandidates({ files, commits });
    expect(plan.candidates.map((c) => c.path)).toEqual(["src/core", "src/web", "scripts", "playground"]);
  });

  it("does not push down enterprise or any other folder by guess", () => {
    const files = [...filesIn("enterprise", 20), ...filesIn("src/core", 20), ...filesIn("src/web", 20)];
    const plan = rankSubsystemCandidates({ files, commits: [...commitsTouching("enterprise", 9), ...commitsTouching("src/core", 4)] });
    expect(plan.candidates[0]!.path).toBe("enterprise");
  });

  it("matches whole folder names, case-insensitively, anywhere in the path", () => {
    const files = [...filesIn("src/core", 20), ...filesIn("src/Config", 20), ...filesIn("src/configuration", 20), ...filesIn("src/web", 20)];
    const commits = [...commitsTouching("src/Config", 5), ...commitsTouching("src/configuration", 5), ...commitsTouching("src/core", 4), ...commitsTouching("src/web", 4)];
    const order = rankSubsystemCandidates({ files, commits }).candidates.map((c) => c.path);
    expect(order.indexOf("src/configuration")).toBeLessThan(order.indexOf("src/Config"));
    expect(order.indexOf("src/Config")).toBe(3);
  });
});

describe("rankSubsystemCandidates: the fixed plan", () => {
  it("gives every subsystem a fact budget by rank", () => {
    const files = Array.from({ length: 12 }, (_, i) => filesIn(`area${String(i).padStart(2, "0")}`, 300)).flat();
    const plan = rankSubsystemCandidates({ files });
    expect(plan.target).toEqual({ min: 8, max: 12 });
    expect(plan.candidates).toHaveLength(12);
    expect(plan.candidates.map((c) => c.budget.min)).toEqual([10, 10, 10, 10, 6, 6, 6, 6, 4, 4, 4, 4]);
    expect(plan.candidates.map((c) => c.budget.max)).toEqual([15, 15, 15, 15, 10, 10, 10, 10, 6, 6, 6, 6]);
  });

  it("keeps at most the target maximum, however many folders exist", () => {
    const files = Array.from({ length: 12 }, (_, i) => filesIn(`mod${String(i).padStart(2, "0")}`, 5)).flat();
    const plan = rankSubsystemCandidates({ files });
    expect(plan.target).toEqual({ min: 3, max: 4 });
    expect(plan.candidates).toHaveLength(4);
  });

  it("scales the target with the number of source files", () => {
    const medium = Array.from({ length: 10 }, (_, i) => filesIn(`area${i}`, 60)).flat();
    const mediumPlan = rankSubsystemCandidates({ files: medium });
    expect(mediumPlan.target).toEqual({ min: 5, max: 8 });
    expect(mediumPlan.candidates).toHaveLength(8);
  });

  it("drops tiny folders with no recent activity, but never below the target minimum", () => {
    const files = [...filesIn("a", 10), ...filesIn("b", 8), ...filesIn("c", 6), ...filesIn("tiny", 3)];
    const commits = [...commitsTouching("a", 3), ...commitsTouching("b", 2), ...commitsTouching("c", 1)];
    expect(rankSubsystemCandidates({ files, commits }).candidates.map((c) => c.path)).toEqual(["a", "b", "c"]);
    // A tiny folder with recent commits stays.
    const active = rankSubsystemCandidates({ files, commits: [...commits, ...commitsTouching("tiny", 1)] });
    expect(active.candidates.map((c) => c.path)).toContain("tiny");
    // Too few other folders: the tiny ones fill the minimum.
    const sparse = rankSubsystemCandidates({ files: [...filesIn("a", 10), ...filesIn("t1", 3), ...filesIn("t2", 3)], commits: commitsTouching("a", 2) });
    expect(sparse.candidates.map((c) => c.path)).toEqual(["a", "t1", "t2"]);
  });

  it("is deterministic, independent of input order, and JSON-serializable", () => {
    const files = [...filesIn("b", 4), ...filesIn("a", 4), ...filesIn("c", 4)];
    const commits = [["a/file0.ts", "c/file1.ts"], ["b/file0.ts"]];
    const first = rankSubsystemCandidates({ files, commits });
    expect(first.candidates.map((c) => [c.path, c.commits])).toEqual([["a", 1], ["b", 1], ["c", 1]]);
    expect(rankSubsystemCandidates({ files: [...files].reverse(), commits })).toEqual(first);
    expect(JSON.parse(JSON.stringify(first))).toEqual(first);
  });

  it("breaks full ties by path", () => {
    const plan = rankSubsystemCandidates({ files: [...filesIn("b", 4), ...filesIn("a", 4), ...filesIn("c", 4)] });
    expect(plan.candidates.map((c) => c.path)).toEqual(["a", "b", "c"]);
  });

  it("renders path, files and budget in plan order, without fan-in", () => {
    const plan = rankSubsystemCandidates({ files: [...filesIn("src/a", 4), ...filesIn("src/b", 6)] });
    expect(renderSubsystemCandidates(plan)).toBe(" 1. src/b/ — 6 files, 10 to 15 facts\n 2. src/a/ — 4 files, 6 to 10 facts");
    expect(renderSubsystemCandidates(plan)).not.toContain("fan-in");
  });
});

describe("areaOf", () => {
  it("is the workspace folder under a monorepo container, else the top-level folder", () => {
    expect(areaOf("apps/dashboard/src/components")).toBe("apps/dashboard");
    expect(areaOf("libs/dal")).toBe("libs/dal");
    expect(areaOf("packages/framework/src")).toBe("packages/framework");
    expect(areaOf("src/router")).toBe("src");
    expect(areaOf("src")).toBe("src");
    expect(areaOf("apps")).toBe("apps");
    expect(areaOf("Apps/web/x")).toBe("Apps/web");
    expect(WORKSPACE_CONTAINERS.has("src")).toBe(false);
  });
});

describe("rankSubsystemCandidates: the blended score", () => {
  it("weights activity first, then size, then fan-in, summing to one", () => {
    expect(SCORE_WEIGHTS.activity).toBeGreaterThan(SCORE_WEIGHTS.size);
    expect(SCORE_WEIGHTS.size).toBeGreaterThanOrEqual(SCORE_WEIGHTS.fanIn);
    expect(SCORE_WEIGHTS.activity + SCORE_WEIGHTS.size + SCORE_WEIGHTS.fanIn).toBeCloseTo(1, 10);
  });

  const files = [...filesIn("src/a", 20), ...filesIn("src/b", 20), ...filesIn("src/c", 20), ...filesIn("src/d", 20)];

  it("ranks a folder many outside files depend on above an equally active, equally big one", () => {
    const edges: Array<[string, string]> = [];
    for (let i = 0; i < 10; i++) edges.push([`src/a/file${i}.ts`, "src/c/file0.ts"]);
    for (let i = 0; i < 3; i++) edges.push([`src/b/file${i}.ts`, "src/d/file0.ts"]);
    const commits = [["src/a/file0.ts", "src/b/file0.ts", "src/c/file0.ts", "src/d/file0.ts"]];
    const plan = rankSubsystemCandidates({ files, commits, fileEdges: edges });
    expect(plan.candidates.map((c) => [c.path, c.fanIn])).toEqual([["src/c", 10], ["src/d", 3], ["src/a", 0], ["src/b", 0]]);
  });

  it("counts each outside file once and ignores edges inside the folder", () => {
    const plan = rankSubsystemCandidates({
      files,
      fileEdges: [["src/a/file0.ts", "src/b/file0.ts"], ["src/a/file0.ts", "src/b/file1.ts"], ["src/b/file2.ts", "src/b/file3.ts"]],
    });
    expect(plan.candidates.find((c) => c.path === "src/b")!.fanIn).toBe(1);
    expect(plan.candidates.find((c) => c.path === "src/a")!.fanIn).toBe(0);
  });

  it("leaves fan-in out without a graph, and the score still ranks", () => {
    const plan = rankSubsystemCandidates({ files, commits: commitsTouching("src/d", 2) });
    expect(plan.candidates.every((c) => c.fanIn === null)).toBe(true);
    expect(plan.candidates[0]!.path).toBe("src/d");
  });

  it("lets recent activity outweigh a larger size and a higher fan-in", () => {
    const big = [...filesIn("src/big", 60), ...filesIn("src/busy", 20), ...filesIn("src/x", 20), ...filesIn("src/y", 20)];
    const edges: Array<[string, string]> = Array.from({ length: 8 }, (_, i): [string, string] => [`src/x/file${i}.ts`, "src/big/file0.ts"]);
    const plan = rankSubsystemCandidates({ files: big, fileEdges: edges, commits: commitsTouching("src/busy", 6) });
    expect(plan.candidates[0]!.path).toBe("src/busy");
  });

  it("falls back to size and fan-in alone when there is no history", () => {
    const plan = rankSubsystemCandidates({ files, fileEdges: [["src/a/file0.ts", "src/b/file0.ts"]] });
    expect(plan.ranking).toBe("size");
    expect(plan.candidates[0]!.path).toBe("src/b");
  });
});

describe("rankSubsystemCandidates: the area cap", () => {
  const modules = ["m1", "m2", "m3", "m4", "m5", "m6"];
  const others = ["libs/dal", "libs/auth", "packages/fw", "packages/sdk", "apps/api"];
  const monorepo = [...modules.flatMap((m) => filesIn(`apps/dash/src/${m}`, 50)), ...others.flatMap((o) => filesIn(o, 70))];
  const dashCommits = modules.flatMap((m, i) => commitsTouching(`apps/dash/src/${m}`, 30 - i));
  const dashPaths = (plan: ReturnType<typeof rankSubsystemCandidates>) => plan.candidates.map((c) => c.path).filter((p) => p.startsWith("apps/dash"));

  it("keeps one busy workspace from taking more than a third of the slots", () => {
    const plan = rankSubsystemCandidates({ files: monorepo, commits: dashCommits });
    expect(plan.target).toEqual({ min: 5, max: 8 });
    expect(plan.candidates).toHaveLength(8);
    // ceil(8 / 3) = 3, and they are the three most active modules, in rank order.
    expect(dashPaths(plan)).toEqual(["apps/dash/src/m1", "apps/dash/src/m2", "apps/dash/src/m3"]);
  });

  it("fills the freed slots with the best candidates of other areas", () => {
    const plan = rankSubsystemCandidates({ files: monorepo, commits: dashCommits });
    const rest = plan.candidates.map((c) => c.path).filter((p) => !p.startsWith("apps/dash")).sort();
    expect(rest).toEqual(["apps/api", "libs/auth", "libs/dal", "packages/fw", "packages/sdk"]);
    // Without the cap the dashboard would hold every slot its activity earns.
    expect(plan.candidates.slice(0, 3).every((c) => c.path.startsWith("apps/dash"))).toBe(true);
  });

  it("scales with the number of slots: two of four on a small repository", () => {
    const small = [
      ...["m1", "m2", "m3"].flatMap((m) => filesIn(`apps/dash/src/${m}`, 30)),
      ...["libs/dal", "libs/auth", "packages/fw"].flatMap((o) => filesIn(o, 30)),
    ];
    const plan = rankSubsystemCandidates({ files: small, commits: dashCommits });
    expect(plan.target).toEqual({ min: 3, max: 4 });
    expect(plan.candidates).toHaveLength(4);
    expect(dashPaths(plan)).toHaveLength(2);
  });

  it("counts a workspace folder as one area however deep its modules are", () => {
    expect(new Set(dashPaths(rankSubsystemCandidates({ files: monorepo, commits: dashCommits })).map(areaOf))).toEqual(new Set(["apps/dash"]));
  });

  it("relaxes the cap when other areas cannot fill the slots", () => {
    const files = [...modules.flatMap((m) => filesIn(`apps/dash/src/${m}`, 50)), ...filesIn("libs/dal", 70)];
    const plan = rankSubsystemCandidates({ files, commits: dashCommits });
    expect(plan.candidates).toHaveLength(7);
    expect(dashPaths(plan)).toHaveLength(6);
  });

  it("does not apply to a single-package repository, whose folders are all under src", () => {
    const src = Array.from({ length: 8 }, (_, i) => filesIn(`src/mod${i}`, 40)).flat();
    const plan = rankSubsystemCandidates({ files: src, commits: commitsTouching("src/mod0", 3) });
    expect(plan.candidates).toHaveLength(8);
    expect(plan.candidates.every((c) => c.path.startsWith("src/"))).toBe(true);
  });

  it("is deterministic and keeps the plan JSON-serializable", () => {
    const input = { files: monorepo, commits: dashCommits, fileEdges: [["libs/dal/file0.ts", "packages/fw/file0.ts"]] as Array<[string, string]> };
    const first = rankSubsystemCandidates(input);
    expect(rankSubsystemCandidates({ ...input, files: [...monorepo].reverse() })).toEqual(first);
    expect(JSON.parse(JSON.stringify(first))).toEqual(first);
  });
});

describe("git history reading", () => {
  const git = (root: string, ...args: string[]): void => {
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: root, stdio: "ignore" });
  };
  function write(root: string, path: string, text = "x"): void {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  function repoWithHistory(): string {
    const root = tempRoot();
    execFileSync("git", ["init", "-q"], { cwd: root });
    for (const path of [...filesIn("src/a", 5), ...filesIn("src/b", 5), ...filesIn("src/c", 5)]) write(root, path);
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "initial");
    for (let i = 1; i <= 3; i++) {
      write(root, "src/b/file0.ts", `v${i}`);
      git(root, "commit", "-q", "-am", `b ${i}`);
    }
    write(root, "src/c/file0.ts", "v1");
    git(root, "commit", "-q", "-am", "c 1");
    return root;
  }

  it("parses marker-separated commit output", () => {
    expect(parseGitCommitFiles("\u0001\nsrc/a.ts\nsrc/b.ts\n\u0001\nsrc/c.ts\n\u0001\n\n")).toEqual([["src/a.ts", "src/b.ts"], ["src/c.ts"]]);
    expect(parseGitCommitFiles("")).toEqual([]);
  });

  it("reads one commit entry per commit, newest first", () => {
    const commits = readGitCommitFiles(repoWithHistory())!;
    expect(commits).toHaveLength(5);
    expect(commits[0]).toEqual(["src/c/file0.ts"]);
    expect(commits[4]).toHaveLength(15);
  });

  it("ranks a real repository by its recent commits", () => {
    const plan = computeSubsystemPlan(repoWithHistory())!;
    expect(plan.ranking).toBe("activity");
    expect(plan.candidates.map((c) => [c.path, c.commits])).toEqual([["src/b", 4], ["src/c", 2], ["src/a", 1]]);
  });

  it("takes the git root, a starting revision and a date from the caller", () => {
    const root = repoWithHistory();
    const outside = tempRoot();
    for (const path of [...filesIn("src/a", 5), ...filesIn("src/b", 5), ...filesIn("src/c", 5)]) write(outside, path);
    const upToThirdCommit = readGitCommitFiles(outside, { gitRoot: root, revision: "HEAD~2" })!;
    expect(upToThirdCommit).toHaveLength(3);
    const plan = computeSubsystemPlan(outside, { gitRoot: root, revision: "HEAD~2" })!;
    expect(plan.candidates.map((c) => [c.path, c.commits])).toEqual([["src/b", 3], ["src/a", 1], ["src/c", 1]]);
  });

  it("reports paths relative to the project folder inside a larger repository", () => {
    const root = repoWithHistory();
    const commits = readGitCommitFiles(join(root, "src", "b"))!;
    expect(commits.flat().every((path) => path.startsWith("file"))).toBe(true);
  });

  it("falls back to size without Git, with a bad revision, or with an unusable git root", () => {
    const plain = tempRoot();
    for (const path of [...filesIn("src/a", 5), ...filesIn("src/b", 4)]) write(plain, path);
    expect(readGitCommitFiles(plain)).toBeNull();
    expect(computeSubsystemPlan(plain)!.ranking).toBe("size");
    const root = repoWithHistory();
    expect(readGitCommitFiles(root, { revision: "no-such-revision" })).toBeNull();
    expect(readGitCommitFiles(root, { revision: "--output=oops" })).toBeNull();
    expect(readGitCommitFiles(root, { gitRoot: join(root, "does-not-exist") })).toBeNull();
    expect(computeSubsystemPlan(plain, { gitRoot: join(plain, "missing") })!.ranking).toBe("size");
  });

  it("returns null for an empty repository with no commits", () => {
    const root = tempRoot();
    execFileSync("git", ["init", "-q"], { cwd: root });
    expect(readGitCommitFiles(root)).toBeNull();
  });
});

function insertNode(db: ReturnType<typeof openGraphDatabase>, id: string, file: string): void {
  db.prepare(`INSERT INTO nodes (id, kind, name, qualified_name, identity_key, file_path, language, start_line, end_line,
    start_column, end_column, updated_at) VALUES (?, 'function', ?, ?, ?, ?, 'typescript', 1, 2, 0, 0, 0)`).run(id, id, id, id, file);
}

function buildFixtureGraph(root: string, files: string[]): void {
  const mex = join(root, ".mex");
  mkdirSync(mex, { recursive: true });
  const db = openGraphDatabase(join(mex, "graph.db"));
  try {
    const insertFile = db.prepare("INSERT INTO files (path, content_hash, language, size, modified_at, indexed_at) VALUES (?, 'h', 'typescript', 1, 0, 0)");
    for (const file of files) {
      insertFile.run(file);
      insertNode(db, `fn:${file}`, file);
    }
  } finally {
    db.close();
  }
}

describe("graph-backed plan", () => {
  it("reads the indexed files from the built graph", () => {
    const root = tempRoot();
    const files = [...filesIn("src/a", 4), ...filesIn("src/b", 4)];
    buildFixtureGraph(root, files);
    const inputs = readGraphSubsystemInputs(root)!;
    expect([...inputs.files].sort()).toEqual([...files].sort());
    const plan = computeSubsystemPlan(root)!;
    expect(plan.source).toBe("graph");
    expect(plan.candidates.map((c) => c.path).sort()).toEqual(["src/a", "src/b"]);
  });

  it("returns null when the graph is missing or unreadable", () => {
    const root = tempRoot();
    expect(readGraphSubsystemInputs(root)).toBeNull();
    mkdirSync(join(root, ".mex"), { recursive: true });
    writeFileSync(join(root, ".mex", "graph.db"), "not a database");
    expect(readGraphSubsystemInputs(root)).toBeNull();
  });
});

describe("source-tree fallback", () => {
  function write(root: string, path: string): void {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), "x");
  }

  it("lists source files from the tree when no graph exists, skipping excluded folders", () => {
    const root = tempRoot();
    for (const path of [...filesIn("src/core", 5), ...filesIn("src/web", 4), ...filesIn("node_modules/dep", 30), ...filesIn("tests", 9)]) write(root, path);
    write(root, "src/core/readme.md");
    const plan = computeSubsystemPlan(root)!;
    expect(plan.source).toBe("tree");
    expect(plan.candidates.map((c) => [c.path, c.files, c.commits])).toEqual([["src/core", 5, null], ["src/web", 4, null]]);
  });

  it("uses the Git listing when available, so ignored folders stay out", () => {
    const root = tempRoot();
    execFileSync("git", ["init", "-q"], { cwd: root });
    writeFileSync(join(root, ".gitignore"), "generated-out/\n");
    for (const path of [...filesIn("src/core", 5), ...filesIn("generated-out", 20)]) write(root, path);
    const plan = computeSubsystemPlan(root)!;
    expect(plan.candidates.map((c) => c.path)).toEqual(["src/core"]);
  });

  it("returns null for a project with no source", () => {
    const root = tempRoot();
    write(root, "README.md");
    expect(computeSubsystemPlan(root)).toBeNull();
  });

  it("never throws, even for a project folder that does not exist", () => {
    expect(computeSubsystemPlan(join(tempRoot(), "missing"))).toBeNull();
  });
});
