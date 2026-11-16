import { posix } from "node:path";

/** Extensions tried for a relative import, in the order bundlers try them. */
const EXTENSIONS = ["", ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", "/index.ts", "/index.tsx", "/index.js", "/index.jsx", "/index.mjs"];

/**
 * Resolve a relative import (`./x`, `../x`) of an indexed file to an indexed
 * path, or undefined. Package imports and paths outside the checkout don't
 * resolve: they name no file here.
 */
export function resolveImport(from: string, importer: string, known: ReadonlySet<string>): string | undefined {
  if (!from.startsWith("./") && !from.startsWith("../")) return undefined;
  const base = posix.normalize(posix.join(posix.dirname(importer), from));
  if (base.startsWith("../") || base === "..") return undefined;
  const stem = base.replace(/\.(js|jsx|mjs|cjs)$/, "");
  for (const candidate of [base, ...EXTENSIONS.map((ext) => stem + ext)]) if (known.has(candidate)) return candidate;
  return undefined;
}
