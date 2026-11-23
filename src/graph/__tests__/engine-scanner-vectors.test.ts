import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// The Rust test consumes the same vectors. Regenerate from the repository root
// with MEX_WRITE_SCANNER_VECTORS=1 npx vitest run src/graph/__tests__/engine-scanner-vectors.test.ts.
const VECTORS = join(import.meta.dirname, "../../../native/engine/langs/ecmascript/tests/scanner-vectors.json");

const SPELLINGS = new Map<ts.SyntaxKind, string>();
for (let kind: ts.SyntaxKind = ts.SyntaxKind.FirstPunctuation; kind <= ts.SyntaxKind.LastKeyword; kind++) {
  const spelling = ts.tokenToString(kind);
  if (spelling !== undefined) SPELLINGS.set(kind, spelling);
}

const SOURCES = [...new Set([
  ...SPELLINGS.values(),
  // Whitespace, comments, shebangs and the binary-file marker.
  "",
  " \t\r\n\v\f",
  "let\u0085x\u00a0=\u16801\u2000+\u200b2\u202f+\u205f3\u3000;\ufeff",
  "a\u2001b\u2002c\u2003d\u2004e\u2005f\u2006g\u2007h\u2008i\u2009j\u200ak",
  "a\u2028b\u2029c",
  "a\u180eb\u001cc\u007f",
  "\0",
  "x\0y",
  "\ufffd",
  "x \ufffdclass y {}",
  "#!",
  "#!/usr/bin/env node\nconst x = 1",
  "#!bin\r\nvalue",
  "#!bin\u2028value",
  "#!bin\u2029value",
  "#!bin\u0085hidden\nvalue",
  "\ufeff#!bin\nvalue",
  " #!bin\nvalue",
  "x\n#!bin\nvalue",
  "// comment",
  "// @ts-expect-error\r\nclass X {}",
  "// comment\u2028let a // comment\u2029let b",
  "// comment\u0085still comment\nlet a",
  "/*/",
  "/*",
  "/**/",
  "/* comment **/ *",
  "/** @see x\n */\n*",
  "/* outer /* inner */ after */",
  "/* \ufffd\n\u2028 \u2029 */ after",
  "prefix/* unterminated",
  // Merge markers, including diff3 and exactly seven characters at EOF.
  "<<<<<<< HEAD\nconst current = 1\n=======\nconst other = 2\n>>>>>>> other\nconst after = 3",
  "<<<<<<< HEAD\r\nx\r\n||||||| base\r\nx2\r\n=======\r\nx3\r\n>>>>>>> other\r\ny",
  "<<<<<<< HEAD\u2028x\u2029=======\u0085not a break\u2028z\u2029>>>>>>> other\u2028y",
  "||||||| base\nold\n>>>>>>> end\nkept",
  "=======\nours\n=======\ntheirs\n>>>>>>> end\nkept",
  "=======anything",
  "=======",
  "<<<<<<<",
  ">>>>>>>",
  "|||||||",
  "<<<<<<<\tHEAD",
  " <<<<<<< HEAD",
  "a\u0085<<<<<<< HEAD",
  "a\u2029<<<<<<< HEAD",
  "a/*\n*/=======\nlet x",
  "a\n<<<<<<<< HEAD",
  // Identifiers, private names, and Unicode start/continuation boundaries.
  "foo _foo $foo Foo _ $ abc123",
  "Class break1 deferral satisfies2 _await instanceof_",
  "é e\u0301 变量 αβ א أ हिन्दी",
  "\u037a \u309b a\u00b7 𝒜 𐐀x x𐐀",
  "\u0301x ١x x١",
  "\u200cx \u200dx break\u200c break\u200d",
  "a\u{e0100}b \u{e0100}b",
  "😀x x😀y 😀😀 ☃ \ufdd0 \u{10ffff}",
  "# #x #class #$ #_ #变量 #𐐀",
  "## #1 #😀 #? #. #\u200c #\ufffd",
  String.raw`\u0062reak br\u0065ak br\u{65}ak`,
  String.raw`\u{63}lass a\u{10400}z \u{10400}z`,
  String.raw`\u{24} \u005f ab\u0031 \u0031a`,
  String.raw`\uD801\uDC00 z\uD801\uDC00 \u{D801}`,
  String.raw`a\u0301 \u0301 x\u{e0100} a\u{200c} a\u200d`,
  String.raw`\u{0000000000000000000000069}f`,
  String.raw`\u0069ignored\u{66}`,
  String.raw`cl\u0061ignored\u{73}s`,
  String.raw`\u{69`,
  String.raw`\u{69\u0066`,
  String.raw`\u{69xyz; a\u{31 x; a\u{61}x`,
  String.raw`\u{} \u{z} \u{20} \u{1f600} \u{110000} \u{ffffffffffff}`,
  String.raw`\u \u123 \u00z0 \u12é \uＧ000 \U0061 \x61`,
  "\\",
  "x\\",
  String.raw`#\u0061 #\u{10400} #\u{61 #\u0030 #\u{d800} #\u{}`,
  String.raw`#x\u{31} #\u{200c} #\u{24}`,
  // Base prefixes, suffixes, separators, and malformed numbers.
  "0 123 -42 42n 0n -0n 123_456n",
  "0x",
  "0b",
  "0o",
  "0X",
  "0B",
  "0O",
  "0x 0b 0o ",
  "0x😀 0b𐐀 0oé",
  "0x\0",
  "0xFF 0Xabcd 0b101 0B01 0o77 0O07",
  "0xffn 0XFn 0b10n 0B1n 0o770n 0O7n",
  "0xn 0bn 0on 0xg 0b2 0o8",
  "0x_ 0b__ 0o_ 0x__n 0b_n 0o__n",
  "0x1__fn 0b1__01n 0o7__05n",
  "0x1nfoo 0b1nn 0o7nn 10nfoo",
  "0xfe+1 0XAB.9 0b1.0 0o7e1",
  "00 0123 08 099 078 09n 00n 012n",
  "00.1 01.e2 077e1 00e-1 08.1n 08e+2n",
  "00_0n 08_0n 0_0n 0__9n 9__ 09_",
  "0. 1. .5 1.25 .5e-2 0e+1 1E-3",
  "1..2 .1.2 1...x ... .1e5",
  "1._ 1._2 1.__e___3 1e0_2 1e_",
  "1e 1E+ 1e- 1e+x 1E-foo 1e++8",
  "1e+n 1E-_n 1.0n 1.0nn .5n .5ns",
  "1nn 1nnn 1nnever 1namespace 1defer 1é",
  "1.n\u0301 1.n𐐀 1.n😀",
  String.raw`1.\u006e 1.n\u0030 1.nn\u{e9} 1.nn\u{10400}`,
  String.raw`1.nn\u{301} 1.nn\u{61 1.nn\u{61} 1nnn\u{61}`,
  "?.7 ?.١ ?. .7 ?.e",
  // Quoted strings and template heads, including malformed escapes.
  "'' \"\" '😀\u0085x\u2028y\u2029z\0' after",
  "'unclosed",
  "\"unclosed",
  "'a\nlet x",
  "\"a\r\nb",
  "'a\\\r\nb' after",
  "'a\\\rb\\\nc\\\u2028d\\\u2029e' after",
  "\"a\\",
  "'a\\😀b' after",
  "'a\ufffdb' after",
  String.raw`"'s" '\"' '\'' "\\" after`,
  String.raw`'\0\08\01\011\377\400\777\8\9' after`,
  String.raw`'\n\r\t\b\v\f\z\x41\u0041\u{41}\u{1f600}' after`,
  String.raw`'\u12' '\x1' '\u{41' '\u{}' '\u{110000}' '\uD801\uDC00' after`,
  "'\\u{4\nreturn",
  "'\\x\u2028still in string' after",
  "``",
  "`plain`",
  "`no close",
  "`no close\\",
  "`${",
  "`head ${x} tail`",
  "`a${`b${n}c`}d`",
  "`a\\${b\\`c` tail",
  "`a\\x${b}c`",
  "`a\\u{41${b}c`",
  "`a\\u12\\u{110000}\\u{}\\01\\8` after",
  "`a\r\nb\\\r\nc\u2028d\u2029e\ufffd😀` after",
  // JSX-looking text and operator sequences with no parser rescans.
  "<div data-id='a'>Hello &amp; world</div>",
  "<ns:a x:y=\"a\nb\">{x as Foo<Bar>}</ns:a>",
  "<>class yield 1.0n // jsx-looking text\n</>",
  "<// comment-looking text</x>\nnext",
  "</* a block comment */x",
  "</=x",
  "a-b a:b #a-b #a:b",
  "T<U<V>> x >>>= y >= z >>= w",
  "x = /a[\\/]b/gu; x/=2;",
  "<!-- comment-looking text -->",
  "a<<=b&&=c||=d??=e**=f",
])];

function scan(text: string, jsx: boolean): string[] {
  const variant = jsx ? ts.LanguageVariant.JSX : ts.LanguageVariant.Standard;
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, variant, text);
  const names: string[] = [];
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    names.push(ts.SyntaxKind[kind] ?? `SyntaxKind:${kind}`);
  }
  return names;
}

const computed = {
  typescript: ts.version,
  cases: SOURCES.map((text) => ({ text, standard: scan(text, false), jsx: scan(text, true) })),
};

describe("shared TypeScript scanner vectors for the Rust engine", () => {
  it("matches the committed vectors", () => {
    if (process.env.MEX_WRITE_SCANNER_VECTORS === "1") {
      writeFileSync(VECTORS, `${JSON.stringify(computed, null, 2)}\n`);
    }
    expect(JSON.parse(readFileSync(VECTORS, "utf8"))).toEqual(computed);
  });

  it("covers every kind emitted by scan() in both variants", () => {
    const unreachableSpellings = new Set<ts.SyntaxKind>([
      ts.SyntaxKind.BacktickToken,
      ts.SyntaxKind.HashToken,
      ts.SyntaxKind.GreaterThanEqualsToken,
      ts.SyntaxKind.GreaterThanGreaterThanToken,
      ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken,
      ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
      ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
    ]);
    const expected = [
      ts.SyntaxKind.Unknown,
      ts.SyntaxKind.NonTextFileMarkerTrivia,
      ts.SyntaxKind.NumericLiteral,
      ts.SyntaxKind.BigIntLiteral,
      ts.SyntaxKind.StringLiteral,
      ts.SyntaxKind.NoSubstitutionTemplateLiteral,
      ts.SyntaxKind.TemplateHead,
      ts.SyntaxKind.Identifier,
      ts.SyntaxKind.PrivateIdentifier,
      ...[...SPELLINGS.keys()].filter((kind) => !unreachableSpellings.has(kind)),
    ].map((kind) => ts.SyntaxKind[kind]);

    for (const variant of ["standard", "jsx"] as const) {
      const seen = new Set(computed.cases.flatMap((vector) => vector[variant]));
      const expectedNames = variant === "jsx"
        ? expected
        : expected.filter((name) => name !== ts.SyntaxKind[ts.SyntaxKind.LessThanSlashToken]);
      expect([...seen].sort(), variant).toEqual(expectedNames.sort());
    }
  });
});
