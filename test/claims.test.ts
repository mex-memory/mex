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

  it("skips non-path inline code values", () => {
    const path = writeFixture(
      "test.md",
      "# Notes\n\n" +
        "The cluster subnet is `192.168.5.0/24`. " +
        "The ArgoCD annotation `argocd.argoproj.io/sync-wave` controls ordering. " +
        "Use `sudo ls /var/lib/kubelet/plugins_registry/` to inspect plugins. " +
        "YAML files can use `.yaml` or `.yml`."
    );
    const claims = extractClaims(path, "test.md");
    const paths = claims.filter((c) => c.kind === "path");
    expect(paths).toHaveLength(0);
  });

  it("skips runtime, glob, and command-shaped values", () => {
    const path = writeFixture(
      "test.md",
      "# Notes\n\n" +
        "Transcripts live in `~/.claude/projects`. " +
        "Backups match `.mex/graph.db*`. " +
        "Dev runs `nodemon src/index.ts`. " +
        "A doubled call passes `api/...` to the helper."
    );
    const claims = extractClaims(path, "test.md");
    expect(claims.filter((c) => c.kind === "path")).toHaveLength(0);
  });

  it("still extracts hidden-directory paths that a dotted key would swallow", () => {
    const path = writeFixture(
      "test.md",
      "# Notes\n\n" +
        "Ownership lives in `.github/CODEOWNERS` and CI in `.github/workflows`. " +
        "The scaffold anchor is `.mex/ROUTER.md`."
    );
    const claims = extractClaims(path, "test.md");
    const paths = claims.filter((c) => c.kind === "path").map((c) => c.value);
    expect(paths).toContain(".github/CODEOWNERS");
    expect(paths).toContain(".github/workflows");
    expect(paths).toContain(".mex/ROUTER.md");
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

  it("claims the packages named in code inside a bold dependency entry", () => {
    const path = writeFixture(
      "test.md",
      "# Key Libraries\n\n" +
        "- **`@xyflow/react` + `dagre`** — mind-map rendering and auto-layout\n" +
        "- **Radix UI + `class-variance-authority` + `tailwind-merge`** — primitives"
    );
    const claims = extractClaims(path, "test.md");
    const deps = claims.filter((c) => c.kind === "dependency").map((d) => d.value);
    expect(deps).toEqual([
      "@xyflow/react",
      "dagre",
      "class-variance-authority",
      "tailwind-merge",
    ]);
  });

  it("does not claim a prose description as a dependency", () => {
    const path = writeFixture(
      "test.md",
      "# Core Technologies\n\n" +
        "- **Supabase (Postgres + Auth)** — single datastore and identity provider\n" +
        "- **Express 4.21 on Node** — the API server\n" +
        "- **GitHub public REST API** — unauthenticated fetches"
    );
    const claims = extractClaims(path, "test.md");
    const deps = claims.filter((c) => c.kind === "dependency");
    expect(deps).toHaveLength(0);
  });

  it("ignores bold emphasis inside a list item's prose", () => {
    const path = writeFixture(
      "test.md",
      "# External Dependencies\n\n" +
        "- **Groq (`groq-sdk`)** — completions; the backend uses the **service-role** key"
    );
    const claims = extractClaims(path, "test.md");
    const deps = claims.filter((c) => c.kind === "dependency").map((d) => d.value);
    expect(deps).toEqual(["groq-sdk"]);
  });

  it("does not treat a package named in a dependency entry as a path", () => {
    const path = writeFixture(
      "test.md",
      "# Key Libraries\n\n- **YouTube via `youtubei.js`** — transcript retrieval"
    );
    const claims = extractClaims(path, "test.md");
    expect(claims.filter((c) => c.kind === "path")).toHaveLength(0);
    expect(claims.filter((c) => c.kind === "dependency").map((d) => d.value)).toEqual([
      "youtubei.js",
    ]);
  });

  it("still claims a real path written in a non-dependency section", () => {
    const path = writeFixture(
      "test.md",
      "# Architecture\n\n- **Entry point** — `src/index.ts` boots the server"
    );
    const claims = extractClaims(path, "test.md");
    expect(claims.filter((c) => c.kind === "path").map((c) => c.value)).toEqual([
      "src/index.ts",
    ]);
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

describe("extractClaims — non-package dependency filtering (#4)", () => {
  it("drops all-caps acronyms from dependency sections", () => {
    const path = writeFixture(
      "acronyms.md",
      "## Stack\n\n- **AWS** — cloud provider\n- **REST** — interface style\n- **JWT** — auth tokens\n"
    );
    const deps = extractClaims(path, "acronyms.md").filter((c) => c.kind === "dependency");
    expect(deps).toEqual([]);
  });

  it("drops multi-word descriptive phrases", () => {
    const path = writeFixture(
      "phrases.md",
      "## Tech Stack\n\n- **REST API** — external interface\n- **Database Layer** — persistence\n"
    );
    const deps = extractClaims(path, "phrases.md").filter((c) => c.kind === "dependency");
    expect(deps).toEqual([]);
  });

  it("drops common architectural labels but keeps real packages", () => {
    const path = writeFixture(
      "labels.md",
      "## Dependencies\n\n- **Frontend** — the UI\n- **Middleware** — request pipeline\n- **Express** — web framework\n- **@scope/pkg** — internal\n"
    );
    const deps = extractClaims(path, "labels.md").filter((c) => c.kind === "dependency");
    expect(deps.map((d) => d.value)).toEqual(["Express", "@scope/pkg"]);
  });

  it("keeps mixed-case package names with digits", () => {
    const path = writeFixture(
      "packages.md",
      "## Stack\n\n- **YouTube.js** — client\n- **pino-http** — logging\n"
    );
    const deps = extractClaims(path, "packages.md").filter((c) => c.kind === "dependency");
    expect(deps.map((d) => d.value)).toContain("pino-http");
  });
});
