# Code graph preview support

The code graph in v0.7.0 is an **unreleased developer preview** on the
`code-graph-preview` branch. It is not part of the stable npm release.

This page distinguishes three evidence levels:

- **Supported** — implemented and exercised by a focused fixture and test.
- **Partial** — wired into the preview, but not independently fixture-tested for
  every listed extension or syntax family.
- **Unsupported** — no grammar and extractor are registered in this preview.

## Language and file support

The extension and grammar mappings live in
[`src/graph/extraction/grammars.ts`](../src/graph/extraction/grammars.ts), and the
extractor registry lives in
[`src/graph/extraction/languages/index.ts`](../src/graph/extraction/languages/index.ts).

| Status | Language | Extensions | Current evidence |
|---|---|---|---|
| **Supported** | TypeScript | `.ts` | [`sample.ts`](../src/graph/__tests__/fixtures/sample.ts) and [`extractor.test.ts`](../src/graph/__tests__/extractor.test.ts) exercise the TypeScript grammar and extractor. |
| **Partial** | TypeScript modules | `.mts`, `.cts` | Both extensions map to the TypeScript grammar and extractor, but the current `sample.ts` fixture does not exercise them separately. |
| **Partial** | TSX | `.tsx` | The TSX grammar and extractor are registered, but there is no dedicated TSX fixture in the current branch. |
| **Partial** | JavaScript | `.js`, `.mjs`, `.cjs` | The JavaScript extractor reuses the TypeScript-family walker and the JavaScript grammar is registered, but there is no dedicated JavaScript fixture in the current branch. |
| **Partial** | JSX | `.jsx` | JSX uses the registered JavaScript grammar and shared walker, but there is no dedicated JSX fixture in the current branch. |
| **Supported** | Python | `.py` | [`sample.py`](../src/graph/__tests__/fixtures/sample.py), [`extractor-python.test.ts`](../src/graph/__tests__/extractor-python.test.ts), and the [`python-package`](../src/graph/__tests__/fixtures/python-package) integration fixture cover extraction and cross-file package resolution. |
| **Unsupported** | Go, Rust, and other languages | All other extensions | These names are reserved in [`src/graph/types.ts`](../src/graph/types.ts), but no grammar or extractor is registered for them. Unsupported files are skipped rather than failing a graph build. |

`src/graph/types.ts` contains a wider future-facing language vocabulary. A name
in that type union is not a support promise; the grammar and extractor
registries above are the current sources of truth.

## Fixture-backed extraction

The current fixture contains an import, an exported function, a class, methods,
a callable field, a property, a constant, inheritance, interface
implementation, calls, and construction:

```ts
import { formatName } from "./helpers";

const PREFIX = "hello";

export function greet(name: string): string {
  return formatName(name);
}

export class Greeter extends Base implements Speaker {
  greeting = PREFIX;
  speak(name: string): string {
    const w = new Warmup();
    return greet(name);
  }
}
```

[`extractor.test.ts`](../src/graph/__tests__/extractor.test.ts) proves the
following output from [`sample.ts`](../src/graph/__tests__/fixtures/sample.ts):

| Output | Fixture-backed behavior |
|---|---|
| Nodes | `file`, `function`, `class`, `method`, `property`, and `constant` |
| Symbol metadata | exported state, function signature, docstring, and qualified method name |
| Relationships | `contains`, `imports`, `calls`, `extends`, `implements`, and `instantiates` |

The complete shared vocabulary in
[`src/graph/types.ts`](../src/graph/types.ts) includes additional node and edge
kinds for current internals and future extractors. Kinds not named in the table
above are not claimed as fixture-backed TypeScript behavior by this page.

The shared TypeScript-family walker also has implementation paths for
`interface`, `enum`, `enum_member`, `type_alias`, and top-level `variable`
nodes in
[`src/graph/extraction/languages/typescript.ts`](../src/graph/extraction/languages/typescript.ts).
They are **partial** evidence here because the current `sample.ts` fixture does
not assert those shapes directly. The Express fixture separately proves the
framework-specific `route` node and resolved `references` relationship below.

## Express route resolution

Express is the only framework resolver included in this preview. It activates
when `express` appears in `dependencies` or `devDependencies`, recognizes a
literal route registered through `app` or `router`, emits a `route` node, and
links an identifier handler when it can resolve that handler confidently.

```ts
import express from "express";

const app = express();
export function healthHandler(): void {}
app.get("/health", healthHandler);
```

[`express-app.ts`](../src/graph/__tests__/fixtures/express-app.ts) and
[`resolver-express.test.ts`](../src/graph/__tests__/resolver-express.test.ts)
prove detection, the `GET /health` route node, the `healthHandler` reference,
and same-file handler binding. The end-to-end persistence path is covered by
the “activates the Express resolver and links a route to its handler” case in
[`engine.test.ts`](../src/graph/__tests__/engine.test.ts).

This resolver does not promise general framework or dynamic-dispatch analysis.
Computed route strings, inline callbacks, handler arrays, middleware chains,
and registrations hidden behind arbitrary helper functions are outside the
fixture-backed shape. NestJS and Next.js resolvers are not included.

## Graceful degradation

The preview requires Node.js 22.5 or newer because it uses the built-in
`node:sqlite` module. There is no alternate database fallback.

When the graph database or SQLite capability is unavailable:

- setup warns and continues without the code graph (see
  [`src/setup/index.ts`](../src/setup/index.ts));
- ordinary filesystem and lexical drift checks continue while grounding checks
  are skipped with a warning (see
  [`src/drift/index.ts`](../src/drift/index.ts)); and
- graph query/scope commands return a machine-readable `GRAPH_UNAVAILABLE`
  error instead of inventing results.

These paths are covered by the “scope degrades” and “graph loading fails” cases
in [`graph-cli-agent.test.ts`](../test/graph-cli-agent.test.ts) and the “keeps
legacy checks running” case in
[`graph-integration.test.ts`](../test/graph-integration.test.ts).

Unsupported source-language files are also skipped. A missing extractor does
not make the rest of setup or drift checking fail.

## Known preview limitations

- **Ambiguous references stay unresolved.** The base resolver prefers a
  same-file definition, an unambiguous imported definition, a sole candidate,
  or a unique exported candidate. Otherwise it emits no edge rather than
  guessing; see
  [`src/graph/resolution/resolver.ts`](../src/graph/resolution/resolver.ts).
- **Dynamic dispatch is not general-purpose.** Tree-sitter extraction and the
  narrow Express resolver cover statically recognizable shapes, not runtime
  reflection, dependency injection, monkey-patching, or computed calls.
- **Generated code is path-filtered, not identified semantically.** Common
  output trees such as `node_modules`, `dist`, `build`, `.next`, `out`,
  `coverage`, and `.mex` are excluded by the source globs in
  [`engine-impl.ts`](../src/graph/engine-impl.ts) and
  [`runtime.ts`](../src/graph/runtime.ts). Generated files outside those paths
  may still be indexed.
- **Framework behavior is opt-in and narrow.** Express route-to-handler binding
  is the only framework fixture in this branch. Other frameworks remain
  unsupported until their language extractor and resolver work merges.
- **Preview behavior may evolve.** This page describes the tested
  `code-graph-preview` branch and does not promise a release date or support for
  unmerged Python, Go, Rust, NestJS, or Next.js work.

For contributor interfaces, fixture requirements, and registration points, see
[Extending the code graph](extractors.md).
