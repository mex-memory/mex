import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  binaryFileName,
  findNativeBinary,
  platformPackageName,
  resolveHookRunner,
  selfTestBinary,
} from "../binary.js";
import { runNodeHook } from "../node-hook.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
// The Go CI job builds the platform packages before enabling these checks.
// Test the shipped artifact without competing compilation during capture.
const realBinary = process.env.MEX_TEST_REAL_HOOK_BINARY === "1";

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "mex-hook-bin-"));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function fakePackage(platform: string, arch: string, withBinary: boolean): string {
  const dir = join(tmp, `pkg-${platform}-${arch}-${withBinary}`);
  mkdirSync(join(dir, "bin"), { recursive: true });
  writeFileSync(join(dir, "package.json"), "{}");
  if (withBinary) writeFileSync(join(dir, "bin", binaryFileName(platform)), "");
  return join(dir, "package.json");
}

async function nodeReply(input: string, env: NodeJS.ProcessEnv = {}): Promise<string> {
  const stdin = new PassThrough();
  let out = "";
  const done = runNodeHook({ stdin, write: (t) => (out += t), env });
  stdin.end(input);
  expect(await done).toBe(0);
  return out;
}

describe("platformPackageName", () => {
  it("names one package per supported platform", () => {
    for (const p of ["linux", "darwin", "win32"]) {
      for (const a of ["x64", "arm64"]) expect(platformPackageName(p, a)).toBe(`mex-agent-hook-${p}-${a}`);
    }
  });

  it("returns null for unsupported platforms", () => {
    expect(platformPackageName("freebsd", "x64")).toBeNull();
    expect(platformPackageName("linux", "ia32")).toBeNull();
  });

  it("matches a package folder in npm/", () => {
    const pkg = JSON.parse(
      execFileSync(process.execPath, ["-p", "JSON.stringify(require('./npm/hook-linux-x64/package.json'))"], {
        cwd: repoRoot,
        encoding: "utf8",
      }),
    ) as { name: string; os: string[]; cpu: string[] };
    expect(pkg.name).toBe(platformPackageName("linux", "x64"));
    expect(pkg.os).toEqual(["linux"]);
    expect(pkg.cpu).toEqual(["x64"]);
  });
});

describe("findNativeBinary", () => {
  it("returns null when the platform package isn't installed", () => {
    const missing = () => {
      throw new Error("Cannot find module");
    };
    expect(findNativeBinary({ platform: "linux", arch: "x64", resolve: missing })).toBeNull();
  });

  it("returns null when the package has no binary in it", () => {
    const manifest = fakePackage("linux", "x64", false);
    expect(findNativeBinary({ platform: "linux", arch: "x64", resolve: () => manifest })).toBeNull();
  });

  it("finds the binary inside the package", () => {
    const manifest = fakePackage("win32", "arm64", true);
    expect(findNativeBinary({ platform: "win32", arch: "arm64", resolve: () => manifest })).toBe(
      join(dirname(manifest), "bin", "mex-hook.exe"),
    );
  });
});

describe("resolveHookRunner", () => {
  it("uses the Node path when no binary is installed", () => {
    const runner = resolveHookRunner({ platform: "freebsd", arch: "x64" });
    expect(runner.kind).toBe("node");
  });

  it("uses the Node path when the binary was deleted", () => {
    const runner = resolveHookRunner({ binary: join(tmp, "gone", binaryFileName()) });
    expect(runner).toMatchObject({ kind: "node", reason: expect.stringContaining("binary missing") });
  });

  it("uses the Node path when the self-test fails", () => {
    // Node rejects --self-test as an unknown option and exits non-zero.
    const runner = resolveHookRunner({ binary: process.execPath });
    expect(runner).toMatchObject({ kind: "node", reason: expect.stringContaining("self-test failed") });
  });

  it("uses the Node path when the self-test output isn't ok", () => {
    const runner = resolveHookRunner({
      binary: process.execPath,
      selfTest: () => ({ ok: false, error: "blocked by policy" }),
    });
    expect(runner).toEqual({ kind: "node", reason: "self-test failed: blocked by policy" });
  });

  it("picks the native binary when it passes its self-test", () => {
    const runner = resolveHookRunner({ binary: process.execPath, selfTest: () => ({ ok: true, version: "1.2.3" }) });
    expect(runner).toEqual({ kind: "native", path: process.execPath, version: "1.2.3" });
  });
});

describe("Node fallback", () => {
  it("replies with the empty reply", async () => {
    expect(await nodeReply('{"hook_event_name":"PreToolUse"}')).toBe("{}\n");
  });

  it("fails open on malformed input", async () => {
    for (const input of ["", "not json", "{", "\u0000ÿ"]) expect(await nodeReply(input)).toBe("{}\n");
  });

  it("does nothing for MEX's own background runs", async () => {
    expect(await nodeReply("{}", { MEX_BACKGROUND: "1" })).toBe("{}\n");
  });

  it("gives up on a stdin that never closes", async () => {
    const stdin = new PassThrough();
    let out = "";
    const started = Date.now();
    await runNodeHook({ stdin, write: (t) => (out += t), env: {}, timeoutMs: 50 });
    expect(out).toBe("{}\n");
    expect(Date.now() - started).toBeLessThan(1_000);
    stdin.destroy();
  });

  it("drains an oversized payload", async () => {
    const big = "x".repeat((8 << 20) + 1024);
    expect(await nodeReply(big)).toBe("{}\n");
  });

  it("still exits 0 when stdout throws", async () => {
    const stdin = new PassThrough();
    const done = runNodeHook({
      stdin,
      write: () => {
        throw new Error("EPIPE");
      },
      env: {},
    });
    stdin.end("{}");
    expect(await done).toBe(0);
  });
});

describe.skipIf(!realBinary)("with the real Go binary", () => {
  let built: string;
  beforeAll(() => {
    built = join(repoRoot, "npm", `hook-${process.platform}-${process.arch}`, "bin", binaryFileName());
    expect(existsSync(built), "Build platform packages with node scripts/build-hook-binaries.mjs first").toBe(true);
  }, 120_000);

  it("passes its self-test", () => {
    expect(selfTestBinary(built)).toMatchObject({ ok: true });
  });

  it("falls back to Node once the binary is deleted, with the same reply", async () => {
    const copy = join(tmp, "real-copy", binaryFileName());
    mkdirSync(dirname(copy), { recursive: true });
    copyFileSync(built, copy);

    const native = resolveHookRunner({ binary: copy });
    expect(native.kind).toBe("native");
    const nativeOut = execFileSync(copy, [], { input: '{"hook_event_name":"Stop"}', encoding: "utf8" });

    rmSync(copy);
    const fallback = resolveHookRunner({ binary: copy });
    expect(fallback.kind).toBe("node");
    expect(await nodeReply('{"hook_event_name":"Stop"}')).toBe(nativeOut);
  });
});
