// Regenerate the Rust scanner's tables from the TypeScript version MEX scans with.
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";

if (ts.version !== "5.9.3") throw new Error(`Expected TypeScript 5.9.3, got ${ts.version}`);

const { SyntaxKind, ScriptTarget, LanguageVariant } = ts;
const primaryNames = new Map();
for (const [name, kind] of Object.entries(SyntaxKind)) {
  if (typeof kind === "number" && !primaryNames.has(kind)) primaryNames.set(kind, name);
}

// Try every keyword and punctuator spelling, plus the kinds without fixed
// spellings. Let scan() exclude kinds that require trivia or parser rescans.
const samples = ["\0", "\ufffd", "0", "0n", '""', "``", "`${", "x", "#x"];
for (const kind of primaryNames.keys()) {
  const spelling = ts.tokenToString(kind);
  if (spelling !== undefined) samples.push(spelling);
}
const emitted = new Set([SyntaxKind.EndOfFileToken]);
for (const variant of [LanguageVariant.Standard, LanguageVariant.JSX]) {
  for (const text of samples) {
    const scanner = ts.createScanner(ScriptTarget.Latest, true, variant, text);
    for (let kind = scanner.scan(); kind !== SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
      emitted.add(kind);
    }
  }
}
const kinds = [...emitted].sort((a, b) => a - b);

const require = createRequire(import.meta.url);
const compiler = readFileSync(require.resolve("typescript"), "utf8");

function unicodeTable(sourceName, rustName) {
  const initializer = compiler.match(new RegExp(`^var ${sourceName} = \\[([^\\]]+)\\];$`, "m"))?.[1];
  if (!initializer) throw new Error(`Missing ${sourceName} in TypeScript ${ts.version}`);
  const endpoints = initializer.split(",").map(Number);
  if (endpoints.length % 2 || !endpoints.every(Number.isInteger)) {
    throw new Error(`Invalid ranges in ${sourceName}`);
  }
  const ranges = [];
  for (let i = 0; i < endpoints.length; i += 2) {
    ranges.push(`    (${endpoints[i]}, ${endpoints[i + 1]}),`);
  }
  return [`const ${rustName}: &[(u32, u32)] = &[`, ...ranges, "];"].join("\n");
}

const tables = [
  `// Generated from TypeScript ${ts.version}. Regenerate from the repository root with:
// node scripts/graph-engine-bench/generate-scanner-tables.mjs
// Copyright (c) Microsoft Corporation. Licensed under Apache-2.0.
// See LICENSE-APACHE and NOTICE in this crate.`,
  [
    "#[derive(Clone, Copy, PartialEq, Eq)]",
    "enum Kind {",
    ...kinds.map((kind) => `    ${primaryNames.get(kind)},`),
    "}",
  ].join("\n"),
  [
    "impl Kind {",
    "    fn name(self) -> &'static str {",
    `        const NAMES: [&str; ${kinds.length}] = [`,
    ...kinds.map((kind) => `            ${JSON.stringify(SyntaxKind[kind])},`),
    "        ];",
    "        NAMES[self as usize]",
    "    }",
    "}",
  ].join("\n"),
  [
    "fn keyword(text: &[u8]) -> Kind {",
    "    match text {",
    ...kinds
      .filter((kind) => kind >= SyntaxKind.FirstKeyword && kind <= SyntaxKind.LastKeyword)
      .map((kind) => `        b${JSON.stringify(ts.tokenToString(kind))} => Kind::${primaryNames.get(kind)},`),
    "        _ => Kind::Identifier,",
    "    }",
    "}",
  ].join("\n"),
  unicodeTable("unicodeESNextIdentifierStart", "UNICODE_IDENTIFIER_START"),
  unicodeTable("unicodeESNextIdentifierPart", "UNICODE_IDENTIFIER_PART"),
];

writeFileSync(
  new URL("../../native/engine/langs/ecmascript/src/scanner_tables.inc.rs", import.meta.url),
  `${tables.join("\n\n")}\n`,
);
