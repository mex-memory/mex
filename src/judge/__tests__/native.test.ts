import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openRecord } from "../../record/index.js";
import { enqueueJob, registerJobKind, runOneBatch } from "../../record/jobs.js";
import { serializeEntry } from "../../knowledge/entry.js";
import { entry } from "../../knowledge/__tests__/fixtures.js";
import { createJudgeKind, readJudgement } from "../job.js";
import { evaluate, recordChecks } from "../native.js";
import { hash } from "../evidence.js";

let base: string, binary: string;
beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "mex-judge-native-")));
  binary = join(base, process.platform === "win32" ? "mex-hook.exe" : "mex-hook");
  execFileSync("go", ["build", "-o", binary, "./cmd/mex-hook"], { cwd: resolve("native"), timeout: 240_000, stdio: "pipe" });
}, 300_000);
afterEach(() => vi.unstubAllEnvs());
afterAll(() => rmSync(base, { recursive: true, force: true }));

it("takes a real broken verdict through a fake judge and records current checks without changing either database owner", async () => {
  const root = join(base, "repo"), home = join(base, "home"); mkdirSync(root);
  vi.stubEnv("MEX_HOME", home); vi.stubEnv("MEX_HOOK_BINARY", binary);
  const writer = openRecord({ home, projectPath: root, isNetwork: () => false });
  try {
    const projectId = writer.checkout(root)!.project_id;
    const request = { checkout: root, project_id: projectId, mex_home: home, record_directory: writer.location.directory };
    const path = join(root, "package.json");
    const before = '{"scripts":{"test":"old-test"}}\n', after = '{"scripts":{"test":"new-test"}}\n';
    writeFileSync(path, before);
    const checks = await recordChecks(request, [{ kind: "key", role: "complete", target: { file: "package.json", pointer: "/scripts/test" } }]);
    expect(checks).toHaveLength(1);
    mkdirSync(join(root, ".mex/learned"), { recursive: true });
    const file = join(root, ".mex/learned/mx_native0.md");
    const original = serializeEntry(entry("mx_native0", { kind: "fact", checks: checks! }, "The test script runs old-test."));
    writeFileSync(file, original); writeFileSync(path, after);
    expect((await evaluate(request)).items?.[0]?.verdict).toBe("broken");
    const model = vi.fn(async () => ({ selectedModel: "fake-cheap", usage: { input: 100, cache_write: 0, cache_read: 0, output: 20, model: "fake", estimated: false },
      text: JSON.stringify({ results: [{ id: "mx_native0", result: "rewritten", text: "The test script runs new-test.", one_line: "Tests use new-test.", checks: [{ kind: "key", role: "complete", target: { file: "package.json", pointer: "/scripts/test" } }] }] }) }));
    registerJobKind(createJudgeKind({ evaluate, recordChecks, model }));
    const { job } = enqueueJob(writer, { kind: "judge", projectId, params: { checkout: root, agent: "codex", near: ["package.json"] } });
    await runOneBatch(writer, "native-test", { only: new Set([job.id]) });
    const result = readJudgement(writer, projectId, root, "mx_native0");
    expect(model).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ result: "rewritten", label: "checked by model", rewrite: { mex: { checks: [{ kind: "key", saw: { value: "new-test" }, files: { "package.json": hash(after) } }] } } });
    expect(readFileSync(file, "utf8")).toBe(original);
    expect(readFileSync(path, "utf8")).toBe(after);
    expect((await evaluate(request)).items?.[0]?.verdict).toBe("broken");
  } finally { writer.close(); }
});
