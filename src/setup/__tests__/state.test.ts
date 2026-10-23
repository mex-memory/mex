import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  detectProjectState,
  assertGroundingCaptureReady,
  ensureScaffoldFile,
  isScaffoldPopulated,
  verifyExistingSetupConfig,
} from "../index.js";
import { loadConfiguredAiTools } from "../../config.js";

const roots: string[] = [];

afterEach(() => {
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

  it.each(["node_modules", ".mex", "vendor", ".git"])(
    "ignores sources nested inside %s when classifying an empty project",
    (ignored) => {
      const root = fixture();
      const path = join(root, "nested", ignored, "src/main/java/com/acme/App.java");
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, "class App {}\n");

      expect(detectProjectState(root, join(root, ".mex"))).toBe("fresh");
    },
  );

  it("recognizes a fully populated scaffold and rejects remaining placeholders", () => {
    const root = fixture();
    const mex = join(root, ".mex");
    writePopulatedScaffold(mex);
    expect(isScaffoldPopulated(mex)).toBe(true);
    writeFileSync(join(mex, "context", "setup.md"), "last_updated: [YYYY-MM-DD]\n");
    expect(isScaffoldPopulated(mex)).toBe(false);
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
    writeFileSync(path, "last_updated: 2026-09-02\n# Ready\n");
  }
}
