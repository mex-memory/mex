// v3 (#240): checker-rendered signatures no longer embed absolute module paths.
// v4 (#209): checker-rendered unions list their members in one canonical order.
// v6: property-assigned function values retain their authored target name.
// v7 (#281): out-of-scope aliases render by name, and calls carry no rendered
// signature evidence.
// v8: TypeScript 7.1's API builds the graph by default; node signatures are
// display text with ordinary truncation, and return types are as written.
export const TYPESCRIPT_COMPILER_EXTRACTOR_VERSION = "typescript-api-v8";
