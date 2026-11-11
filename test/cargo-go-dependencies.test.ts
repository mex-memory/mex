import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkDependencies } from "../src/drift/checkers/dependency.js";
import type { Claim } from "../src/types.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mex-cargo-go-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const claim = (value: string, kind: Claim["kind"] = "dependency"): Claim =>
  ({ kind, value, source: "test.md", line: 1, section: null, negated: false });

const cargo = (content: string): void => {
  writeFileSync(join(root, "Cargo.toml"), content);
};
const gomod = (content: string): void => {
  writeFileSync(join(root, "go.mod"), content);
};

describe("Cargo.toml dependencies (#326)", () => {
  it("reads crates from the dependencies table", () => {
    cargo([
      "[package]",
      'name = "svc"',
      'version = "0.1.0"',
      "",
      "[dependencies]",
      'serde = "1.0"',
      'tokio = { version = "1.35", features = ["full"] }',
    ].join("\n"));
    const issues = checkDependencies([claim("serde"), claim("tokio")], root);
    expect(issues).toEqual([]);
  });

  it("reads crates from the dev-dependencies and build-dependencies tables", () => {
    cargo([
      "[dev-dependencies]",
      'criterion = "0.5"',
      "",
      "[build-dependencies]",
      'cc = "1.0"',
    ].join("\n"));
    const issues = checkDependencies([claim("criterion"), claim("cc")], root);
    expect(issues).toEqual([]);
  });

  it("reads a crate from a target-specific table", () => {
    cargo([
      "[target.'cfg(unix)'.dependencies]",
      'nix = "0.27"',
    ].join("\n"));
    expect(checkDependencies([claim("nix")], root)).toEqual([]);
  });

  it("matches a crate whose name Cargo normalizes with an underscore", () => {
    cargo(["[dependencies]", 'serde_json = "1.0"'].join("\n"));
    // Cargo accepts `serde_json` and `serde-json` for the same crate.
    expect(checkDependencies([claim("serde-json")], root)).toEqual([]);
  });

  it("reads a crate whose inline table spans several lines", () => {
    cargo([
      "[dependencies]",
      "serde = {",
      '  version = "1.0",',
      '  features = ["derive"],',
      "}",
    ].join("\n"));
    expect(checkDependencies([claim("serde")], root)).toEqual([]);
  });

  it("reads a crate that declares no version of its own", () => {
    cargo(["[dependencies]", 'serde = { features = ["derive"] }'].join("\n"));
    expect(checkDependencies([claim("serde")], root)).toEqual([]);
  });

  it("reports a crate the manifest does not declare", () => {
    cargo(["[dependencies]", 'serde = "1.0"'].join("\n"));
    const issues = checkDependencies([claim("serde"), claim("tokio")], root);
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe("DEPENDENCY_MISSING");
    expect(issues[0].claim?.value).toBe("tokio");
  });

  it("checks a claimed crate version against the manifest", () => {
    cargo(["[dependencies]", 'serde = "1.0.5"'].join("\n"));
    expect(checkDependencies([claim("serde 1.0.5", "version")], root)).toEqual([]);
    const issues = checkDependencies([claim("serde 2.0.0", "version")], root);
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe("VERSION_MISMATCH");
  });
});

describe("go.mod dependencies (#326)", () => {
  it("reads modules from a require block", () => {
    gomod([
      "module example.com/svc",
      "",
      "go 1.22",
      "",
      "require (",
      "\tgithub.com/spf13/cobra v1.8.0",
      "\tgolang.org/x/sync v0.5.0",
      ")",
    ].join("\n"));
    const issues = checkDependencies([claim("github.com/spf13/cobra"), claim("golang.org/x/sync")], root);
    expect(issues).toEqual([]);
  });

  it("reads a module required on a single line", () => {
    gomod([
      "module example.com/svc",
      "",
      "require github.com/spf13/cobra v1.8.0",
    ].join("\n"));
    expect(checkDependencies([claim("github.com/spf13/cobra")], root)).toEqual([]);
  });

  it("reads a module marked indirect", () => {
    gomod([
      "module example.com/svc",
      "",
      "require (",
      "\tgithub.com/spf13/cobra v1.8.0 // indirect",
      ")",
    ].join("\n"));
    expect(checkDependencies([claim("github.com/spf13/cobra")], root)).toEqual([]);
  });

  it("matches a module named by its last path segment", () => {
    gomod([
      "module example.com/svc",
      "",
      "require github.com/spf13/cobra v1.8.0",
    ].join("\n"));
    expect(checkDependencies([claim("cobra")], root)).toEqual([]);
  });

  it("reports a module the manifest does not require", () => {
    gomod([
      "module example.com/svc",
      "",
      "require github.com/spf13/cobra v1.8.0",
    ].join("\n"));
    const issues = checkDependencies([claim("github.com/spf13/cobra"), claim("github.com/gin-gonic/gin")], root);
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe("DEPENDENCY_MISSING");
    expect(issues[0].claim?.value).toBe("github.com/gin-gonic/gin");
  });

  it("checks a claimed module version against the manifest", () => {
    gomod([
      "module example.com/svc",
      "",
      "require github.com/spf13/cobra v1.8.0",
    ].join("\n"));
    expect(checkDependencies([claim("github.com/spf13/cobra v1.8.0", "version")], root)).toEqual([]);
    const issues = checkDependencies([claim("github.com/spf13/cobra v2.0.0", "version")], root);
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe("VERSION_MISMATCH");
  });
});

describe("manifest discovery across ecosystems (#326)", () => {
  it("reads a nested Cargo.toml", () => {
    mkdirSync(join(root, "crates/core"), { recursive: true });
    writeFileSync(join(root, "crates/core/Cargo.toml"), ["[dependencies]", 'serde = "1.0"'].join("\n"));
    expect(checkDependencies([claim("serde")], root)).toEqual([]);
  });

  it("reads a nested go.mod", () => {
    mkdirSync(join(root, "services/api"), { recursive: true });
    writeFileSync(join(root, "services/api/go.mod"), [
      "module example.com/api",
      "",
      "require github.com/spf13/cobra v1.8.0",
    ].join("\n"));
    expect(checkDependencies([claim("github.com/spf13/cobra")], root)).toEqual([]);
  });

  it("reads every ecosystem in one repository", () => {
    cargo(["[dependencies]", 'serde = "1.0"'].join("\n"));
    gomod([
      "module example.com/svc",
      "",
      "require github.com/spf13/cobra v1.8.0",
    ].join("\n"));
    writeFileSync(join(root, "pyproject.toml"), '[project]\nname = "svc"\ndependencies = ["httpx>=0.27"]\n');
    const issues = checkDependencies([claim("serde"), claim("github.com/spf13/cobra"), claim("httpx")], root);
    expect(issues).toEqual([]);
  });

  it("still reports a dependency missing from every ecosystem", () => {
    cargo(["[dependencies]", 'serde = "1.0"'].join("\n"));
    gomod([
      "module example.com/svc",
      "",
      "require github.com/spf13/cobra v1.8.0",
    ].join("\n"));
    const issues = checkDependencies([claim("nonexistent-package")], root);
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe("DEPENDENCY_MISSING");
  });
});
