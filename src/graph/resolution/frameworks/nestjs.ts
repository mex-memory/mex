import { generateNodeId } from "../../extraction/node-id.js";
import type { GraphNode, Language } from "../../types.js";
import type { FrameworkExtractionResult, FrameworkResolver, ResolvedRef, UnresolvedRef } from "../types.js";

// Basic parsing for NestJS decorators without a full AST walk.
// It assumes standard formatting and single controller per file for simplicity,
// or sequentially processes them if multiple exist.

const DECORATOR_REGEX = /@(Controller|Get|Post|Put|Patch|Delete|Options|Head|All)\s*\(\s*(?:(["'`])(.*?)\2)?\s*\)/g;

export const nestjsResolver: FrameworkResolver = {
  name: "nestjs",
  languages: ["typescript", "javascript"],
  detect(context) {
    const pkg = context.readFile("package.json");
    if (!pkg) return false;
    try {
      const parsed = JSON.parse(pkg) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      return Boolean(
        parsed.dependencies?.["@nestjs/core"] ??
        parsed.dependencies?.["@nestjs/common"] ??
        parsed.devDependencies?.["@nestjs/core"] ??
        parsed.devDependencies?.["@nestjs/common"]
      );
    } catch { return false; }
  },
  claimsReference: (name) => /^[A-Za-z_$][\w$]*$/.test(name),
  extract(filePath, content): FrameworkExtractionResult {
    const nodes: GraphNode[] = [];
    const references: UnresolvedRef[] = [];
    const language = languageFor(filePath);
    if (!language) return { nodes, references };

    let currentControllerPath = "";
    
    for (const match of content.matchAll(DECORATOR_REGEX)) {
      const type = match[1]!;
      const pathArg = match[3] ?? "";
      
      if (type === "Controller") {
        currentControllerPath = pathArg;
        continue;
      }

      // It's an HTTP method
      const httpMethod = type.toUpperCase();
      
      // Normalize route path: GET /controllerPath/methodPath
      let fullPath = currentControllerPath;
      if (fullPath && !fullPath.startsWith("/")) fullPath = "/" + fullPath;
      
      let subPath = pathArg;
      if (subPath && !subPath.startsWith("/")) subPath = "/" + subPath;
      if (subPath === "/") subPath = "";
      
      fullPath += subPath;
      if (!fullPath) fullPath = "/";
      else if (fullPath.length > 1 && fullPath.endsWith("/")) fullPath = fullPath.slice(0, -1);
      
      const routeName = `${httpMethod} ${fullPath}`;
      
      // Forward scan to find the handler method name
      // Skip whitespace, comments, and other decorators until we find an identifier followed by '(' or '<'
      let handlerName = "";
      let idx = match.index + match[0].length;
      
      while (idx < content.length) {
        // Skip whitespace
        if (/\s/.test(content[idx]!)) {
          idx++;
          continue;
        }
        
        // Skip line comments
        if (content[idx] === "/" && content[idx+1] === "/") {
          while (idx < content.length && content[idx] !== "\n") idx++;
          continue;
        }
        
        // Skip block comments
        if (content[idx] === "/" && content[idx+1] === "*") {
          idx += 2;
          while (idx < content.length && !(content[idx] === "*" && content[idx+1] === "/")) idx++;
          idx += 2;
          continue;
        }
        
        // Skip other decorators
        if (content[idx] === "@") {
          idx++;
          // Skip identifier
          while (idx < content.length && /[A-Za-z0-9_$]/.test(content[idx]!)) idx++;
          // If it has parens, skip them
          if (content[idx] === "(") {
            let depth = 1;
            idx++;
            while (idx < content.length && depth > 0) {
              if (content[idx] === "(") depth++;
              else if (content[idx] === ")") depth--;
              idx++;
            }
          }
          continue;
        }
        
        // Skip keywords like 'async', 'public', 'private', 'protected'
        const substr = content.slice(idx);
        const keywordMatch = /^(?:async|public|private|protected)\s+/.exec(substr);
        if (keywordMatch) {
           idx += keywordMatch[0].length;
           continue;
        }

        // We should be at the method name now
        const methodMatch = /^([A-Za-z_$][\w$]*)\s*[<([]/.exec(substr);
        if (methodMatch) {
          handlerName = methodMatch[1]!;
          break;
        }
        
        // If we hit something unexpected, stop
        break;
      }
      
      if (!handlerName) continue;

      const line = content.slice(0, match.index).split("\n").length;
      const id = generateNodeId(filePath, "route", routeName);
      nodes.push({ id, kind: "route", name: routeName, qualifiedName: routeName, filePath, language,
        startLine: line, endLine: line, startColumn: 0, endColumn: match[0].length,
        isExported: false, updatedAt: 0 });
      references.push({ fromNodeId: id, referenceName: handlerName, referenceKind: "function_ref",
        filePath, language, line: line, column: 0 }); // Note: line is the decorator line
    }
    
    return { nodes, references };
  },
  resolve(ref, context): ResolvedRef | null {
    if (ref.referenceKind !== "function_ref") return null;
    const candidates = context.getNodesByName(ref.referenceName)
      .filter((node) => node.kind === "method" || node.kind === "function");
    const sameFile = candidates.filter((node) => node.filePath === ref.filePath);
    
    // NestJS methods are always in the same file as the controller route decorators.
    if (sameFile.length === 1) {
       return { original: ref, targetNodeId: sameFile[0]!.id, confidence: 1, resolvedBy: "framework" };
    }
    
    return null;
  },
};

function languageFor(filePath: string): Language | null {
  if (/\.(ts|mts|cts)$/.test(filePath)) return "typescript";
  if (/\.tsx$/.test(filePath)) return "tsx";
  if (/\.(js|mjs|cjs)$/.test(filePath)) return "javascript";
  if (/\.jsx$/.test(filePath)) return "jsx";
  return null;
}
