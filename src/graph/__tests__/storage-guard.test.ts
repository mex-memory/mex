import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";

it("centralizes every production checkout graph path in storage", () => {
  const bad: string[] = [];
  function walk(folder: string): void {
    for (const entry of readdirSync(folder,{withFileTypes:true})) {
      if (entry.name === "__tests__" || entry.name === "node_modules" || entry.name === "dist") continue;
      const path = join(folder,entry.name);
      if (entry.isDirectory()) { walk(path); continue; }
      if (!/\.(ts|mjs|js)$/.test(entry.name) || /\.test\./.test(entry.name) || path.replaceAll("\\","/").endsWith("/graph/storage.ts")) continue;
      const source = ts.createSourceFile(path,readFileSync(path,"utf8"),ts.ScriptTarget.Latest,true);
      function visit(node: ts.Node): void {
        if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
          const called = node.expression.getText(source);
          if (/(?:join|resolve|openSqlite|openGraphDatabase|DatabaseSync|readFileSync|writeFileSync|existsSync)$/.test(called)
            && node.arguments?.some(arg=>ts.isStringLiteral(arg) && (arg.text === "graph.db" || /[\\/]graph\.db$/.test(arg.text)))) {
            bad.push(`${path}:${source.getLineAndCharacterOfPosition(node.getStart()).line+1}`);
          }
        }
        ts.forEachChild(node,visit);
      }
      visit(source);
    }
  }
  walk("src"); walk("packages");
  expect(bad).toEqual([]);
});
