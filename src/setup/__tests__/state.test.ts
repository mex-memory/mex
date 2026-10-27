import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GRAPH_CORPUS_IGNORE_GLOBS } from "../../graph/corpus-policy.js";
import {
  detectProjectState,
  assertGroundingCaptureReady,
  ensureScaffoldFile,
  isScaffoldPopulated,
  verifyExistingSetupConfig,
} from "../index.js";
import { loadConfiguredAiTools } from "../../config.js";

const roots: string[] = [];
vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readdirSync: vi.fn(actual.readdirSync) };
});

afterEach(() => {
  vi.clearAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("setup state and scaffold ownership", () => {
  it("treats even a small codebase as existing", () => {
    const root = fixture();
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "index.ts"), "export const ready = true;\n");
    expect(detectProjectState(root, join(root, ".mex"))).toBe("existing");
  });

  it.each([
    "src/main/java/com/acme/App.java",
    "packages/client/src/features/account/index.ts",
    ...["mjs", "cjs", "mts", "cts", "kts", "h", "cc", "hpp"].map(ext => `packages/client/src/features/account/index.${ext}`),
  ])("recognizes a codebase whose only source is deeply nested at %s", (source) => {
    const root = fixture();
    const path = join(root, source);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "// Project source\n");

    expect(detectProjectState(root, join(root, ".mex"))).toBe("existing");
  });

  it("recognizes deep sources alongside an already populated scaffold", () => {
    const root = fixture();
    const mex = join(root, ".mex");
    writePopulatedScaffold(mex);
    const path = join(root, "src/main/java/com/acme/App.java");
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "class App {}\n");

    expect(detectProjectState(root, mex)).toBe("partial");
  });

  it.each([...new Set([
    ...GRAPH_CORPUS_IGNORE_GLOBS.map(pattern => pattern.slice(3, -3)),
    "vendor", "vendored", "third_party", "third-party", "thirdparty", "external", "bower_components",
    "target", "__pycache__", "venv", "generated", "__generated__", "gen", "codegen",
  ])])(
    "ignores sources nested inside %s when classifying an empty project",
    (ignored) => {
      const root = fixture();
      const path = join(root, "nested", ignored, "src/main/java/com/acme/App.java");
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, "class App {}\n");

      expect(detectProjectState(root, join(root, ".mex"))).toBe("fresh");
    },
  );

  it.each([{ files: [] }, { files: ["README.md", "docs/guide.md"] }])("keeps an empty or documentation-only project fresh ($files)", ({ files }) => {
    const root = fixture();
    for (const file of files) {
      mkdirSync(join(root, file, ".."), { recursive: true });
      writeFileSync(join(root, file), "# Documentation\n");
    }
    expect(detectProjectState(root, join(root, ".mex"))).toBe("fresh");
  });

  it("honors configured graph ignore globs for folders and individual files", () => {
    const root = fixture();
    mkdirSync(join(root, ".mex"));
    writeFileSync(join(root, ".mex/config.json"), JSON.stringify({ graph: { ignore: ["**/custom/**", "**/*.generated.ts"] } }));
    const source = join(root, "nested/custom/a/b/c/app.ts");
    mkdirSync(join(source, ".."), { recursive: true });
    writeFileSync(source, "export const generated = true;\n");
    writeFileSync(join(root, "app.generated.ts"), "export const generated = true;\n");
    expect(detectProjectState(root, join(root, ".mex"))).toBe("fresh");
    writeFileSync(join(root, "app.ts"), "export const authored = true;\n");
    expect(detectProjectState(root, join(root, ".mex"))).toBe("existing");
  });

  it("stops directory I/O at the first source, without entering unrelated folders", () => {
    const root = fixture();
    mkdirSync(join(root, "unrelated/a/b/c"), { recursive: true });
    writeFileSync(join(root, "app.ts"), "export const ready = true;\n");
    const reads = vi.mocked(fs.readdirSync);
    reads.mockClear();
    expect(detectProjectState(root, join(root, ".mex"))).toBe("existing");
    expect(reads.mock.calls.map(call => call[0])).toEqual([root]);
  });

  it("never reads a dependency directory even with no project sources", () => {
    const root = fixture();
    mkdirSync(join(root, "node_modules/package/deep"), { recursive: true });
    writeFileSync(join(root, "node_modules/package/deep/app.ts"), "export const dependency = true;\n");
    const reads = vi.mocked(fs.readdirSync);
    reads.mockClear();
    expect(detectProjectState(root, join(root, ".mex"))).toBe("fresh");
    expect(reads.mock.calls.map(call => call[0])).toEqual([root]);
  });

  it("preserves discovery when a directory becomes unreadable", () => {
    const root = fixture();
    vi.mocked(fs.readdirSync).mockImplementationOnce(() => {
      throw Object.assign(new Error("Directory unavailable"), { code: "EACCES" });
    });
    expect(detectProjectState(root, join(root, ".mex"))).toBe("fresh");
    writeFileSync(join(root, "app.ts"), "export const ready = true;\n");
    expect(detectProjectState(root, join(root, ".mex"))).toBe("existing");
  });

  it("counts authored tests as an existing project even though subsystem ranking excludes them", () => {
    const root = fixture();
    mkdirSync(join(root, "tests/unit/a/b/c"), { recursive: true });
    writeFileSync(join(root, "tests/unit/a/b/c/app.test.ts"), "export const ready = true;\n");
    expect(detectProjectState(root, join(root, ".mex"))).toBe("existing");
  });

  it("does not follow directory links outside the project", () => {
    const root = fixture();
    const outside = fixture();
    writeFileSync(join(outside, "app.ts"), "export const outside = true;\n");
    symlinkSync(outside, join(root, "linked"), "junction");
    expect(detectProjectState(root, join(root, ".mex"))).toBe("fresh");
  });

  // The old depth cap hid installed packages; an empty project with only a
  // virtual environment must stay fresh without it (#288).
  it.each([
    "venv/lib/python3.12/site-packages/requests/api.py",
    "env/lib/python3.11/site-packages/six.py",
    "py/lib/python3/dist-packages/yaml/loader.py",
  ])("treats installed Python packages at %s as dependencies, not project source", (installed) => {
    const root = fixture();
    const path = join(root, installed);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "def get(): pass\n");

    expect(detectProjectState(root, join(root, ".mex"))).toBe("fresh");
  });

  it("recognizes authored scaffold files even with leftover placeholders", () => {
    const root = fixture();
    const mex = join(root, ".mex");
    writePopulatedScaffold(mex);
    expect(isScaffoldPopulated(mex)).toBe(true);
    writeFileSync(join(mex, "context", "setup.md"), "last_updated: [YYYY-MM-DD]\n");
    expect(isScaffoldPopulated(mex)).toBe(false);
    writeFileSync(join(mex, "context", "setup.md"), "last_updated: [YYYY-MM-DD]\n\nRun the development server with npm run dev.\n");
    expect(isScaffoldPopulated(mex)).toBe(true);
  });

  it("never overwrites an existing scaffold file on rerun", () => {
    const root = fixture();
    const source = join(root, "template.md");
    const destination = join(root, ".mex", "context", "setup.md");
    writeFileSync(source, "template\n");
    mkdirSync(join(root, ".mex", "context"), { recursive: true });
    writeFileSync(destination, "authored [YYYY-MM-DD] content\n");

    expect(ensureScaffoldFile(source, destination)).toBe("skip");
    expect(readFileSync(destination, "utf-8")).toBe("authored [YYYY-MM-DD] content\n");
  });

  it("reuses configured AI tools while scaffold population is incomplete", () => {
    const root = fixture();
    const mex = join(root, ".mex");
    mkdirSync(join(mex, "context"), { recursive: true });
    writeFileSync(join(mex, "config.json"), JSON.stringify({ aiTools: ["claude", "codex"] }));
    writeFileSync(join(mex, "context", "setup.md"), "last_updated: [YYYY-MM-DD]\n");

    expect(isScaffoldPopulated(mex)).toBe(false);
    expect(detectProjectState(root, mex)).toBe("fresh");
    expect(loadConfiguredAiTools(mex)).toEqual(["claude", "codex"]);
  });

  it("refuses malformed canonical config without replacing its bytes", () => {
    const root = fixture();
    const mex = join(root, ".mex");
    mkdirSync(mex);
    const config = join(mex, "config.json");
    writeFileSync(config, "{broken\n", "utf8");

    expect(() => verifyExistingSetupConfig(mex)).toThrow(/valid JSON object/u);
    expect(readFileSync(config, "utf8")).toBe("{broken\n");
  });

  it("refuses a redirected canonical config", () => {
    const root = fixture();
    const mex = join(root, ".mex");
    mkdirSync(mex);
    const outside = join(fixture(), "outside.json");
    writeFileSync(outside, "{}\n", "utf8");
    symlinkSync(outside, join(mex, "config.json"), "file");

    expect(() => verifyExistingSetupConfig(mex)).toThrow(/regular file/u);
    expect(readFileSync(outside, "utf8")).toBe("{}\n");
  });

  it("does not report setup ready when authored grounding was skipped", () => {
    expect(() => assertGroundingCaptureReady({ captured: 2, skipped: 1 }))
      .toThrow(/could not be verified against the code graph/u);
    expect(() => assertGroundingCaptureReady({ captured: 2, skipped: 0 })).not.toThrow();
  });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "mex-setup-state-"));
  roots.push(root);
  return root;
}

function writePopulatedScaffold(mex: string): void {
  for (const file of [
    "AGENTS.md",
    "ROUTER.md",
    "context/architecture.md",
    "context/stack.md",
    "context/conventions.md",
    "context/decisions.md",
    "context/setup.md",
  ]) {
    const path = join(mex, file);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "last_updated: 2026-09-02\n# Ready\nRun npm test before publishing.\n");
  }
}
