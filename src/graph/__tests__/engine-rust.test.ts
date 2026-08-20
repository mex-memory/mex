import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openSqlite } from "../db/sqlite.js";
import { createGraphEngine } from "../index.js";
import type { GraphEngine } from "../engine.js";
import { findChangedSourceFiles } from "../runtime.js";

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "sample.rs",
);

let root: string;
let engine: GraphEngine;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "mex-rust-graph-"));
  cpSync(FIXTURE, join(root, "sample.rs"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src/lib.rs"), "pub mod util;\npub mod caller;\n");
  writeFileSync(join(root, "src/util.rs"), "pub fn imported_helper() -> u8 { 1 }\n");
  writeFileSync(
    join(root, "src/caller.rs"),
    "use crate::util::imported_helper;\n"
      + "use crate::util::imported_helper as aliased_helper;\n"
      + "pub fn invoke_imported() -> u8 { imported_helper() }\n"
      + "pub fn invoke_alias() -> u8 { aliased_helper() }\n",
  );
  engine = createGraphEngine({ rootDir: root });
  await engine.build(root);
});

afterAll(() => {
  engine.close();
  rmSync(root, { recursive: true, force: true });
});

describe("Rust graph discovery", () => {
  it("indexes Rust files during a full graph build", () => {
    expect(engine.searchNodes("User").some((node) => (
      node.name === "User" && node.language === "rust"
    ))).toBe(true);
    expect(engine.searchNodes("create_user").some((node) => (
      node.name === "create_user" && node.language === "rust"
    ))).toBe(true);
  });

  it("includes new Rust files in incremental change discovery", () => {
    writeFileSync(join(root, "added.rs"), "pub fn added() {}\n");
    const db = openSqlite(join(root, ".mex", "graph.db"));
    try {
      expect(findChangedSourceFiles(root, db)).toContain("added.rs");
    } finally {
      db.close();
    }
  });

  it("resolves calls only through an explicit local Rust use binding", () => {
    const caller = engine.searchNodes("invoke_imported").find((node) => node.name === "invoke_imported");
    const target = engine.searchNodes("imported_helper").find((node) => node.name === "imported_helper");
    expect(caller).toBeDefined();
    expect(target).toBeDefined();
    expect(engine.getCallees(caller!.id).map((node) => node.id)).toContain(target!.id);
    expect(engine.getOutgoing(caller!.id, ["calls"])).toEqual(expect.arrayContaining([
      expect.objectContaining({
        node: expect.objectContaining({ id: target!.id }),
        edge: expect.objectContaining({ resolutionMethod: "explicit-import", confidence: 1 }),
      }),
    ]));
    const aliasCaller = engine.searchNodes("invoke_alias").find((node) => node.name === "invoke_alias")!;
    expect(engine.getCallees(aliasCaller.id).map((node) => node.id)).toContain(target!.id);
    const db = openSqlite(join(root, ".mex", "graph.db"));
    try {
      expect(db.prepare(
        `SELECT local_name, imported_name, resolved_file_path, target_id FROM import_bindings
         WHERE file_path = 'src/caller.rs' AND local_name = 'aliased_helper'`,
      ).get()).toMatchObject({
        local_name: "aliased_helper",
        imported_name: "imported_helper",
        resolved_file_path: "src/util.rs",
        target_id: target!.id,
      });
    } finally {
      db.close();
    }
  });
});
