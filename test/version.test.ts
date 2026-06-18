import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readVersionFromPackageJson, VERSION } from "../src/version.js";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};

const tmpDirs: string[] = [];

function writePackageJson(contents: unknown): string {
  const tmpDir = mkdtempSync(join(tmpdir(), "mex-version-"));
  tmpDirs.push(tmpDir);
  const packageJsonPath = join(tmpDir, "package.json");
  writeFileSync(packageJsonPath, JSON.stringify(contents));
  return packageJsonPath;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const tmpDir = tmpDirs.pop();
    if (!tmpDir) continue;
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

describe("version metadata", () => {
  it("exports the root package.json version", () => {
    expect(VERSION).toBe(packageJson.version);
  });

  it("reads a valid package version", () => {
    const packageJsonPath = writePackageJson({ version: "1.2.3" });

    expect(readVersionFromPackageJson(packageJsonPath)).toBe("1.2.3");
  });

  it("rejects missing, empty, or non-string versions", () => {
    for (const contents of [
      {},
      { version: "" },
      { version: "   " },
      { version: 1 },
      { version: null },
    ]) {
      const packageJsonPath = writePackageJson(contents);

      expect(() => readVersionFromPackageJson(packageJsonPath)).toThrow(
        "package.json is missing a valid version field.",
      );
    }
  });
});
