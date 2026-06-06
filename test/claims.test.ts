import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { extractClaims } from "../src/drift/claims.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "mex-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeFixture(name: string, content: string): string {
  const path = join(tmpDir, name);
  writeFileSync(path, content);
  return path;
}

describe("extractClaims — paths", () => {
  it("extracts inline code paths with slashes", () => {
    const path = writeFixture(
      "test.md",
      "# Setup\n\nRun from `src/index.ts` to start."
    );
    const claims = extractClaims(path, "test.md");
    const paths = claims.filter((c) => c.kind === "path");
    expect(paths).toHaveLength(1);
    expect(paths[0].value).toBe("src/index.ts");
  });

  it("extracts paths with directory + known extension", () => {
    const path = writeFixture(
      "test.md",
      "# Files\n\nSee `src/config.json` and `lib/app.py`."
    );
    const claims = extractClaims(path, "test.md");
    const paths = claims.filter((c) => c.kind === "path");
    expect(paths).toHaveLength(2);
    expect(paths.map((p) => p.value)).toContain("src/config.json");
    expect(paths.map((p) => p.value)).toContain("lib/app.py");
  });

  it("skips template placeholders with angle brackets", () => {
    const path = writeFixture(
      "test.md",
      "# Patterns\n\nCreate `patterns/<name>.md` for each task."
    );
    const claims = extractClaims(path, "test.md");
    const paths = claims.filter((c) => c.kind === "path");
    expect(paths).toHaveLength(0);
  });

  it("skips template placeholders with square brackets", () => {
    const path = writeFixture(
      "test.md",
      "# Files\n\nSee `src/[slug].tsx` for dynamic routes."
    );
    const claims = extractClaims(path, "test.md");
    const paths = claims.filter((c) => c.kind === "path");
    expect(paths).toHaveLength(0);
  });

  it("skips URL routes without file extensions", () => {
    const path = writeFixture(
      "test.md",
      "# Routes\n\nEndpoints: `/voice/incoming`, `/voice/process`, `/api/users`."
    );
    const claims = extractClaims(path, "test.md");
    const paths = claims.filter((c) => c.kind === "path");
    expect(paths).toHaveLength(0);
  });

  it("skips code snippets with parentheses or equals", () => {
    const path = writeFixture(
      "test.md",
      "# Code\n\nUse `response.redirect(\"/next\")` and `base_url: str = os.getenv(\"FOO\")`."
    );
    const claims = extractClaims(path, "test.md");
    const paths = claims.filter((c) => c.kind === "path");
    expect(paths).toHaveLength(0);
  });

  it("skips wildcard patterns like *_client.py", () => {
    const path = writeFixture(
      "test.md",
      "# Clients\n\nAll files matching `*_streaming_client.py`."
    );
    const claims = extractClaims(path, "test.md");
    const paths = claims.filter((c) => c.kind === "path");
    expect(paths).toHaveLength(0);
  });

  it("extracts bare filenames as path claims", () => {
    const path = writeFixture(
      "test.md",
      "# Files\n\nSee `pipeline.py` and `server.py` for details."
    );
    const claims = extractClaims(path, "test.md");
    const paths = claims.filter((c) => c.kind === "path");
    expect(paths).toHaveLength(2);
    expect(paths.map((p) => p.value)).toContain("pipeline.py");
    expect(paths.map((p) => p.value)).toContain("server.py");
  });

  it("still extracts paths with directory separators", () => {
    const path = writeFixture(
      "test.md",
      "# Files\n\nSee `api_clients/groq_client.py` for the implementation."
    );
    const claims = extractClaims(path, "test.md");
    const paths = claims.filter((c) => c.kind === "path");
    expect(paths).toHaveLength(1);
    expect(paths[0].value).toBe("api_clients/groq_client.py");
  });

  it("marks paths under negated sections", () => {
    const path = writeFixture(
      "test.md",
      "# What Does NOT Exist\n\nWe don't have `src/admin/` yet."
    );
    const claims = extractClaims(path, "test.md");
    const paths = claims.filter((c) => c.kind === "path");
    expect(paths).toHaveLength(1);
    expect(paths[0].negated).toBe(true);
  });
});

describe("extractClaims — commands", () => {
  it("extracts npm run commands from inline code", () => {
    const path = writeFixture(
      "test.md",
      "# Setup\n\nRun `npm run build` to compile."
    );
    const claims = extractClaims(path, "test.md");
    const cmds = claims.filter((c) => c.kind === "command");
    expect(cmds).toHaveLength(1);
    expect(cmds[0].value).toBe("npm run build");
  });

  it("extracts commands from code blocks", () => {
    const path = writeFixture(
      "test.md",
      "# Setup\n\n```sh\nnpm install\nnpm run dev\n```"
    );
    const claims = extractClaims(path, "test.md");
    const cmds = claims.filter((c) => c.kind === "command");
    expect(cmds).toHaveLength(2);
    expect(cmds.map((c) => c.value)).toContain("npm install");
    expect(cmds.map((c) => c.value)).toContain("npm run dev");
  });

  it("extracts yarn and pnpm commands", () => {
    const path = writeFixture(
      "test.md",
      "# Run\n\nUse `yarn test` or `pnpm build`."
    );
    const claims = extractClaims(path, "test.md");
    const cmds = claims.filter((c) => c.kind === "command");
    expect(cmds).toHaveLength(2);
  });

  it("extracts make commands", () => {
    const path = writeFixture(
      "test.md",
      "# Build\n\nRun `make deploy` to deploy."
    );
    const claims = extractClaims(path, "test.md");
    const cmds = claims.filter((c) => c.kind === "command");
    expect(cmds).toHaveLength(1);
    expect(cmds[0].value).toBe("make deploy");
  });
});

describe("extractClaims — dependencies", () => {
  it("extracts bold dependency names under relevant sections", () => {
    const path = writeFixture(
      "test.md",
      "# Key Libraries\n\n- **Express** — web framework\n- **Prisma** — ORM"
    );
    const claims = extractClaims(path, "test.md");
    const deps = claims.filter((c) => c.kind === "dependency");
    expect(deps).toHaveLength(2);
    expect(deps.map((d) => d.value)).toContain("Express");
    expect(deps.map((d) => d.value)).toContain("Prisma");
  });

  it("extracts version claims from bold patterns", () => {
    const path = writeFixture(
      "test.md",
      "# Core Technologies\n\n- **React 18** — UI\n- **Node v20** — runtime"
    );
    const claims = extractClaims(path, "test.md");
    const versions = claims.filter((c) => c.kind === "version");
    expect(versions).toHaveLength(2);
    expect(versions.map((v) => v.value)).toContain("React 18");
    expect(versions.map((v) => v.value)).toContain("Node v20");
  });

  it("ignores bold text outside dependency sections", () => {
    const path = writeFixture(
      "test.md",
      "# Architecture\n\n**Important note** about the system."
    );
    const claims = extractClaims(path, "test.md");
    const deps = claims.filter((c) => c.kind === "dependency");
    expect(deps).toHaveLength(0);
  });
});

describe("extractClaims — returns empty for missing file", () => {
  it("returns empty array for nonexistent file", () => {
    const claims = extractClaims("/nonexistent/file.md", "missing.md");
    expect(claims).toEqual([]);
  });
});
