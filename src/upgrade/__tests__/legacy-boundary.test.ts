import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import ts from "typescript";

const ROOT = resolve(__dirname, "../../..");
const FS_READS = new Set(["closeSync", "constants", "fstatSync", "lstatSync", "openSync", "opendirSync", "readSync", "realpathSync"]);

it("keeps the legacy reader independent of removed engines, databases, writers and machine state", () => {
  const seen = new Set<string>();
  const visit = (path: string): void => {
    if (seen.has(path)) return;
    seen.add(path);
    const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
      if (!statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      if (ts.isImportDeclaration(statement) && statement.importClause?.isTypeOnly) continue;
      if (ts.isExportDeclaration(statement) && statement.isTypeOnly) continue;
      const specifier = statement.moduleSpecifier.text;
      expect(specifier).not.toBe("node:sqlite");
      expect(specifier).not.toBe("node:child_process");
      if (specifier === "node:fs") {
        expect(ts.isImportDeclaration(statement)).toBe(true);
        const bindings = (statement as ts.ImportDeclaration).importClause?.namedBindings;
        expect(bindings && ts.isNamedImports(bindings)).toBe(true);
        if (bindings && ts.isNamedImports(bindings)) for (const imported of bindings.elements) {
          if (!imported.isTypeOnly) expect(FS_READS.has((imported.propertyName ?? imported.name).text)).toBe(true);
        }
      }
      if (!specifier.startsWith(".")) continue;
      const target = resolve(dirname(path), specifier.replace(/\.js$/u, ".ts"));
      const owned = relative(ROOT, target).replace(/\\/gu, "/");
      expect(owned, "release-04 must retain only this read-side dependency closure").toMatch(
        /^src\/(?:upgrade\/|wiki\/(?:markdown\/|model\/|index\/(?:discover|corpus-policy)\.ts$)|graph\/(?:fingerprint|config|reconcile|errors)\.ts$|paths\.ts$)/u,
      );
      visit(target);
    }
    const dynamic: string[] = [];
    const calls = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) dynamic.push(node.getText(source));
      ts.forEachChild(node, calls);
    };
    calls(source);
    expect(dynamic).toEqual([]);
  };
  visit(resolve(ROOT, "src/upgrade/legacy-reader.ts"));
  expect(seen.size).toBeGreaterThan(10);
});
