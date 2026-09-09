# Code graph support

This page documents the fixture-backed code-graph support shipped in mex v0.7.0.

This page distinguishes three evidence levels:

- **Supported** — implemented and exercised by a focused fixture and test.
- **Partial** — wired into the release, but not independently fixture-tested for
  every listed extension or syntax family.
- **Unsupported** — no grammar and extractor are registered in this release.

## Language and file support

The extension and grammar mappings live in
[`src/graph/extraction/grammars.ts`](../src/graph/extraction/grammars.ts), and the
extractor registry lives in
[`src/graph/extraction/languages/index.ts`](../src/graph/extraction/languages/index.ts).

| Status | Language | Extensions | Current evidence |
|---|---|---|---|
| **Supported** | TypeScript | `.ts` | [`sample.ts`](../src/graph/__tests__/fixtures/sample.ts), [`typescript-edge-cases.ts`](../src/graph/__tests__/fixtures/typescript-edge-cases.ts), and their focused tests exercise declarations, calls, imports, visibility, async functions, and type shapes. |
| **Partial** | TypeScript modules | `.mts`, `.cts` | Both extensions map to the TypeScript grammar and extractor, but the current `sample.ts` fixture does not exercise them separately. |
| **Supported** | TSX | `.tsx` | [`tsx-component.tsx.fixture`](../src/graph/__tests__/fixtures/tsx-component.tsx.fixture) and [`extraction-regression.test.ts`](../src/graph/__tests__/extraction-regression.test.ts) cover components, interfaces, imports, and calls. |
| **Supported** | JavaScript | `.js` | [`javascript-edge-cases.js.fixture`](../src/graph/__tests__/fixtures/javascript-edge-cases.js.fixture) and [`extraction-regression.test.ts`](../src/graph/__tests__/extraction-regression.test.ts) cover classes, static methods, construction, calls, and resilient parsing. |
| **Partial** | JavaScript modules | `.mjs`, `.cjs` | Both extensions map to the JavaScript grammar and extractor, but they are not exercised by dedicated fixtures. |
| **Supported** | JSX | `.jsx` | [`jsx-component.jsx`](../src/graph/__tests__/fixtures/jsx-component.jsx) and [`extraction-regression.test.ts`](../src/graph/__tests__/extraction-regression.test.ts) cover components, imports, calls, and construction. |
| **Supported** | Python | `.py` | [`sample.py`](../src/graph/__tests__/fixtures/sample.py), [`extractor-python.test.ts`](../src/graph/__tests__/extractor-python.test.ts), and the [`python-package`](../src/graph/__tests__/fixtures/python-package) integration fixture cover extraction and cross-file package resolution. |
| **Supported** | Rust | `.rs` | [`sample.rs`](../src/graph/__tests__/fixtures/sample.rs) and [`extractor-rust.test.ts`](../src/graph/__tests__/extractor-rust.test.ts) cover structs, traits, enums, modules, functions, methods, generics, imports, calls, implementations, construction, returns, and field types. |
| **Supported** | Go | `.go` | [`sample.go`](../src/graph/__tests__/fixtures/sample.go) and [`extractor-go.test.ts`](../src/graph/__tests__/extractor-go.test.ts) cover structs, interfaces, type aliases, functions, methods, generics, imports, calls, and struct field types. |
| **Unsupported** | Other languages | All other extensions | These names may be reserved in [`src/graph/types.ts`](../src/graph/types.ts), but no grammar or extractor is registered for them. Unsupported files are skipped rather than failing a graph build. |

`src/graph/types.ts` contains a wider future-facing language vocabulary. A name
in that type union is not a support promise; the grammar and extractor
registries above are the current sources of truth.

## Fixture-backed extraction

The core TypeScript fixture contains an import, an exported function, a class, methods,
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

The shared TypeScript-family walker and regression fixtures cover
`interface`, `enum`, `enum_member`, `type_alias`, and top-level `variable`
nodes in
[`src/graph/extraction/languages/typescript.ts`](../src/graph/extraction/languages/typescript.ts).
The Express fixture separately proves the framework-specific `route` node and
resolved `references` relationship below.

## Express route resolution

Express is the only framework resolver included in v0.7.0. It activates
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

The code graph requires Node.js 22.5 or newer because it uses the built-in
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

### Files the corpus policy will not index

The graph applies a bounded per-file size ceiling (2 MB) so one pathological
file cannot exhaust memory. A file over that ceiling is **skipped, not fatal**:
the rest of the repository is indexed normally, and the skipped files are
reported by name, size and limit in `mex graph` output and in the `skipped`
array of its `--json` result.

Corpus-*wide* ceilings still abort the run. They describe the whole build and
there is no honest partial answer to "this repository is too large to index
within the bounded policy".

### Config inputs outside the project

mex never reads a file outside the repository root, and a TypeScript config
routinely points at one: `"extends": "some-package/tsconfig"` resolves through
`node_modules`, which any hoisted pnpm/yarn layout — or a monorepo sub-package
indexed on its own — places above the indexed root.

Such an input is **declined, not fatal**. The build finishes, the affected
project's type resolution is less complete than its config asks for, and the
declined inputs are reported by dependency specifier (never by absolute path)
in `mex graph` output and in the `declinedInputs` array of its `--json` result.
The same applies to a `tsconfig` `include` or project `reference` that points
above the root.

The containment guard itself is unchanged: nothing outside the root is read,
and nothing outside the root enters the graph's provenance.

### Excluding paths from the graph

`node_modules`, `.git`, `dist`, `build`, `.mex`, `coverage`, `.next` and `out`
are always excluded. A repository can exclude more by listing globs under
`graph.ignore` in `.mex/config.json`:

```json
{
  "graph": {
    "ignore": ["vendor/**", "**/*.generated.ts"]
  }
}
```

The list is **additive**: configured globs are appended to the built-in ones
and cannot un-ignore them, so `node_modules` and `.mex` stay excluded whatever
the configuration says. Globs are repository-relative; absolute paths and
upward traversal are ignored, and the list is bounded. A missing or malformed
config simply contributes no extra globs rather than failing a build.

Changing this list changes which files the graph describes, so it changes the
build manifest and the next `mex graph status` will report the index as stale
until it is rebuilt.

## Unresolved references

Extraction records every reference it sees. The resolver then binds what it
can to a declaration and emits an edge; what it cannot bind stays recorded as
an unresolved reference. Those records are the graph being honest about its own
blind spots: a name a file referenced, that the resolver could not decide the
meaning of.

They matter for `who-calls`. A dynamically generated method has real call sites
and no literal declaration, so no node resolves and the structural answer is
"not found" — accurate, and useless as a next step. When `who-calls` cannot
resolve its target, it now looks the name up among the recorded unresolved
references and reports those call sites:

```bash
mex graph query who-calls mark_failed
```

```json
{"type":"unresolved-reference","relation":"who-calls","target":"mark_failed",
 "name":"mark_failed","referenceKind":"calls","resolution":"unresolved",
 "file":"app/models/job.rb","line":42,"col":8,"fromNode":"function:…",
 "receiver":"job"}
```

Three properties of that output are deliberate:

- **It is not a `result` record.** An unresolved reference is not a resolved
  graph fact and an agent must not be able to confuse the two, so it carries
  its own record type.
- **It is capped and charged to the same output budget** as every other
  response. Common names accumulate hundreds of unresolved references, and an
  uncapped fallback on a hot name would flood the caller. The `summary` reports
  the total that matched alongside what was returned.
- **The response is a normal one**, with `meta` and `summary`, and a `summary`
  whose `status` is `partial` and `evidenceStrength` is `weak`.

A name with no declaration *and* no recorded reference still abstains with
`TARGET_NOT_FOUND`. `where-defined` and `what-calls` are unchanged: they
either resolve the requested declaration exactly or abstain.

## Known limitations

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
  `coverage`, and `.mex` are excluded by the corpus policy in
  [`corpus-policy.ts`](../src/graph/corpus-policy.ts). Generated files outside
  those paths may still be indexed; add a `graph.ignore` glob to exclude them.
- **Framework behavior is opt-in and narrow.** Express route-to-handler binding
  is the only framework fixture in v0.7.0. Other frameworks remain unsupported
  until their language extractor and resolver work merges.
- **Support claims are fixture-bounded.** This page describes behavior exercised
  in v0.7.0. It does not promise complete semantic analysis for every construct
  in a supported language or support for unmerged Go, NestJS, or Next.js work.

For contributor interfaces, fixture requirements, and registration points, see
[Extending the code graph](extractors.md).
