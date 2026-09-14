import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { checkPaths } from "../src/drift/checkers/path.js";
import { checkEdges } from "../src/drift/checkers/edges.js";
import { checkCommands } from "../src/drift/checkers/command.js";
import { checkDependencies } from "../src/drift/checkers/dependency.js";
import { checkCrossFile } from "../src/drift/checkers/cross-file.js";
import { checkIndexSync } from "../src/drift/checkers/index-sync.js";
import { checkStalePatterns } from "../src/drift/checkers/stale-pattern.js";
import { checkFrontmatterCompleteness } from "../src/drift/checkers/frontmatter-completeness.js";
import { checkToolConfigSync } from "../src/drift/checkers/tool-config-sync.js";
import { checkTodoFixme } from "../src/drift/checkers/todo-fixme.js";
import { checkBrokenLinks } from "../src/drift/checkers/broken-link.js";
import type { Claim, ScaffoldFrontmatter } from "../src/types.js";

vi.mock("../src/git.js", () => ({
  daysSinceLastChange: vi.fn(),
  commitsSinceLastChange: vi.fn(),
}));
const gitMock = await import("../src/git.js");
const { checkStaleness } = await import("../src/drift/checkers/staleness.js");

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "mex-checker-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function claim(overrides: Partial<Claim> & { kind: Claim["kind"]; value: string }): Claim {
  return {
    source: "test.md",
    line: 1,
    section: null,
    negated: false,
    ...overrides,
  };
}

// ── Path Checker ──

describe("checkPaths", () => {
  it("reports missing paths", () => {
    const claims = [claim({ kind: "path", value: "src/missing.ts" })];
    const issues = checkPaths(claims, tmpDir, tmpDir);
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe("MISSING_PATH");
  });

  it("skips runtime paths the repository ignores", () => {
    execFileSync("git", ["init", "-q"], { cwd: tmpDir });
    writeFileSync(join(tmpDir, ".gitignore"), "generated/\n*.db\n");
    const claims = [
      claim({ kind: "path", value: "generated/" }),
      claim({ kind: "path", value: "graph.db" }),
    ];
    expect(checkPaths(claims, tmpDir, tmpDir)).toHaveLength(0);
  });

  it("finds a scaffold file named from another scaffold file", () => {
    const mexDir = join(tmpDir, ".mex");
    mkdirSync(join(mexDir, "patterns"), { recursive: true });
    writeFileSync(join(mexDir, "patterns/INDEX.md"), "");
    const claims = [claim({ kind: "path", value: "INDEX.md" })];
    expect(checkPaths(claims, tmpDir, mexDir)).toHaveLength(0);
  });

  it("resolves a path written from a subproject's own root", () => {
    mkdirSync(join(tmpDir, "server/src/routes"), { recursive: true });
    writeFileSync(join(tmpDir, "server/src/routes/quiz.ts"), "");
    const claims = [claim({ kind: "path", value: "routes/quiz.ts" })];
    expect(checkPaths(claims, tmpDir, tmpDir)).toHaveLength(0);
  });

  it("skips API routes and placeholders whose first segment does not exist", () => {
    const claims = [
      claim({ kind: "path", value: "documents/upload" }),
      claim({ kind: "path", value: "owner/repo" }),
    ];
    expect(checkPaths(claims, tmpDir, tmpDir)).toHaveLength(0);
  });

  it("still reports a missing path under a directory that does exist", () => {
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    const claims = [claim({ kind: "path", value: "src/missing.ts" })];
    const issues = checkPaths(claims, tmpDir, tmpDir);
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe("MISSING_PATH");
  });

  it("skips naming-convention examples", () => {
    const claims = [claim({ kind: "path", value: "PascalCase.tsx" })];
    expect(checkPaths(claims, tmpDir, tmpDir)).toHaveLength(0);
  });

  it("passes for existing paths", () => {
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    writeFileSync(join(tmpDir, "src/index.ts"), "");
    const claims = [claim({ kind: "path", value: "src/index.ts" })];
    const issues = checkPaths(claims, tmpDir, tmpDir);
    expect(issues).toHaveLength(0);
  });

  it("skips negated claims", () => {
    const claims = [
      claim({ kind: "path", value: "src/missing.ts", negated: true }),
    ];
    const issues = checkPaths(claims, tmpDir, tmpDir);
    expect(issues).toHaveLength(0);
  });

  it("resolves .mex/ prefixed paths to root", () => {
    writeFileSync(join(tmpDir, "ROUTER.md"), "# Router");
    const claims = [claim({ kind: "path", value: ".mex/ROUTER.md" })];
    const issues = checkPaths(claims, tmpDir, tmpDir);
    expect(issues).toHaveLength(0);
  });

  it("resolves paths relative to scaffoldRoot when deployed as .mex/", () => {
    const mexDir = join(tmpDir, ".mex");
    mkdirSync(join(mexDir, "context"), { recursive: true });
    writeFileSync(join(mexDir, "context/architecture.md"), "# Arch");
    const claims = [claim({ kind: "path", value: "context/architecture.md" })];
    const issues = checkPaths(claims, tmpDir, mexDir);
    expect(issues).toHaveLength(0);
  });

  it("downgrades to warning for paths from pattern files", () => {
    const claims = [claim({ kind: "path", value: "src/missing.ts", source: "patterns/add-feature.md" })];
    const issues = checkPaths(claims, tmpDir, tmpDir);
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe("warning");
  });

  it("downgrades to warning for paths with placeholder words", () => {
    const claims = [
      claim({ kind: "path", value: "api_clients/new_service_client.py" }),
      claim({ kind: "path", value: "src/example_module.ts" }),
      claim({ kind: "path", value: "lib/your_config.json" }),
    ];
    const issues = checkPaths(claims, tmpDir, tmpDir);
    expect(issues).toHaveLength(3);
    for (const issue of issues) {
      expect(issue.severity).toBe("warning");
    }
  });

  it("reports error for bare filenames not found anywhere", () => {
    const claims = [
      claim({ kind: "path", value: "conversation_state.py", source: "context/architecture.md" }),
      claim({ kind: "path", value: "server.py", source: "context/architecture.md" }),
    ];
    const issues = checkPaths(claims, tmpDir, tmpDir);
    expect(issues).toHaveLength(2);
    for (const issue of issues) {
      expect(issue.severity).toBe("error");
    }
  });

  it("keeps error severity for real missing paths with directories", () => {
    const claims = [claim({ kind: "path", value: "src/auth/handler.ts", source: "context/architecture.md" })];
    const issues = checkPaths(claims, tmpDir, tmpDir);
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe("error");
  });

  it("skips URL values instead of reporting missing paths", () => {
    const claims = [
      claim({ kind: "path", value: "https://example.com/docs" }),
      claim({ kind: "path", value: "http://localhost:3000/api" }),
      claim({ kind: "path", value: "ftp://files.example.com/readme.txt" }),
      claim({ kind: "path", value: "file:///etc/hosts" }),
      claim({ kind: "path", value: "//cdn.example.com/assets/app.js" }),
    ];
    const issues = checkPaths(claims, tmpDir, tmpDir);
    expect(issues).toHaveLength(0);
  });

  it("resolves workspace package aliases from package.json workspaces", () => {
    mkdirSync(join(tmpDir, "packages/ui"), { recursive: true });
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({ workspaces: ["packages/*"] })
    );
    writeFileSync(
      join(tmpDir, "packages/ui/package.json"),
      JSON.stringify({ name: "@acme/ui" })
    );
    const claims = [
      claim({ kind: "path", value: "@acme/ui/button" }),
      claim({ kind: "path", value: "@acme/ui" }),
    ];
    const issues = checkPaths(claims, tmpDir, tmpDir);
    expect(issues).toHaveLength(0);
  });

  it("resolves workspace package aliases from pnpm-workspace.yaml", () => {
    mkdirSync(join(tmpDir, "packages/shared"), { recursive: true });
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "root" }));
    writeFileSync(
      join(tmpDir, "pnpm-workspace.yaml"),
      "packages:\n  - 'packages/*'\n"
    );
    writeFileSync(
      join(tmpDir, "packages/shared/package.json"),
      JSON.stringify({ name: "@acme/shared" })
    );
    const claims = [claim({ kind: "path", value: "@acme/shared/types" })];
    const issues = checkPaths(claims, tmpDir, tmpDir);
    expect(issues).toHaveLength(0);
  });

  it("resolves installed scoped packages via require.resolve", () => {
    const pkgDir = join(tmpDir, "node_modules/@scope/pkg");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
      join(pkgDir, "package.json"),
      JSON.stringify({ name: "@scope/pkg", main: "index.js" })
    );
    writeFileSync(join(pkgDir, "index.js"), "module.exports = {};\n");
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "test-root" }));

    const claims = [claim({ kind: "path", value: "@scope/pkg/lib" })];
    const issues = checkPaths(claims, tmpDir, tmpDir);
    expect(issues).toHaveLength(0);
  });
});

// ── Edges Checker ──

describe("checkEdges", () => {
  it("reports dead edge targets", () => {
    const fm: ScaffoldFrontmatter = {
      edges: [{ target: "context/missing.md" }],
    };
    const issues = checkEdges(fm, "router.md", "ROUTER.md", tmpDir, tmpDir);
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe("DEAD_EDGE");
  });

  it("passes for existing edge targets", () => {
    mkdirSync(join(tmpDir, "context"), { recursive: true });
    writeFileSync(join(tmpDir, "context/arch.md"), "");
    const fm: ScaffoldFrontmatter = {
      edges: [{ target: "context/arch.md" }],
    };
    const issues = checkEdges(fm, "router.md", "ROUTER.md", tmpDir, tmpDir);
    expect(issues).toHaveLength(0);
  });

  it("resolves edge targets relative to scaffoldRoot", () => {
    const mexDir = join(tmpDir, ".mex");
    mkdirSync(join(mexDir, "context"), { recursive: true });
    writeFileSync(join(mexDir, "context/stack.md"), "");
    const fm: ScaffoldFrontmatter = {
      edges: [{ target: "context/stack.md" }],
    };
    const issues = checkEdges(fm, "router.md", "ROUTER.md", tmpDir, mexDir);
    expect(issues).toHaveLength(0);
  });

  it("resolves an edge target relative to the file that declares it", () => {
    const mexDir = join(tmpDir, ".mex");
    mkdirSync(join(mexDir, "context"), { recursive: true });
    mkdirSync(join(mexDir, "patterns"), { recursive: true });
    writeFileSync(join(mexDir, "context/architecture.md"), "");
    const file = join(mexDir, "patterns/durable-change-signal.md");
    writeFileSync(file, "");
    const fm: ScaffoldFrontmatter = {
      edges: [{ target: "../context/architecture.md" }],
    };
    const issues = checkEdges(fm, file, ".mex/patterns/durable-change-signal.md", tmpDir, mexDir);
    expect(issues).toHaveLength(0);
  });

  it("resolves a sibling edge target from inside patterns/", () => {
    const mexDir = join(tmpDir, ".mex");
    mkdirSync(join(mexDir, "patterns"), { recursive: true });
    writeFileSync(join(mexDir, "patterns/safe-graph-snapshot-evolution.md"), "");
    const file = join(mexDir, "patterns/durable-change-signal.md");
    writeFileSync(file, "");
    const fm: ScaffoldFrontmatter = {
      edges: [{ target: "safe-graph-snapshot-evolution.md" }],
    };
    const issues = checkEdges(fm, file, ".mex/patterns/durable-change-signal.md", tmpDir, mexDir);
    expect(issues).toHaveLength(0);
  });

  it("still reports an edge target that resolves nowhere", () => {
    const mexDir = join(tmpDir, ".mex");
    mkdirSync(join(mexDir, "patterns"), { recursive: true });
    const file = join(mexDir, "patterns/example.md");
    writeFileSync(file, "");
    const fm: ScaffoldFrontmatter = {
      edges: [{ target: "../context/nowhere.md" }],
    };
    const issues = checkEdges(fm, file, ".mex/patterns/example.md", tmpDir, mexDir);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      code: "DEAD_EDGE",
      file: ".mex/patterns/example.md",
      message: "Frontmatter edge target does not exist: ../context/nowhere.md",
    });
  });

  it("returns empty for no frontmatter", () => {
    expect(checkEdges(null, "f", "f", tmpDir, tmpDir)).toEqual([]);
  });

  it("returns empty for no edges", () => {
    expect(checkEdges({ name: "test" }, "f", "f", tmpDir, tmpDir)).toEqual([]);
  });
});

// ── Frontmatter Completeness Checker ──

describe("checkFrontmatterCompleteness", () => {
  it("flags missing recommended fields in a context file", () => {
    const fm: ScaffoldFrontmatter = { name: "stack" };
    const issues = checkFrontmatterCompleteness(fm, "context/stack.md");
    expect(issues).toHaveLength(2);
    expect(issues.map((i) => i.code)).toEqual(["MISSING_FRONTMATTER_FIELD", "MISSING_FRONTMATTER_FIELD"]);
    expect(issues[0].severity).toBe("warning");
  });

  it("flags missing recommended fields in a pattern file", () => {
    const fm: ScaffoldFrontmatter = { name: "auth", description: "Auth pattern" };
    const issues = checkFrontmatterCompleteness(fm, "patterns/auth.md");
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain("last_updated");
  });

  it("passes when all recommended fields exist", () => {
    const fm: ScaffoldFrontmatter = {
      name: "stack",
      description: "Tech stack",
      last_updated: "2026-01-01",
    };
    const issues = checkFrontmatterCompleteness(fm, "context/stack.md");
    expect(issues).toHaveLength(0);
  });

  it("ignores files outside context/ and patterns/", () => {
    const issues = checkFrontmatterCompleteness({}, "ROUTER.md");
    expect(issues).toHaveLength(0);
  });

  it("ignores files with no frontmatter outside context/ and patterns/", () => {
    expect(checkFrontmatterCompleteness(null, "ROUTER.md")).toEqual([]);
  });

  it("flags all three fields when an in-scope file has no frontmatter at all", () => {
    const issues = checkFrontmatterCompleteness(null, "context/stack.md");
    expect(issues).toHaveLength(3);
    expect(issues.every((i) => i.code === "MISSING_FRONTMATTER_FIELD")).toBe(true);
  });

  it("exempts patterns/INDEX.md and patterns/README.md, which ship without frontmatter", () => {
    expect(checkFrontmatterCompleteness(null, "patterns/INDEX.md")).toEqual([]);
    expect(checkFrontmatterCompleteness(null, "patterns/README.md")).toEqual([]);
    expect(checkFrontmatterCompleteness(null, ".mex/patterns/INDEX.md")).toEqual([]);
  });

  it("still checks same-named files under context/, which the exemption must not cover", () => {
    for (const source of ["context/README.md", "context/INDEX.md", ".mex/context/README.md"]) {
      const issues = checkFrontmatterCompleteness(null, source);
      expect(issues).toHaveLength(3);
      expect(issues.every((i) => i.code === "MISSING_FRONTMATTER_FIELD")).toBe(true);
    }
  });
});

// ── Command Checker ──

describe("checkCommands", () => {
  it("reports dead npm scripts", () => {
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({ scripts: { build: "tsc" } })
    );
    const claims = [claim({ kind: "command", value: "npm run test" })];
    const issues = checkCommands(claims, tmpDir);
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe("DEAD_COMMAND");
  });

  it("passes for existing npm scripts", () => {
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({ scripts: { build: "tsc", test: "vitest" } })
    );
    const claims = [
      claim({ kind: "command", value: "npm run build" }),
      claim({ kind: "command", value: "npm run test" }),
    ];
    const issues = checkCommands(claims, tmpDir);
    expect(issues).toHaveLength(0);
  });

  it("reports dead make targets", () => {
    writeFileSync(join(tmpDir, "Makefile"), "build:\n\tgcc main.c\n");
    const claims = [claim({ kind: "command", value: "make deploy" })];
    const issues = checkCommands(claims, tmpDir);
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe("DEAD_COMMAND");
  });

  it("skips when no manifest exists", () => {
    const claims = [claim({ kind: "command", value: "npm run build" })];
    const issues = checkCommands(claims, tmpDir);
    expect(issues).toHaveLength(0);
  });
});

// ── Dependency Checker ──

describe("checkDependencies", () => {
  it("reports missing dependencies", () => {
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({ dependencies: { express: "^4.18.0" } })
    );
    const claims = [claim({ kind: "dependency", value: "Prisma" })];
    const issues = checkDependencies(claims, tmpDir);
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe("DEPENDENCY_MISSING");
  });

  it("passes for existing dependencies (case-insensitive)", () => {
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({ dependencies: { express: "^4.18.0" } })
    );
    const claims = [claim({ kind: "dependency", value: "Express" })];
    const issues = checkDependencies(claims, tmpDir);
    expect(issues).toHaveLength(0);
  });

  it("returns empty when no manifest exists", () => {
    const claims = [claim({ kind: "dependency", value: "Express" })];
    const issues = checkDependencies(claims, tmpDir);
    expect(issues).toHaveLength(0);
  });

  it("checks claims against pyproject.toml [project] dependencies (#3)", () => {
    writeFileSync(join(tmpDir, "pyproject.toml"), [
      "[project]",
      'name = "svc"',
      'dependencies = ["fastapi>=0.115", "celery[redis]==5.4.0"]',
      "",
    ].join("\n"));
    const issues = checkDependencies([
      claim({ kind: "dependency", value: "FastAPI" }),
      claim({ kind: "dependency", value: "celery" }),
      claim({ kind: "dependency", value: "boto3" }),
    ], tmpDir);
    expect(issues).toHaveLength(1);
    expect(issues[0].claim.value).toBe("boto3");
  });

  it("reads pyproject optional-dependencies and poetry tables", () => {
    writeFileSync(join(tmpDir, "pyproject.toml"), [
      "[project.optional-dependencies]",
      'dev = ["pytest>=8.0", "httpx"]',
      "",
      "[tool.poetry.dependencies]",
      'python = "^3.12"',
      'SQLAlchemy = "^2.0"',
      "",
    ].join("\n"));
    const issues = checkDependencies([
      claim({ kind: "dependency", value: "pytest" }),
      claim({ kind: "dependency", value: "httpx" }),
      claim({ kind: "dependency", value: "SQLAlchemy" }),
    ], tmpDir);
    expect(issues).toHaveLength(0);
  });
});

// ── Cross-file Checker ──

describe("checkCrossFile", () => {
  it("detects conflicting versions across files", () => {
    const claims = [
      claim({ kind: "version", value: "React 18", source: "stack.md" }),
      claim({ kind: "version", value: "React 17", source: "arch.md" }),
    ];
    const issues = checkCrossFile(claims);
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe("CROSS_FILE_CONFLICT");
  });

  it("no conflict for same version across files", () => {
    const claims = [
      claim({ kind: "version", value: "React 18", source: "stack.md" }),
      claim({ kind: "version", value: "React 18", source: "arch.md" }),
    ];
    const issues = checkCrossFile(claims);
    expect(issues).toHaveLength(0);
  });
});

// ── Index Sync Checker ──

describe("checkIndexSync", () => {
  it("reports orphan entries in INDEX.md", () => {
    mkdirSync(join(tmpDir, "patterns"), { recursive: true });
    writeFileSync(
      join(tmpDir, "patterns/INDEX.md"),
      "| [missing.md](missing.md) | A pattern |"
    );
    const issues = checkIndexSync(tmpDir, tmpDir);
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe("INDEX_ORPHAN_ENTRY");
  });

  it("reports pattern files missing from INDEX", () => {
    mkdirSync(join(tmpDir, "patterns"), { recursive: true });
    writeFileSync(join(tmpDir, "patterns/INDEX.md"), "# Index\n\nEmpty.");
    writeFileSync(join(tmpDir, "patterns/auth.md"), "# Auth pattern");
    const issues = checkIndexSync(tmpDir, tmpDir);
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe("INDEX_MISSING_ENTRY");
  });

  it("passes when INDEX and files match", () => {
    mkdirSync(join(tmpDir, "patterns"), { recursive: true });
    writeFileSync(
      join(tmpDir, "patterns/INDEX.md"),
      "| [auth.md](auth.md) | Auth pattern |"
    );
    writeFileSync(join(tmpDir, "patterns/auth.md"), "# Auth");
    const issues = checkIndexSync(tmpDir, tmpDir);
    expect(issues).toHaveLength(0);
  });

  it("ignores references inside HTML comments", () => {
    mkdirSync(join(tmpDir, "patterns"), { recursive: true });
    writeFileSync(
      join(tmpDir, "patterns/INDEX.md"),
      "<!-- [example.md](example.md) is a template -->\n\n| Pattern | Use when |\n|---|---|"
    );
    const issues = checkIndexSync(tmpDir, tmpDir);
    expect(issues).toHaveLength(0);
  });
});

// ── Stale Pattern Checker ──

describe("checkStalePatterns", () => {
  it("flags a pattern file with no inbound reference", () => {
    mkdirSync(join(tmpDir, "patterns"), { recursive: true });
    writeFileSync(join(tmpDir, "patterns/orphan.md"), "# Orphan");
    writeFileSync(join(tmpDir, "ROUTER.md"), "# Router\n\nNo pattern links here.");
    const issues = checkStalePatterns(tmpDir, tmpDir);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      code: "STALE_PATTERN",
      severity: "warning",
      file: "patterns/orphan.md",
    });
  });

  it("passes when ROUTER.md links to the pattern", () => {
    mkdirSync(join(tmpDir, "patterns"), { recursive: true });
    writeFileSync(join(tmpDir, "patterns/auth.md"), "# Auth");
    writeFileSync(
      join(tmpDir, "ROUTER.md"),
      "See [patterns/auth.md](patterns/auth.md) for the auth pattern."
    );
    const issues = checkStalePatterns(tmpDir, tmpDir);
    expect(issues).toHaveLength(0);
  });

  it("passes when a context file links to the pattern", () => {
    mkdirSync(join(tmpDir, "patterns"), { recursive: true });
    mkdirSync(join(tmpDir, "context"), { recursive: true });
    writeFileSync(join(tmpDir, "patterns/auth.md"), "# Auth");
    writeFileSync(
      join(tmpDir, "context/architecture.md"),
      "Auth details live in `auth.md`."
    );
    const issues = checkStalePatterns(tmpDir, tmpDir);
    expect(issues).toHaveLength(0);
  });

  it("does not flag INDEX.md or README.md as patterns needing references", () => {
    mkdirSync(join(tmpDir, "patterns"), { recursive: true });
    writeFileSync(join(tmpDir, "patterns/INDEX.md"), "# Index");
    writeFileSync(join(tmpDir, "patterns/README.md"), "# Readme");
    const issues = checkStalePatterns(tmpDir, tmpDir);
    expect(issues).toHaveLength(0);
  });

  it("passes when a context file references the pattern via a frontmatter edge", () => {
    mkdirSync(join(tmpDir, "patterns"), { recursive: true });
    mkdirSync(join(tmpDir, "context"), { recursive: true });
    writeFileSync(join(tmpDir, "patterns/auth.md"), "# Auth");
    writeFileSync(
      join(tmpDir, "context/architecture.md"),
      '---\nedges:\n  - target: "patterns/auth.md"\n---\n\n# Architecture\n'
    );
    const issues = checkStalePatterns(tmpDir, tmpDir);
    expect(issues).toHaveLength(0);
  });

  it("returns empty when there is no patterns directory", () => {
    const issues = checkStalePatterns(tmpDir, tmpDir);
    expect(issues).toHaveLength(0);
  });
});

// ── Staleness Checker ──

describe("checkStaleness", () => {
  const daysFn = gitMock.daysSinceLastChange as unknown as ReturnType<typeof vi.fn>;
  const commitsFn = gitMock.commitsSinceLastChange as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    daysFn.mockReset();
    commitsFn.mockReset();
  });

  it("returns no issues when both thresholds are clean", async () => {
    daysFn.mockResolvedValue(10);
    commitsFn.mockResolvedValue(5);
    const issues = await checkStaleness("file.md", "source.md", ".");
    expect(issues).toHaveLength(0);
  });

  it("returns a single issue when only the day threshold is exceeded", async () => {
    daysFn.mockResolvedValue(100);
    commitsFn.mockResolvedValue(5);
    const issues = await checkStaleness("file.md", "source.md", ".");
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe("error");
    expect(issues[0].message).toContain("100 days");
  });

  it("collapses day + commit thresholds into a single compound issue", async () => {
    daysFn.mockResolvedValue(100);
    commitsFn.mockResolvedValue(250);
    const issues = await checkStaleness("file.md", "source.md", ".");
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe("STALE_FILE");
    expect(issues[0].severity).toBe("error");
    expect(issues[0].message).toContain("100 days");
    expect(issues[0].message).toContain("250 commits");
  });

  it("uses the higher severity when one threshold is warning and the other error", async () => {
    daysFn.mockResolvedValue(40);
    commitsFn.mockResolvedValue(250);
    const issues = await checkStaleness("file.md", "source.md", ".");
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe("error");
  });

  it("keeps warning severity when neither threshold reaches error", async () => {
    daysFn.mockResolvedValue(40);
    commitsFn.mockResolvedValue(60);
    const issues = await checkStaleness("file.md", "source.md", ".");
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe("warning");
  });

  it("returns empty when git history is unavailable", async () => {
    daysFn.mockResolvedValue(null);
    commitsFn.mockResolvedValue(null);
    const issues = await checkStaleness("file.md", "source.md", ".");
    expect(issues).toHaveLength(0);
  });
});

// ── Tool Config Sync Checker ──

describe("checkToolConfigSync", () => {
  // Sentinel carried by every generated .tool-configs/ template.
  const marker = "<!-- mex-tool-config: managed copy -->\n";

  it("returns empty when no tool configs are installed", () => {
    const issues = checkToolConfigSync(tmpDir);
    expect(issues).toHaveLength(0);
  });

  it("returns empty when only one tool config is installed", () => {
    writeFileSync(join(tmpDir, "CLAUDE.md"), `${marker}pointer to ROUTER.md`);
    const issues = checkToolConfigSync(tmpDir);
    expect(issues).toHaveLength(0);
  });

  it("returns empty when installed tool configs all match", () => {
    const body = `${marker}same for every tool\n`;
    writeFileSync(join(tmpDir, "CLAUDE.md"), body);
    writeFileSync(join(tmpDir, ".cursorrules"), body);
    writeFileSync(join(tmpDir, ".windsurfrules"), body);
    const issues = checkToolConfigSync(tmpDir);
    expect(issues).toHaveLength(0);
  });

  it("flags drift between two installed tool configs", () => {
    writeFileSync(join(tmpDir, "CLAUDE.md"), `${marker}original\n`);
    writeFileSync(join(tmpDir, ".cursorrules"), `${marker}original\nedited\n`);
    const issues = checkToolConfigSync(tmpDir);
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe("TOOL_CONFIG_DRIFT");
    expect(issues[0].severity).toBe("warning");
    expect(issues[0].file).toBe(".cursorrules");
    expect(issues[0].message).toContain("CLAUDE.md");
  });

  it("flags each drifted file separately and leaves matching files alone", () => {
    writeFileSync(join(tmpDir, "CLAUDE.md"), `${marker}v1\n`);
    writeFileSync(join(tmpDir, "AGENTS.md"), `${marker}v1\n`);            // matches CLAUDE.md
    writeFileSync(join(tmpDir, ".cursorrules"), `${marker}v2 drifted\n`); // drifted
    writeFileSync(join(tmpDir, ".windsurfrules"), `${marker}v3 also\n`);  // drifted
    const issues = checkToolConfigSync(tmpDir);
    const files = issues.map((i) => i.file).sort();
    expect(files).toEqual([".cursorrules", ".windsurfrules"]);
    expect(issues.every((i) => i.code === "TOOL_CONFIG_DRIFT")).toBe(true);
  });

  it("picks up the Copilot config nested under .github", () => {
    mkdirSync(join(tmpDir, ".github"), { recursive: true });
    writeFileSync(join(tmpDir, "CLAUDE.md"), `${marker}shared\n`);
    writeFileSync(join(tmpDir, ".github/copilot-instructions.md"), `${marker}changed\n`);
    const issues = checkToolConfigSync(tmpDir);
    expect(issues).toHaveLength(1);
    expect(issues[0].file).toBe(".github/copilot-instructions.md");
  });

  it("does not report the agent-skills block as drift", () => {
    // CLAUDE.md carries the managed skills block and .cursorrules cannot --
    // Cursor has no mex skills to invoke. Comparing raw bytes reported an
    // install of both tools as permanently drifted, with no edit the user
    // could make to clear it. See https://github.com/mex-memory/mex/issues/106
    const body = `${marker}shared project anchor\n`;
    writeFileSync(
      join(tmpDir, "CLAUDE.md"),
      `${body}\n<!-- mex-agent:skills:start -->\n## MEX agent skills\n- read .mex/ROUTER.md\n<!-- mex-agent:skills:end -->\n`,
    );
    writeFileSync(join(tmpDir, ".cursorrules"), body);
    expect(checkToolConfigSync(tmpDir)).toHaveLength(0);
  });

  it("does not report the appended anchor pointer as drift", () => {
    // Same shape from the other direction: setup appends a pointer block to a
    // pre-existing .cursorrules, which CLAUDE.md has no reason to carry.
    const body = `${marker}shared project anchor\n`;
    writeFileSync(join(tmpDir, "CLAUDE.md"), body);
    writeFileSync(
      join(tmpDir, ".cursorrules"),
      `${body}\n<!-- mex-anchor:start -->\n- read .mex/ROUTER.md\n<!-- mex-anchor:end -->\n`,
    );
    expect(checkToolConfigSync(tmpDir)).toHaveLength(0);
  });

  it("still reports a real edit made outside the managed blocks", () => {
    const body = `${marker}shared project anchor\n`;
    writeFileSync(
      join(tmpDir, "CLAUDE.md"),
      `${body}\n<!-- mex-agent:skills:start -->\nblock\n<!-- mex-agent:skills:end -->\n`,
    );
    writeFileSync(join(tmpDir, ".cursorrules"), `${body}a line only this copy has\n`);
    const issues = checkToolConfigSync(tmpDir);
    expect(issues).toHaveLength(1);
    expect(issues[0].file).toBe(".cursorrules");
  });

  it("treats a line-ending difference as a checkout artifact, not drift", () => {
    // A repo with no `text` attribute hands CRLF to Windows and LF to CI for
    // the same commit; neither is an edit anyone made.
    writeFileSync(join(tmpDir, "CLAUDE.md"), `${marker}shared anchor\n`);
    writeFileSync(join(tmpDir, ".cursorrules"), `${marker}shared anchor\n`.replace(/\n/g, "\r\n"));
    expect(checkToolConfigSync(tmpDir)).toHaveLength(0);
  });

  it("ignores tool config files that are not scaffold copies", () => {
    // A hand-written CLAUDE.md and a generated AGENTS.md (e.g. a managed skill
    // pack) coexist without ever having been copied from .tool-configs/.
    writeFileSync(join(tmpDir, "CLAUDE.md"), "# Project Context\nhand-written\n");
    writeFileSync(join(tmpDir, "AGENTS.md"), "# Managed skill pack\ngenerated\n");
    const issues = checkToolConfigSync(tmpDir);
    expect(issues).toHaveLength(0);
  });

  it("ignores non-scaffold files even when they mention ROUTER.md", () => {
    // Independently owned configs legitimately point agents at ROUTER.md;
    // that alone must not make them look like scaffold copies of each other.
    writeFileSync(join(tmpDir, "CLAUDE.md"), "# Mine\nSee ROUTER.md for context.\n");
    writeFileSync(join(tmpDir, "AGENTS.md"), "# Theirs\nRead .mex/ROUTER.md first.\n");
    const issues = checkToolConfigSync(tmpDir);
    expect(issues).toHaveLength(0);
  });

  it("compares only the scaffold copies when non-copies are present", () => {
    writeFileSync(join(tmpDir, "CLAUDE.md"), "# Project Context\nread ROUTER.md\n"); // not a copy
    writeFileSync(join(tmpDir, ".cursorrules"), `${marker}v1\n`);
    writeFileSync(join(tmpDir, ".windsurfrules"), `${marker}v1 edited\n`);
    const issues = checkToolConfigSync(tmpDir);
    expect(issues).toHaveLength(1);
    expect(issues[0].file).toBe(".windsurfrules");
    expect(issues[0].message).toContain(".cursorrules");
  });

  // Frontmatter line every tool config template has carried since the initial
  // commit. Copies installed before the sentinel shipped are recognised by it,
  // since `mex setup` never rewrites an anchor that already exists.
  const legacy =
    "---\nname: agents\ndescription: Always-loaded project anchor. Read this first. " +
    "Contains project identity, non-negotiables, commands, and pointer to ROUTER.md for full context.\n---\n";

  it("still flags drift between copies installed before the sentinel shipped", () => {
    writeFileSync(join(tmpDir, "CLAUDE.md"), `${legacy}original\n`);
    writeFileSync(join(tmpDir, ".cursorrules"), `${legacy}original\nedited\n`);
    const issues = checkToolConfigSync(tmpDir);
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe("TOOL_CONFIG_DRIFT");
    expect(issues[0].file).toBe(".cursorrules");
  });

  it("leaves matching pre-sentinel copies alone", () => {
    writeFileSync(join(tmpDir, "CLAUDE.md"), `${legacy}same\n`);
    writeFileSync(join(tmpDir, ".cursorrules"), `${legacy}same\n`);
    expect(checkToolConfigSync(tmpDir)).toHaveLength(0);
  });

  it("blames the edited copy even when it comes first in the file list", () => {
    // CLAUDE.md heads TOOL_CONFIG_FILES, so using it as the baseline pinned a
    // warning on all four untouched files instead. https://github.com/mex-memory/mex/issues/127
    writeFileSync(join(tmpDir, "CLAUDE.md"), `${marker}v2 edited\n`);
    writeFileSync(join(tmpDir, "AGENTS.md"), `${marker}v1\n`);
    writeFileSync(join(tmpDir, ".cursorrules"), `${marker}v1\n`);
    writeFileSync(join(tmpDir, ".windsurfrules"), `${marker}v1\n`);
    mkdirSync(join(tmpDir, ".github"), { recursive: true });
    writeFileSync(join(tmpDir, ".github/copilot-instructions.md"), `${marker}v1\n`);
    const issues = checkToolConfigSync(tmpDir);
    expect(issues).toHaveLength(1);
    expect(issues[0].file).toBe("CLAUDE.md");
    expect(issues[0].message).toContain("AGENTS.md");
  });

  it("names no culprit when the copies split evenly", () => {
    writeFileSync(join(tmpDir, "CLAUDE.md"), `${marker}v1\n`);
    writeFileSync(join(tmpDir, "AGENTS.md"), `${marker}v1\n`);
    writeFileSync(join(tmpDir, ".cursorrules"), `${marker}v2\n`);
    writeFileSync(join(tmpDir, ".windsurfrules"), `${marker}v2\n`);
    const issues = checkToolConfigSync(tmpDir);
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe("TOOL_CONFIG_DRIFT");
    expect(issues[0].message).toContain("no majority");
    expect(issues[0].message).toContain("[CLAUDE.md, AGENTS.md]");
    expect(issues[0].message).toContain("[.cursorrules, .windsurfrules]");
    expect(issues[0].message).not.toContain("has drifted from");
  });

  it("names every group when no two copies agree", () => {
    writeFileSync(join(tmpDir, "CLAUDE.md"), `${marker}a\n`);
    writeFileSync(join(tmpDir, "AGENTS.md"), `${marker}b\n`);
    writeFileSync(join(tmpDir, ".cursorrules"), `${marker}c\n`);
    const issues = checkToolConfigSync(tmpDir);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain("3 groups with no majority");
  });

  it("does not treat a file that merely quotes the sentinel as a copy", () => {
    // Documentation about mex is not a managed copy of it.
    const quoting = "# Notes\nCopies carry `<!-- mex-tool-config -->` after the frontmatter.\n";
    writeFileSync(join(tmpDir, "CLAUDE.md"), quoting);
    writeFileSync(join(tmpDir, "AGENTS.md"), `${quoting}and something else\n`);
    expect(checkToolConfigSync(tmpDir)).toHaveLength(0);
  });
});

// ── TODO/FIXME Checker ──

describe("checkTodoFixme", () => {
  it("flags TODO and FIXME with file and line", () => {
    const file = join(tmpDir, "context/notes.md");
    mkdirSync(join(tmpDir, "context"), { recursive: true });
    writeFileSync(
      file,
      "# Notes\n\n- TODO: wire auth\n\n## Later\n\nFIXME: broken link in ROUTER\n"
    );
    const issues = checkTodoFixme([file], tmpDir);
    expect(issues).toHaveLength(2);
    expect(issues[0]).toMatchObject({
      code: "TODO_FIXME",
      severity: "warning",
      file: "context/notes.md",
      line: 3,
      message: "Unresolved TODO marker in scaffold",
    });
    expect(issues[1]).toMatchObject({
      code: "TODO_FIXME",
      file: "context/notes.md",
      line: 7,
      message: "Unresolved FIXME marker in scaffold",
    });
  });

  it("returns empty when scaffold files have no markers", () => {
    const file = join(tmpDir, "ROUTER.md");
    writeFileSync(file, "# Router\n\nAll tasks done.\n");
    const issues = checkTodoFixme([file], tmpDir);
    expect(issues).toHaveLength(0);
  });

  it("flags multiple markers on the same line separately", () => {
    const file = join(tmpDir, "SETUP.md");
    writeFileSync(file, "TODO: a FIXME: b\n");
    const issues = checkTodoFixme([file], tmpDir);
    expect(issues).toHaveLength(2);
    expect(issues.map((i) => i.line)).toEqual([1, 1]);
  });
});

// ── Broken Link Checker ──

describe("checkBrokenLinks", () => {
  it("flags a broken relative Markdown link", () => {
    mkdirSync(join(tmpDir, "context"), { recursive: true });
    const file = join(tmpDir, "context/guide.md");
    writeFileSync(file, "# Guide\n\nSee [setup](./missing.md).\n");
    const issues = checkBrokenLinks([file], tmpDir, tmpDir);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      code: "BROKEN_LINK",
      severity: "error",
      file: "context/guide.md",
      line: 3,
      message: "Markdown link target does not exist: ./missing.md",
    });
  });

  it("passes when the linked file exists", () => {
    mkdirSync(join(tmpDir, "context"), { recursive: true });
    writeFileSync(join(tmpDir, "context/target.md"), "# Target\n");
    const file = join(tmpDir, "context/guide.md");
    writeFileSync(file, "Link [here](./target.md).\n");
    const issues = checkBrokenLinks([file], tmpDir, tmpDir);
    expect(issues).toHaveLength(0);
  });

  it("ignores external links, document anchors, and mex graph pointers", () => {
    const file = join(tmpDir, "ROUTER.md");
    writeFileSync(
      file,
      "[web](https://example.com) [mail](mailto:a@b.com) [section](#intro) " +
      "[`run()`](mex://function:0123456789abcdef)\n"
    );
    const issues = checkBrokenLinks([file], tmpDir, tmpDir);
    expect(issues).toHaveLength(0);
  });

  it("does not scan links inside fenced or inline code", () => {
    const file = join(tmpDir, "SETUP.md");
    writeFileSync(
      file,
      "```md\n[fake](./nowhere.md)\n```\n\nInline `[x](./also-missing.md)` ok.\n"
    );
    const issues = checkBrokenLinks([file], tmpDir, tmpDir);
    expect(issues).toHaveLength(0);
  });

  it("resolves links with fragment or query to the base file", () => {
    mkdirSync(join(tmpDir, "context"), { recursive: true });
    writeFileSync(join(tmpDir, "context/target.md"), "# Target\n");
    const file = join(tmpDir, "context/guide.md");
    writeFileSync(file, "See [install](./target.md#install).\n");
    const issues = checkBrokenLinks([file], tmpDir, tmpDir);
    expect(issues).toHaveLength(0);
  });

  it("does not scan links inside a single-line HTML comment", () => {
    const file = join(tmpDir, "ROUTER.md");
    writeFileSync(file, "Intro.\n\n<!-- [example](./nowhere.md) -->\n");
    const issues = checkBrokenLinks([file], tmpDir, tmpDir);
    expect(issues).toHaveLength(0);
  });

  it("does not scan links inside a multi-line HTML comment", () => {
    mkdirSync(join(tmpDir, "patterns"), { recursive: true });
    const file = join(tmpDir, "patterns/INDEX.md");
    writeFileSync(
      file,
      "# Pattern Index\n\n<!-- This file is populated during setup.\n" +
      "     | [filename.md](filename.md) | One-line description |\n" +
      "     | [add-api-client.md](add-api-client.md) | Adding an integration |\n" +
      "     Keep this table sorted alphabetically. -->\n\n| Pattern | Use when |\n"
    );
    const issues = checkBrokenLinks([file], tmpDir, tmpDir);
    expect(issues).toHaveLength(0);
  });

  it("still flags a link on the visible side of a same-line comment", () => {
    mkdirSync(join(tmpDir, "context"), { recursive: true });
    const file = join(tmpDir, "context/guide.md");
    writeFileSync(file, "See [real](./missing.md) <!-- [hidden](./hidden.md) -->\n");
    const issues = checkBrokenLinks([file], tmpDir, tmpDir);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toBe("Markdown link target does not exist: ./missing.md");
  });

  it("resumes scanning after a comment closes", () => {
    mkdirSync(join(tmpDir, "context"), { recursive: true });
    const file = join(tmpDir, "context/guide.md");
    writeFileSync(
      file,
      "<!-- [hidden](./hidden.md)\nstill hidden -->\n\nSee [real](./missing.md).\n"
    );
    const issues = checkBrokenLinks([file], tmpDir, tmpDir);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      line: 4,
      message: "Markdown link target does not exist: ./missing.md",
    });
  });

  it("treats an unclosed comment as running to the end of the file", () => {
    const file = join(tmpDir, "SYNC.md");
    writeFileSync(file, "Intro.\n\n<!-- draft notes\n[never](./nowhere.md)\n");
    const issues = checkBrokenLinks([file], tmpDir, tmpDir);
    expect(issues).toHaveLength(0);
  });

  it("does not open a comment from a marker inside inline code", () => {
    mkdirSync(join(tmpDir, "context"), { recursive: true });
    const file = join(tmpDir, "context/guide.md");
    writeFileSync(file, "Write `<!--` to open one.\n\nSee [real](./missing.md).\n");
    const issues = checkBrokenLinks([file], tmpDir, tmpDir);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toBe("Markdown link target does not exist: ./missing.md");
  });

  it("does not treat a comment marker inside a fence as a comment", () => {
    mkdirSync(join(tmpDir, "context"), { recursive: true });
    const file = join(tmpDir, "context/guide.md");
    writeFileSync(
      file,
      "```html\n<!-- how to comment\n```\n\nSee [real](./missing.md).\n"
    );
    const issues = checkBrokenLinks([file], tmpDir, tmpDir);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toBe("Markdown link target does not exist: ./missing.md");
  });

  it("downgrades broken links in patterns/ to warning", () => {
    mkdirSync(join(tmpDir, "patterns"), { recursive: true });
    const file = join(tmpDir, "patterns/example.md");
    writeFileSync(file, "[x](./missing.md)\n");
    const issues = checkBrokenLinks([file], tmpDir, tmpDir);
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe("warning");
  });
});
