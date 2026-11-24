import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hubSecretPath, loadHubSecret, rotateHubSecret } from "../secret.js";

describe("the per-home Hub secret", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "mex-hub-secret-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it.skipIf(process.platform === "win32")("creates hub-secret with mode 0600", () => {
    loadHubSecret(home);
    expect(statSync(hubSecretPath(home)).mode & 0o777).toBe(0o600);
  });

  it("loads the same 32 bytes on subsequent calls", () => {
    const first = loadHubSecret(home);
    expect(first.bytes).toHaveLength(32);
    expect(loadHubSecret(home)).toEqual(first);
  });

  it("reports a wrong-sized secret as damaged", () => {
    writeFileSync(hubSecretPath(home), Buffer.alloc(31), { mode: 0o600 });
    expect(() => loadHubSecret(home)).toThrow(/damaged/);
  });

  it("replaces both the bytes and file version on rotation", () => {
    const before = loadHubSecret(home);
    const after = rotateHubSecret(home);

    expect(after.bytes).toHaveLength(32);
    expect(after.bytes).not.toEqual(before.bytes);
    expect(after.version).not.toBe(before.version);
    expect(loadHubSecret(home)).toEqual(after);
  });
});
