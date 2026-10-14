import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  installSemantic,
  loadEmbedder,
  removeSemantic,
  SEMANTIC_LIBRARY_VERSION,
  semanticDirectory,
  SemanticInstallError,
  semanticStatus,
  type CommandRunner,
} from "../semantic.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "mex-context-semantic-"));
  vi.stubEnv("MEX_HOME", home);
});
afterEach(() => vi.unstubAllEnvs());

/** Pretend the library and model landed, the way a real install would leave them. */
function simulateInstalled(dir: string): void {
  mkdirSync(join(dir, "node_modules", "@huggingface", "transformers", "dist"), { recursive: true });
  writeFileSync(join(dir, "node_modules", "@huggingface", "transformers", "package.json"), JSON.stringify({ version: SEMANTIC_LIBRARY_VERSION }));
  writeFileSync(join(dir, "node_modules", "@huggingface", "transformers", "dist", "transformers.node.mjs"), "export {};\n");
  mkdirSync(join(dir, "models", "Xenova", "all-MiniLM-L6-v2", "onnx"), { recursive: true });
  writeFileSync(join(dir, "models", "Xenova", "all-MiniLM-L6-v2", "onnx", "model_quantized.onnx"), "model");
}

describe("the semantic extra's home", () => {
  it("lives under the MEX home, never in the project and never in MEX's own dependencies", () => {
    expect(semanticDirectory()).toBe(join(home, ".mex", "semantic"));
  });
});

describe("when the extra is missing", () => {
  it("reports absent and loads no embedder, without throwing", async () => {
    const status = semanticStatus();
    expect(status).toMatchObject({ state: "absent", bytes: null, library: { installed: false }, model: { cached: false } });
    const loaded = await loadEmbedder();
    expect(loaded.embedder).toBeNull();
    expect(loaded.reason).toMatch(/not installed/);
  });

  it("reports a half-finished install as partial and still loads no embedder", async () => {
    const dir = semanticDirectory();
    simulateInstalled(dir);
    mkdirSync(join(dir, "models"), { recursive: true });
    writeFileSync(join(dir, "models", "stray.txt"), "x");
    expect(semanticStatus(dir).state).toBe("installed");
    const { rmSync } = await import("node:fs");
    rmSync(join(dir, "models", "Xenova"), { recursive: true });
    expect(semanticStatus(dir).state).toBe("partial");
    expect((await loadEmbedder(dir)).embedder).toBeNull();
  });
});

describe("install and remove", () => {
  it("installs the pinned library with npm into the managed directory, then verifies the model", async () => {
    const calls: Array<{ command: string; args: readonly string[]; cwd: string }> = [];
    const run: CommandRunner = async (command, args, cwd) => {
      calls.push({ command, args, cwd });
      simulateInstalled(cwd);
      return { code: 0, stdout: "", stderr: "" };
    };
    const verify = vi.fn(async () => undefined);
    const status = await installSemantic({ run, verifyModel: verify });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ command: "npm", cwd: semanticDirectory() });
    expect(calls[0]!.args).toContain(`@huggingface/transformers@${SEMANTIC_LIBRARY_VERSION}`);
    expect(verify).toHaveBeenCalledWith(semanticDirectory());
    expect(status.state).toBe("installed");
    expect(status.library.version).toBe(SEMANTIC_LIBRARY_VERSION);
    expect(status.bytes).toBeGreaterThan(0);
  });

  it("fails with the npm output and leaves the lexical recipe in charge", async () => {
    const run: CommandRunner = async () => ({ code: 1, stdout: "", stderr: "npm ERR! network unreachable" });
    await expect(installSemantic({ run, verifyModel: async () => undefined })).rejects.toThrow(SemanticInstallError);
    await expect(installSemantic({ run, verifyModel: async () => undefined })).rejects.toMatchObject({
      detail: expect.stringContaining("network unreachable"),
    });
    expect(semanticStatus().state).toBe("absent");
  });

  it("removes only a directory it created", () => {
    const dir = semanticDirectory();
    expect(removeSemantic(dir)).toEqual({ removed: false });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "someone-elses-project" }));
    expect(() => removeSemantic(dir)).toThrow(SemanticInstallError);
    expect(existsSync(dir)).toBe(true);

    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "mex-semantic-extra" }));
    simulateInstalled(dir);
    expect(removeSemantic(dir)).toEqual({ removed: true });
    expect(existsSync(dir)).toBe(false);
  });
});
