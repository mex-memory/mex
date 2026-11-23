# Code graph support

In MEX 0.9, the Rust graph engine builds graphs for TypeScript, JavaScript,
Python, Rust and C# by default. It writes schema v5 when it can index the
whole supported corpus. An existing v4 graph moves to v5 on the next
`mex graph refresh` when the Rust engine covers its indexable files.

## Engines and settings

The native engine ships in five platform packages.

- macOS: `mex-agent-graph-darwin-arm64` and `mex-agent-graph-darwin-x64`
- Linux: `mex-agent-graph-linux-arm64` and `mex-agent-graph-linux-x64`
- Windows: `mex-agent-graph-win32-x64`

When the native executable is missing or cannot start, MEX tries the WASI
engine bundled in `mex-agent`. WASI builds and refreshes graphs. Native
schema v5 checkouts can also apply edits through a resident engine. WASI
checkouts queue a one-shot refresh after edits settle.

Node's tree-sitter extractors are the last fallback and write a v4 graph.
`mex graph status` reports the recorded runtime as `Graph engine: native (Rust)`,
`Graph engine: WASI (Rust)` or `Graph engine: Node tree-sitter`. It reports
`degraded` when the published sources match and some parses are incomplete.
Status and Hub Health explain why MEX used WASI or fell back to Node.

- `MEX_GRAPH_ENGINE` selects an executable or a `.wasm` file by path.
- `MEX_GRAPH_ENGINE_LANGUAGES` selects a comma-separated list of Rust engine
  language families. Use `typescript`, `javascript`, `python`, `rust` and
  `csharp`. TypeScript includes TSX. JavaScript includes JSX. An empty value
  selects the Node extractors for all languages.
- `MEX_GRAPH_STORAGE=v4` selects the v4 writer. The Rust engine can still
  stage rows for selected languages. MEX also uses v4 when the current
  engine selection covers only part of the corpus.

MEX sizes the memory cap to the machine. If a parallel Rust build or refresh
reaches its cap, MEX retries once with one extraction thread. WASI already
uses one thread. If the job still cannot complete, the operation fails and
keeps any existing graph. `mex graph status` and Hub Health report
`GRAPH_ENGINE_MEMORY_LIMIT` and name the cap. The resident engine shares the
warm registry's separate cap. See the [engine contract](design/graph-engine-contract.md#memory-limits)
for the limits.

## Language and file support

The [Rust adapter registry](../native/engine/langs/registry.toml) lists the
shipped adapters. MEX discovers files using its
[extension map](../src/graph/extraction/grammars.ts).

| Status | Language | Extensions | Current evidence |
|---|---|---|---|
| **Supported** | TypeScript | `.ts` | [Declaration tests](../native/engine/langs/ecmascript/tests/declarations.rs) cover classes, functions, overloads, ownership and signatures. [Reference tests](../native/engine/langs/ecmascript/tests/references.rs) cover imports, calls and class members. |
| **Supported** | TypeScript modules | `.mts`, `.cts` | [Declaration tests](../native/engine/langs/ecmascript/tests/declarations.rs) cover both extensions, namespace exports and `export =`. [Reference tests](../native/engine/langs/ecmascript/tests/references.rs) cover `.mts` import conditions. |
| **Supported** | TSX | `.tsx` | [Reference tests](../native/engine/langs/ecmascript/tests/references.rs) verify JSX syntax and the enclosing definition for a call. The [v5 build test](../native/engine/engine/tests/job.rs) verifies a TSX import through a configured alias and a callback edge. |
| **Supported** | JavaScript | `.js` | [Reference tests](../native/engine/langs/ecmascript/tests/references.rs) cover class fields, calls and types inferred from JSDoc. |
| **Supported** | JavaScript modules | `.mjs`, `.cjs` | The [staging tests](../src/graph/__tests__/engine-ecmascript-native.test.ts) exercise a `.mjs` import. [Reference tests](../native/engine/langs/ecmascript/tests/references.rs) cover `.cjs` exports and `require` resolution. |
| **Supported** | JSX | `.jsx` | [Declaration tests](../native/engine/langs/ecmascript/tests/declarations.rs) cover JSX callback declarations. The [v5 build test](../native/engine/engine/tests/job.rs) follows a CommonJS import to its call site in JSX. |
| **Supported** | Python | `.py` | [Staging tests](../native/engine/engine/tests/stage.rs) cover declarations and their ranges. [Resolver tests](../native/engine/langs/python/tests/resolve.rs) cover imports, inheritance and calls with receiver evidence. |
| **Supported** | Rust | `.rs` | [Resolver tests](../native/engine/langs/rust/tests/resolve.rs) cover associated calls, module roots and named re-exports. |
| **Partial** | C# | `.cs` | The [v5 language test](../src/graph/__tests__/languages-storage.test.ts) covers publication and overlays for a class with methods. The [Rust resolver](../native/engine/langs/csharp/src/resolve.rs) uses lexical declarations, namespaces and `using` directives. Calls through `base` or unproven receivers can remain unresolved. |
| **Unsupported** | Go, Ruby and other languages | Other extensions | MEX skips files outside the registered extensions. |

The engine also supports contributor-defined basic adapters. They provide
an outline of functions, classes and imports, with simple call hints.
The engine labels this coverage `basic`. MEX 0.9 ships zero basic adapters.
See [Add a graph language adapter](design/graph-engine-adding-a-language.md).

## Framework routes

The [engine framework test](../native/engine/engine/tests/frameworks.rs) checks
route nodes and handler edges in v4 staging and v5 builds.

| Framework | Fixture-backed route behavior |
|---|---|
| Express | Literal routes on `app` or `router` when a package declares Express. A named handler can bind to a local declaration or an import. |
| Next.js App Router | HTTP exports in `app/**/route.ts`, including `src/app`, dynamic segments and route groups. |
| FastAPI | Literal decorators with a static `APIRouter` prefix. |
| Flask | Literal route decorators with a static Blueprint prefix and HTTP method list. |
| NestJS | Literal controller paths and HTTP method decorators on their owning classes. |

These resolvers use static source evidence. See the
[framework implementations](../native/engine/engine/src/frameworks) for the full
set of recognized patterns.

## Graceful degradation

The code graph uses Node's built-in `node:sqlite`. When the index is missing
or SQLite is unavailable, graph query and scope commands report
`GRAPH_UNAVAILABLE`. Filesystem and lexical drift checks can still run.
See the [CLI tests](../test/graph-cli-agent.test.ts) and
[drift integration tests](../test/graph-integration.test.ts).

### Files the corpus policy skips

The graph skips source files over 4 MiB and reports each skipped file in
the build result's `skipped` array. Corpus-wide limits abort the run.
See the [corpus policy](../src/graph/corpus-policy.ts) for the limits.

### Config inputs outside the project

The Rust resolver only loads configuration inside the indexed root. An
`extends` or project reference that would leave the root cannot contribute
to resolution. This can affect a package config found through a hoisted
`node_modules`.
[TypeScript configuration resolution](../native/engine/langs/ecmascript/src/modules/config.rs)

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

Configured globs add to the built-in exclusions. Use repository-relative
patterns. MEX ignores absolute paths and upward traversal.

Changing the exclusions changes the build manifest. `mex graph status` reports
the index as stale until the next successful maintenance run.

## Unresolved references

When the resolver can bind a reference to a declaration, it emits an edge.
Ambiguous references can remain unresolved. A `who-calls` query for a name
with no indexed declaration can return recorded call sites as
`unresolved-reference` records. These records use the same output budget as
other results. The summary reports `status: "partial"` and
`evidenceStrength: "weak"`. If the name has neither a declaration nor a
recorded call site, the command reports `TARGET_NOT_FOUND`.
[Query implementation](../src/graph/cli-agent.ts)

## Known limitations

- **Dynamic dispatch.** The graph resolves statically recognizable calls.
  Runtime reflection, computed names and dependency injection can leave calls
  unresolved.
- **Generated code.** The corpus policy filters common output paths. Add a
  `graph.ignore` glob for generated files outside those paths.
- **Frameworks.** Handler edges describe the routes the parser can recognize
  from source. Dynamic registrations may be missing.

See [Extending the Node tree-sitter fallback](extractors.md) for the legacy
extractor interfaces.
