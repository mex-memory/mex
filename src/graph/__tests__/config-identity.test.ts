import { describe, expect, it } from "vitest";
import { graphConfigIdentity, graphConfigKind } from "../config-identity.js";

const identity = (path: string, value: unknown): string =>
  graphConfigIdentity(path, typeof value === "string" ? value : JSON.stringify(value, null, 2));

/** Same file, one field changed: does the graph consider it a different build? */
const changes = (path: string, before: unknown, after: unknown): boolean =>
  identity(path, before) !== identity(path, after);

describe("graph config identity", () => {
  it("classifies the three config shapes the corpus policy admits", () => {
    expect(graphConfigKind("package.json")).toBe("package");
    expect(graphConfigKind("packages/api/package.json")).toBe("package");
    expect(graphConfigKind("tsconfig.json")).toBe("tsconfig");
    expect(graphConfigKind("tsconfig.build.json")).toBe("tsconfig");
    expect(graphConfigKind("jsconfig.json")).toBe("tsconfig");
    expect(graphConfigKind("packages/api/tsconfig.base.json")).toBe("tsconfig");
    expect(graphConfigKind("some-other.json")).toBe("unknown");
  });

  describe("a change that can move an edge still invalidates", () => {
    const base = {
      extends: "./tsconfig.base.json",
      include: ["src/**/*.ts"],
      exclude: ["dist"],
      files: ["src/index.ts"],
      references: [{ path: "../api" }],
      compilerOptions: {
        paths: { "@app/*": ["src/*"] },
        baseUrl: ".",
        moduleResolution: "NodeNext",
        module: "NodeNext",
        target: "ES2022",
        jsx: "react-jsx",
        allowJs: true,
        checkJs: false,
      },
    };
    const withCompilerOption = (option: string, value: unknown): unknown =>
      ({ ...base, compilerOptions: { ...base.compilerOptions, [option]: value } });

    // One case per field, so a field dropped from the projection fails here
    // rather than silently serving a stale index as current.
    const cases: Array<[string, unknown]> = [
      ["extends", { ...base, extends: "./tsconfig.other.json" }],
      ["include", { ...base, include: ["lib/**/*.ts"] }],
      ["exclude", { ...base, exclude: ["build"] }],
      ["files", { ...base, files: ["src/main.ts"] }],
      ["references", { ...base, references: [{ path: "../web" }] }],
      ["paths", withCompilerOption("paths", { "@app/*": ["lib/*"] })],
      ["baseUrl", withCompilerOption("baseUrl", "./src")],
      ["moduleResolution", withCompilerOption("moduleResolution", "Bundler")],
      ["module", withCompilerOption("module", "ESNext")],
      ["target", withCompilerOption("target", "ES2020")],
      ["jsx", withCompilerOption("jsx", "preserve")],
      ["allowJs", withCompilerOption("allowJs", false)],
      ["checkJs", withCompilerOption("checkJs", true)],
    ];
    for (const [field, after] of cases) {
      it(field, () => {
        expect(changes("tsconfig.json", base, after)).toBe(true);
      });
    }

    it("removing a significant field", () => {
      const { compilerOptions, ...withoutCompilerOptions } = base;
      expect(changes("tsconfig.json", base, withoutCompilerOptions)).toBe(true);
      expect(compilerOptions.baseUrl).toBe(".");
    });

    it("reordering an array whose order is meaningful", () => {
      const before = { compilerOptions: { paths: { "@app/*": ["src/*", "lib/*"] } } };
      const after = { compilerOptions: { paths: { "@app/*": ["lib/*", "src/*"] } } };
      expect(changes("tsconfig.json", before, after)).toBe(true);
    });
  });

  describe("a package.json change that can move an edge still invalidates", () => {
    const base = {
      name: "pkg",
      version: "1.0.0",
      type: "module",
      workspaces: ["packages/*"],
      imports: { "#internal": "./src/internal.js" },
      exports: { ".": "./src/index.js" },
      dependencies: { alpha: "^1.0.0" },
      devDependencies: { beta: "^2.0.0" },
    };
    const cases: Array<[string, unknown]> = [
      ["type", { ...base, type: "commonjs" }],
      ["workspaces", { ...base, workspaces: ["apps/*"] }],
      ["imports", { ...base, imports: { "#internal": "./lib/internal.js" } }],
      ["exports", { ...base, exports: { ".": "./lib/index.js" } }],
      ["a new dependency name", { ...base, dependencies: { alpha: "^1.0.0", gamma: "^1.0.0" } }],
      ["a removed dependency name", { ...base, dependencies: {} }],
    ];
    for (const [field, after] of cases) {
      it(field, () => {
        expect(changes("package.json", base, after)).toBe(true);
      });
    }
  });

  describe("a change that cannot move an edge does not invalidate", () => {
    const pkg = {
      name: "pkg",
      version: "1.0.0",
      type: "module",
      dependencies: { alpha: "^1.0.0" },
      scripts: { build: "tsup" },
    };

    it("a dependency moving between dependency maps", () => {
      // Which map declares a name does not change what a specifier resolves
      // to; only whether the name is declared at all does.
      expect(changes("package.json",
        { ...pkg, dependencies: { alpha: "^1.0.0" } },
        { ...pkg, dependencies: {}, peerDependencies: { alpha: "^1.0.0" } })).toBe(false);
    });

    it("a dependency version bump", () => {
      expect(changes("package.json", pkg, { ...pkg, dependencies: { alpha: "^1.2.3" } })).toBe(false);
    });

    it("the package's own version", () => {
      expect(changes("package.json", pkg, { ...pkg, version: "2.0.0" })).toBe(false);
    });

    it("scripts, description, author and license", () => {
      expect(changes("package.json", pkg, {
        ...pkg,
        scripts: { build: "tsup --watch", test: "vitest" },
        description: "a description",
        author: "someone",
        license: "MIT",
      })).toBe(false);
    });

    it("key order and indentation", () => {
      const reordered = JSON.stringify({
        dependencies: { alpha: "^1.0.0" }, type: "module", scripts: { build: "tsup" },
        version: "1.0.0", name: "pkg",
      });
      expect(graphConfigIdentity("package.json", JSON.stringify(pkg, null, 4)))
        .toBe(graphConfigIdentity("package.json", reordered));
    });

    it("tsconfig comments, trailing commas and insignificant options", () => {
      const withComments = `{
  // the compiler options this project uses
  "compilerOptions": {
    "moduleResolution": "NodeNext",
    "strict": true,
    "noEmit": true,
  },
}`;
      const plain = JSON.stringify({
        compilerOptions: { moduleResolution: "NodeNext", strict: false, declaration: true, noEmit: true },
      });
      expect(graphConfigIdentity("tsconfig.json", withComments))
        .toBe(graphConfigIdentity("tsconfig.json", plain));
    });
  });

  describe("anything it cannot understand falls back to exact bytes", () => {
    it("an unparseable config", () => {
      const broken = "{ not json at all";
      expect(graphConfigIdentity("tsconfig.json", broken)).toBe(broken);
      expect(changes("tsconfig.json", broken, "{ also not json")).toBe(true);
    });

    it("a config that is not an object", () => {
      expect(graphConfigIdentity("package.json", "[1, 2, 3]")).toBe("[1, 2, 3]");
    });

    it("a malformed compilerOptions", () => {
      const malformed = JSON.stringify({ compilerOptions: "nonsense" });
      expect(graphConfigIdentity("tsconfig.json", malformed)).toBe(malformed);
    });

    it("a malformed dependency map", () => {
      const malformed = JSON.stringify({ dependencies: ["alpha"] });
      expect(graphConfigIdentity("package.json", malformed)).toBe(malformed);
    });

    it("a file name the policy does not recognize", () => {
      const source = JSON.stringify({ anything: true });
      expect(graphConfigIdentity("other.json", source)).toBe(source);
    });
  });
});
