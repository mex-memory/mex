import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalNodeIdentity, generateNodeId } from "../extraction/node-id.js";
import { canonicalCompilerIdentity, generateCanonicalCompilerNodeId } from "../extraction/compiler.js";
import type { NodeKind } from "../types.js";

/**
 * Shared node-id vectors for the Rust graph engine (OSS-73).
 *
 * `native/graph/core/tests/id-vectors.json` lists identity inputs with the
 * identity string and id that TypeScript produces for them. This test keeps
 * the file equal to what TypeScript computes today; the Rust port runs the
 * same file (`native/graph/core/tests/id_vectors.rs`). Run with
 * `MEX_WRITE_ID_VECTORS=1` to regenerate it after an intended change.
 */
const VECTORS = join(import.meta.dirname, "../../../native/graph/core/tests/id-vectors.json");

interface SignatureInput { profile: "signature"; path: string; kind: string; qualifiedName: string; declarationRole?: string; signature: string }
interface OrdinalInput { profile: "ordinal"; path: string; kind: string; qualifiedName: string; declarationRole: string; ordinal?: number }
type Input = SignatureInput | OrdinalInput;

// Inputs chosen to break a careless port: path forms, JavaScript-only
// whitespace (NBSP, U+FEFF, U+3000, line separators), U+0085 (whitespace to
// Rust, not to JavaScript), astral characters, `::` segments and ordinals.
const INPUTS: Input[] = [
  { profile: "signature", path: "src/app.py", kind: "function", qualifiedName: "main", signature: "()" },
  { profile: "signature", path: "pkg\\mod.py", kind: "method", qualifiedName: "Client.request", signature: "(self, method, url)" },
  { profile: "signature", path: "src/lib.rs", kind: "function", qualifiedName: "  spaced \t name  ", declarationRole: "free-function", signature: "fn  run(\n  x: u32,\n)" },
  { profile: "signature", path: "src/a.cs", kind: "method", qualifiedName: "N.C.M", signature: "(int a,　string b)" },
  { profile: "signature", path: "src/a.cs", kind: "method", qualifiedName: "N.C.M", signature: "(int a)" },
  { profile: "signature", path: "src/bom.py", kind: "class", qualifiedName: "﻿Bom", signature: "" },
  { profile: "signature", path: "src/nel.py", kind: "function", qualifiedName: "a\u0085b", signature: "(x\u0085)" },
  { profile: "signature", path: "src/ls.py", kind: "function", qualifiedName: "a b", signature: "( )" },
  { profile: "signature", path: "src/emoji.py", kind: "function", qualifiedName: "f😀", signature: "(s: '𝒳')" },
  { profile: "signature", path: "src/empty.py", kind: "variable", qualifiedName: "", signature: "" },
  { profile: "signature", path: "./src/dot.py", kind: "function", qualifiedName: "dot", declarationRole: "framework:flask", signature: "()" },
  { profile: "ordinal", path: "src/index.ts", kind: "function", qualifiedName: "handler", declarationRole: "function" },
  { profile: "ordinal", path: "./src/index.ts", kind: "file", qualifiedName: "src/index.ts", declarationRole: "source-file" },
  { profile: "ordinal", path: "src\\win\\path.ts", kind: "method", qualifiedName: "App::route", declarationRole: "method" },
  { profile: "ordinal", path: "src/ns.ts", kind: "method", qualifiedName: "A :: b ::  c", declarationRole: "  method  " },
  { profile: "ordinal", path: "src/over.ts", kind: "function", qualifiedName: "over", declarationRole: "function", ordinal: 0 },
  { profile: "ordinal", path: "src/over.ts", kind: "function", qualifiedName: "over", declarationRole: "function", ordinal: 3 },
  { profile: "ordinal", path: "src/assign.js", kind: "function", qualifiedName: "res.send", declarationRole: "function-assignment" },
  { profile: "ordinal", path: "src/ws.ts", kind: "class", qualifiedName: "﻿ Widget　", declarationRole: "class" },
  { profile: "ordinal", path: "src/nel.ts", kind: "function", qualifiedName: "x\u0085", declarationRole: "function" },
];

function compute(input: Input): { identity: string; id: string } {
  if (input.profile === "signature") {
    const kind = input.kind as NodeKind;
    const identity = canonicalNodeIdentity(input.path, kind, input.qualifiedName, input.declarationRole ?? kind, input.signature);
    const id = generateNodeId(input.path, kind, input.qualifiedName, input.qualifiedName, input.declarationRole ?? kind, input.signature);
    return { identity, id };
  }
  const identity = canonicalCompilerIdentity({
    filePath: input.path, kind: input.kind as never, qualifiedName: input.qualifiedName,
    declarationRole: input.declarationRole, ...(input.ordinal === undefined ? {} : { ordinal: input.ordinal }),
  });
  return { identity, id: generateCanonicalCompilerNodeId(input.kind as never, identity) };
}

describe("shared node-id vectors for the Rust engine", () => {
  const computed = INPUTS.map((input) => ({ input, ...compute(input) }));

  it("matches the committed vectors", () => {
    if (process.env.MEX_WRITE_ID_VECTORS === "1") writeFileSync(VECTORS, `${JSON.stringify(computed, null, 2)}\n`);
    expect(JSON.parse(readFileSync(VECTORS, "utf8"))).toEqual(computed);
  });

  it("covers both profiles and distinct ids", () => {
    expect(new Set(computed.map((v) => v.input.profile))).toEqual(new Set(["signature", "ordinal"]));
    expect(new Set(computed.map((v) => v.id)).size).toBe(computed.length);
  });
});
