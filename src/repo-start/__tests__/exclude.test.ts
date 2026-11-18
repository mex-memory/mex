import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRecord } from "../../record/index.js";
import {
  blockText, ensureExcludeBlock, hasBlock, readExclude, REPO_START_BLOCK, REPO_START_LINES,
  restoreExcludeBlocks, withBlock, withoutBlock,
} from "../exclude.js";

const temps: string[] = [];
afterEach(() => { for (const path of temps.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture(initial: string | null) {
  const base = mkdtempSync(join(tmpdir(), "mex-exclude-")); temps.push(base);
  const file = join(base, "info", "exclude");
  writeFileSync(join(base, "seed"), "");
  if (initial !== null) { mkdirSync(join(base, "info")); writeFileSync(file, initial, "latin1"); }
  const writer = openRecord({ home: join(base, "home"), isNetwork: () => false });
  return { base, file, writer };
}
const DEFAULT = "# git ls-files --others --exclude-from=.git/info/exclude\n# *~\n";

describe("exclude blocks", () => {
  it("appends after existing text, adding a newline only when the file lacks one", () => {
    const block = blockText("repo-start", ["/.mex/*"]);
    expect(withBlock(DEFAULT, "repo-start", ["/.mex/*"])).toBe(DEFAULT + block);
    expect(withBlock("*.o", "repo-start", ["/.mex/*"])).toBe(`*.o\n${block}`);
    expect(withBlock(null, "repo-start", ["/.mex/*"])).toBe(block);
  });

  it("replaces its own block in place and leaves other blocks, including an unnamed one, untouched", () => {
    const other = "# mex: begin (rule files)\n/.claude/rules/mex.md\n# mex: end\n";
    const start = `${DEFAULT}${blockText("repo-start", ["/old"])}${other}tail\n`;
    const next = withBlock(start, "repo-start", ["/new"]);
    expect(next).toBe(`${DEFAULT}${blockText("repo-start", ["/new"])}${other}tail\n`);
    expect(withoutBlock(next, "repo-start")).toBe(`${DEFAULT}${other}tail\n`);
    expect(hasBlock(other, "repo-start")).toBe(false);
  });

  it("coexists with knowledge-05's local rule-file block in both directions", () => {
    // knowledge-05 (native-write.ts) fences its block with these exact lines and removes it with a lazy regex.
    const native = "# mex: local rule files (generated, personal)\n/.claude/rules/mex.md\n# mex: end\n";
    const both = withBlock(`${DEFAULT}${native}`, REPO_START_BLOCK, REPO_START_LINES);
    expect(withoutBlock(both, REPO_START_BLOCK)).toBe(`${DEFAULT}${native}`);
    const nativeRemoval = /\n?# mex: local rule files \(generated, personal\)\n[\s\S]*?# mex: end\n?/u;
    expect(both.replace(nativeRemoval, "\n")).toContain(blockText(REPO_START_BLOCK, REPO_START_LINES));
  });

  it("finds its block in a file with CRLF line endings", () => {
    const crlf = "a\r\n# mex: repo-start begin\r\n/.mex/*\r\n# mex: repo-start end\r\nb\r\n";
    expect(hasBlock(crlf, "repo-start")).toBe(true);
    expect(withoutBlock(crlf, "repo-start")).toBe("a\r\nb\r\n");
  });

  it("hides /.mex/* and un-hides only what `mex share` commits", () => {
    expect(REPO_START_LINES).toEqual(["/.mex/*", "!/.mex/learned/", "!/.mex/handoffs/", "!/.mex/config.json", "!/.mex/sources.json", "!/.mex/native.json"]);
  });

  it("rejects names and lines that could break the fence", () => {
    expect(() => blockText("Bad Name", [])).toThrow();
    expect(() => blockText("ok", ["a\nb"])).toThrow();
    expect(() => blockText("ok", ["# mex: ok end"])).toThrow();
  });
});

describe("journaled exclude changes", () => {
  it("restores the file byte for byte, including non-UTF-8 bytes, and journals each change once", () => {
    const original = `${DEFAULT}caf\xe9\n`;
    const f = fixture(original);
    try {
      expect(ensureExcludeBlock(f.writer, f.file, REPO_START_BLOCK, REPO_START_LINES).changed).toBe(true);
      expect(ensureExcludeBlock(f.writer, f.file, REPO_START_BLOCK, REPO_START_LINES).changed).toBe(false);
      expect(hasBlock(readExclude(f.file), REPO_START_BLOCK)).toBe(true);
      const rows = f.writer.db.prepare("SELECT count(*) AS n FROM installs WHERE key='exclude-v1:repo-start'").get() as { n: number };
      expect(rows.n).toBe(1);
      expect(restoreExcludeBlocks(f.writer)).toEqual({ restored: [f.file], conflicts: [] });
      expect(readFileSync(f.file).equals(Buffer.from(original, "latin1"))).toBe(true);
      expect(readdirSync(join(f.base, "info"))).toEqual(["exclude"]);
      // A second uninstall finds nothing left to do.
      expect(restoreExcludeBlocks(f.writer)).toEqual({ restored: [], conflicts: [] });
    } finally { f.writer.close(); }
  });

  it("keeps the person's later edits and removes only MEX's block", () => {
    const f = fixture(DEFAULT);
    try {
      ensureExcludeBlock(f.writer, f.file, REPO_START_BLOCK, REPO_START_LINES);
      writeFileSync(f.file, `${readFileSync(f.file, "utf8")}/my-own-file\n`);
      restoreExcludeBlocks(f.writer);
      expect(readFileSync(f.file, "utf8")).toBe(`${DEFAULT}/my-own-file\n`);
    } finally { f.writer.close(); }
  });

  it("removes a file it created and undoes a chain of changes newest first", () => {
    const f = fixture(null);
    try {
      ensureExcludeBlock(f.writer, f.file, REPO_START_BLOCK, ["/one"]);
      ensureExcludeBlock(f.writer, f.file, REPO_START_BLOCK, ["/two"]);
      expect(readFileSync(f.file, "utf8")).toBe(blockText(REPO_START_BLOCK, ["/two"]));
      restoreExcludeBlocks(f.writer);
      expect(existsSync(f.file)).toBe(false);
    } finally { f.writer.close(); }
  });

  it.skipIf(process.platform === "win32")("refuses a linked exclude file without journaling or writing", () => {
    const f = fixture(DEFAULT);
    try {
      rmSync(f.file); symlinkSync(join(f.base, "seed"), f.file);
      expect(() => ensureExcludeBlock(f.writer, f.file, REPO_START_BLOCK, REPO_START_LINES)).toThrow(/regular file/u);
      const rows = f.writer.db.prepare("SELECT count(*) AS n FROM installs WHERE key LIKE 'exclude-v1:%'").get() as { n: number };
      expect(rows.n).toBe(0);
      expect(readFileSync(join(f.base, "seed"), "utf8")).toBe("");
    } finally { f.writer.close(); }
  });
});
