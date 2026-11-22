// Score hand-written graphs and a SCIP answer key.
// Run with node scripts/graph-engine-bench/accuracy.selftest.mjs.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { callForms } from "./call-forms.mjs";

const root = mkdtempSync(join(tmpdir(), "mex-graph-accuracy-"));
try {
  const source = "def callee():\n    return 1\n\ndef caller():\n    return callee()\n";
  const callee = "scip-python python bench 0.0.0 app/callee().";
  const graphDb = join(root, "graph.db");
  const scipPath = join(root, "scip.json");
  writeFileSync(join(root, "app.py"), source);
  writeFileSync(scipPath, JSON.stringify({
    documents: [{ relative_path: "app.py", occurrences: [
      { range: [0, 4, 10], symbol: callee, symbol_roles: 1 },
      { range: [3, 4, 10], symbol: "scip-python python bench 0.0.0 app/caller().", symbol_roles: 1 },
      { range: [4, 11, 17], symbol: callee, symbol_roles: 0 },
    ] }],
  }));

  const schema = readFileSync(new URL("../../native/engine/core/src/schema_v5.sql", import.meta.url), "utf8");
  execFileSync("sqlite3", ["-bail", graphDb], { input: `${schema}
    INSERT INTO meta VALUES ('schema_version', '5');
    INSERT INTO languages VALUES (1, 'python');
    INSERT INTO node_kinds VALUES (1, 'function');
    INSERT INTO edge_kinds VALUES (1, 'calls');
    INSERT INTO provenances VALUES (1, 'static');
    INSERT INTO files(id, path, content_hash, language, size, parse_status)
      VALUES (1, 'app.py', zeroblob(32), 1, ${Buffer.byteLength(source)}, 0);
    INSERT INTO nodes(id, public_id, kind, file, name, qualified_name, start_line, start_col, end_line, end_col)
      VALUES (1, zeroblob(16), 1, 1, 'callee', 'app.callee', 1, 0, 2, 12),
             (2, x'00000000000000000000000000000001', 1, 1, 'caller', 'app.caller', 4, 0, 5, 19);
    INSERT INTO edges(source, kind, target, line, col, provenance) VALUES (2, 1, 1, 5, 11, 1);
  ` });

  const accuracy = fileURLToPath(new URL("accuracy.mjs", import.meta.url));
  const score = (db = graphDb) => {
    const { precision, recall } = JSON.parse(execFileSync(process.execPath, [accuracy, root, db, scipPath]));
    return { precision, recall };
  };
  const correct = score();
  assert.deepEqual(correct, { precision: 1, recall: 1 });
  console.log("v5 correct edge", JSON.stringify(correct));

  execFileSync("sqlite3", ["-bail", graphDb, "UPDATE edges SET target = 2"]);
  const corrupt = score();
  assert.deepEqual(corrupt, { precision: 0, recall: 0 });
  console.log("v5 corrupt edge", JSON.stringify(corrupt));

  const v4 = join(root, "v4.db");
  writeFileSync(join(root, "site.py"), "\n\n\n\nwire(callee)\n");
  execFileSync("sqlite3", ["-bail", v4], { input: `
    CREATE TABLE nodes(id, kind, name, file_path, start_line, end_line, container_id);
    CREATE TABLE edges(source, target, kind, line, col, provenance, evidence);
    INSERT INTO nodes VALUES ('callee', 'function', 'callee', 'app.py', 1, 2, NULL),
                             ('caller', 'function', 'caller', 'app.py', 4, 5, NULL);
    INSERT INTO edges VALUES ('caller', 'callee', 'calls', 5, 11, 'typescript-compiler', NULL),
      ('callee', 'caller', 'calls', 5, 11, 'callback-synthesis',
       '[{"wiringSite":{"filePath":"site.py","line":5,"column":5}}]');
  ` });
  const withCallback = score(v4);
  assert.deepEqual(withCallback, { precision: 1, recall: 1 });
  console.log("v4 callback with its own site", JSON.stringify(withCallback));

  writeFileSync(join(root, "forms.ts"), [
    'import { f as invoke } from "./lib";',
    'import * as ns from "./lib";',
    'import type { f as typeOnly } from "./lib";',
    'const load = require("./factory");',
    'invoke();',
    'function shadow(invoke: () => void) { invoke(); }',
    'ns.f();',
    'typeOnly();',
    'load();',
    'new A();',
    'class Derived extends A {',
    '  constructor() { super(); }',
    '  test() { this.test(); super.test(); }',
    '}',
  ].join("\n"));
  const forms = callForms(root, ["forms.ts"]);
  assert.deepEqual([...forms], [
    ["forms.ts:4:0", "imported_function"],
    ["forms.ts:6:3", "imported_function"],
    ["forms.ts:8:0", "imported_function"],
    ["forms.ts:9:4", "new"],
    ["forms.ts:11:18", "super"],
    ["forms.ts:12:16", "this_method"],
    ["forms.ts:12:30", "super"],
  ]);
} finally {
  rmSync(root, { recursive: true, force: true });
}
