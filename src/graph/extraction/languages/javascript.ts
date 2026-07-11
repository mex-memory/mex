// ============================================================================
// mex code-graph — JavaScript / JSX extractor
// ============================================================================
//
// JavaScript is TypeScript-without-types: the same grammar family, the same AST
// shapes for functions/classes/methods/imports/calls. So it reuses the reference
// walker from `./typescript.ts` verbatim, stamping nodes with the `javascript` /
// `jsx` language id and pointing at the JavaScript grammar. (A NEW language would
// instead COPY typescript.ts and adapt the node-type strings — see that file's
// header.)

import { makeTsFamilyExtractor } from "./typescript.js";

/** JavaScript (`.js` / `.mjs` / `.cjs`). */
export const javascriptExtractor = makeTsFamilyExtractor(
  "javascript",
  [".js", ".mjs", ".cjs"],
  "tree-sitter-javascript",
);

/** JavaScript + JSX (`.jsx`). Uses the JavaScript grammar (it handles JSX). */
export const jsxExtractor = makeTsFamilyExtractor(
  "jsx",
  [".jsx"],
  "tree-sitter-javascript",
);
