import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkPaths } from "../src/drift/checkers/path.js";
import { checkEdges } from "../src/drift/checkers/edges.js";
import { checkCommands } from "../src/drift/checkers/command.js";
import { checkDependencies } from "../src/drift/checkers/dependency.js";
import { checkCrossFile } from "../src/drift/checkers/cross-file.js";
import { checkIndexSync } from "../src/drift/checkers/index-sync.js";
import { checkToolConfigSync } from "../src/drift/checkers/tool-config-sync.js";
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

  it("returns empty for no frontmatter", () => {
    expect(checkEdges(null, "f", "f", tmpDir, tmpDir)).toEqual([]);
  });

  it("returns empty for no edges", () => {
    expect(checkEdges({ name: "test" }, "f", "f", tmpDir, tmpDir)).toEqual([]);
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
  it("returns empty when no tool configs are installed", () => {
    const issues = checkToolConfigSync(tmpDir);
    expect(issues).toHaveLength(0);
  });

  it("returns empty when only one tool config is installed", () => {
    writeFileSync(join(tmpDir, "CLAUDE.md"), "pointer to ROUTER.md");
    const issues = checkToolConfigSync(tmpDir);
    expect(issues).toHaveLength(0);
  });

  it("returns empty when installed tool configs all match", () => {
    const body = "pointer to ROUTER.md\nsame for every tool\n";
    writeFileSync(join(tmpDir, "CLAUDE.md"), body);
    writeFileSync(join(tmpDir, ".cursorrules"), body);
    writeFileSync(join(tmpDir, ".windsurfrules"), body);
    const issues = checkToolConfigSync(tmpDir);
    expect(issues).toHaveLength(0);
  });

  it("flags drift between two installed tool configs", () => {
    writeFileSync(join(tmpDir, "CLAUDE.md"), "original\n");
    writeFileSync(join(tmpDir, ".cursorrules"), "original\nedited\n");
    const issues = checkToolConfigSync(tmpDir);
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe("TOOL_CONFIG_DRIFT");
    expect(issues[0].severity).toBe("warning");
    expect(issues[0].file).toBe(".cursorrules");
    expect(issues[0].message).toContain("CLAUDE.md");
  });

  it("flags each drifted file separately and leaves matching files alone", () => {
    writeFileSync(join(tmpDir, "CLAUDE.md"), "v1\n");
    writeFileSync(join(tmpDir, "AGENTS.md"), "v1\n");           // matches CLAUDE.md
    writeFileSync(join(tmpDir, ".cursorrules"), "v2 drifted\n"); // drifted
    writeFileSync(join(tmpDir, ".windsurfrules"), "v3 also\n");  // drifted
    const issues = checkToolConfigSync(tmpDir);
    const files = issues.map((i) => i.file).sort();
    expect(files).toEqual([".cursorrules", ".windsurfrules"]);
    expect(issues.every((i) => i.code === "TOOL_CONFIG_DRIFT")).toBe(true);
  });

  it("picks up the Copilot config nested under .github", () => {
    mkdirSync(join(tmpDir, ".github"), { recursive: true });
    writeFileSync(join(tmpDir, "CLAUDE.md"), "shared\n");
    writeFileSync(join(tmpDir, ".github/copilot-instructions.md"), "changed\n");
    const issues = checkToolConfigSync(tmpDir);
    expect(issues).toHaveLength(1);
    expect(issues[0].file).toBe(".github/copilot-instructions.md");
  });
});
