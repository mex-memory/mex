// Use syntax for the call shape and the file's own binder for import aliases.
// No dependency resolution or project options enter this classification.
import ts from "typescript";
import { readFileSync } from "node:fs";
import path from "node:path";

export const CALL_FORMS = ["imported_function", "new", "this_method", "super", "other"];

export function callForms(root, files) {
  const paths = new Map([...files].filter((file) => /\.(?:[cm]?[jt]s|[jt]sx)$/i.test(file))
    .map((file) => [path.resolve(root, file), file]));
  if (!paths.size) return new Map();
  const options = { allowJs: true, noLib: true, noResolve: true, types: [], target: ts.ScriptTarget.Latest };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (name, target) => {
    if (!paths.has(name)) return undefined;
    try { return ts.createSourceFile(name, readFileSync(name, "utf8"), target, true); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  };
  host.fileExists = (name) => paths.has(name);
  host.readFile = () => undefined;
  const program = ts.createProgram([...paths.keys()], options, host);
  const checker = program.getTypeChecker();
  const forms = new Map();
  for (const source of program.getSourceFiles()) {
    const file = paths.get(source.fileName);
    const visit = (node) => {
      if (ts.isCallExpression(node) || ts.isNewExpression(node) || ts.isTaggedTemplateExpression(node)) {
        const expression = ts.isTaggedTemplateExpression(node) ? node.tag : node.expression;
        const callee = unwrap(expression);
        const member = ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee);
        const receiver = member && unwrap(callee.expression);
        let form;
        if (ts.isNewExpression(node)) form = "new";
        else if (callee.kind === ts.SyntaxKind.SuperKeyword || receiver?.kind === ts.SyntaxKind.SuperKeyword) form = "super";
        else if (receiver?.kind === ts.SyntaxKind.ThisKeyword) form = "this_method";
        else if (importedCall(checker, callee, receiver)) form = "imported_function";
        if (form) {
          const token = ts.isPropertyAccessExpression(callee) ? callee.name
            : ts.isElementAccessExpression(callee) ? callee.argumentExpression : callee;
          const { line, character } = source.getLineAndCharacterOfPosition(token.getStart(source));
          forms.set(`${file}:${line}:${character}`, form);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return forms;
}

function unwrap(node) {
  while (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node)) node = node.expression;
  return node;
}

function importedCall(checker, callee, receiver) {
  if (ts.isIdentifier(callee)) {
    const kind = importKind(checker, callee);
    return kind === "named" || kind === "require";
  }
  if (!receiver) return false;
  if (ts.isIdentifier(receiver)) {
    const kind = importKind(checker, receiver);
    return kind === "namespace" || kind === "require";
  }
  return isRequire(checker, receiver);
}

function importKind(checker, identifier) {
  const declarations = checker.getSymbolAtLocation(identifier)?.declarations;
  if (declarations?.length !== 1) return undefined;
  const [decl] = declarations;
  if (ts.isImportSpecifier(decl)) return !decl.isTypeOnly && !decl.parent.parent.isTypeOnly ? "named" : undefined;
  if (ts.isImportClause(decl)) return !decl.isTypeOnly ? "named" : undefined;
  if (ts.isNamespaceImport(decl)) return !decl.parent.isTypeOnly ? "namespace" : undefined;
  if (ts.isImportEqualsDeclaration(decl) && !decl.isTypeOnly && ts.isExternalModuleReference(decl.moduleReference)) return "require";
  if (ts.isVariableDeclaration(decl) && decl.initializer) {
    const initializer = unwrap(decl.initializer);
    if (isRequire(checker, initializer)) return "require";
    if ((ts.isPropertyAccessExpression(initializer) || ts.isElementAccessExpression(initializer))
      && isRequire(checker, initializer.expression)) return "named";
  }
  if (ts.isBindingElement(decl) && ts.isObjectBindingPattern(decl.parent)) {
    const declaration = decl.parent.parent;
    if (ts.isVariableDeclaration(declaration) && declaration.initializer
      && isRequire(checker, declaration.initializer)) return "named";
  }
  return undefined;
}

function isRequire(checker, node) {
  if (!ts.isCallExpression(node) || node.arguments.length !== 1 || !ts.isStringLiteralLike(node.arguments[0])) return false;
  const callee = node.expression;
  return ts.isIdentifier(callee) && callee.text === "require" && !checker.getSymbolAtLocation(callee)?.declarations?.length;
}
