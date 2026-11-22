# Graph engine contract (version 2)

How Node runs `mex-graph`, the Rust graph engine (OSS-73). Node keeps discovery, the maintenance envelope (lease, candidate, validate, publish by pointer), jobs, the CLI and every reader. The engine parses, extracts and resolves graph rows. In `build` it writes a schema v5 candidate. In `stage` it streams Python, TypeScript and JavaScript rows for Node to write into its schema v4 store.

`CONTRACT_VERSION` in `native/engine/core/src/lib.rs` and Node's `GRAPH_ENGINE_CONTRACT` in `src/graph/native-engine.ts` must both be 2. A caller-visible change bumps both, and Node refuses an engine whose version differs.

## Modes

| Command | Does | Lifetime |
|---|---|---|
| `mex-graph version` | Prints `{"engine":"mex-graph","version":"…","contract":3}` | exits |
| `mex-graph languages` | Prints the language registry: id, level, extensions, grammar version, adapter version | exits |
| `mex-graph build --request <file>` | Builds a candidate graph from scratch | one job |
| `mex-graph stage --request <file>` | Streams extracted and resolved rows for Node's schema v4 writer | one job |
| `mex-graph refresh --request <file>` | Builds a candidate from a base graph plus changed files | one job |
| `mex-graph serve --request <file>` | Keeps one checkout warm and takes edits on stdin | until stdin closes or the parent exits |
| `mex-graph facts <file>` | Prints one file's facts as JSON, for people and tests | exits |

## Starting a job

1. Node writes the request to a job file and spawns the engine in its own process group, with an allowlisted environment. For a database job the request sits in the candidate's folder.
2. The engine reads and validates the request, starts its guard (memory cap, deadline, parent watch), then waits for `start\n` on stdin. Source reads begin after the start barrier.
3. Node writes `start\n`. The engine works and writes events on stdout, one JSON object per line. Logs go to stderr.

## Request

```json
{
  "contract": 3,
  "mode": "build",
  "root": "/abs/path/to/checkout",
  "files": [{ "path": "src/app.py", "size": 1234 }],
  "configs": ["tsconfig.json", "pyproject.toml"],
  "languages": ["python"],
  "output": "/abs/index/graph-tmp-<pid>-<token>.db",
  "base": null,
  "changed": [],
  "factsCache": "/abs/mex-home/facts",
  "limits": { "memoryMb": 1024, "deadlineMs": 1800000, "threads": 8 }
}
```

- `files` gives the git-aware paths Node discovered, with sizes. `configs` accepts repository-relative paths or objects with a repository-relative `path` and captured `source` text. The engine reads named files and configs only under `root`. For ECMAScript staging, Node supplies the tsconfig, jsconfig and package.json texts from discovery so resolution uses that snapshot.
- `languages` names the languages this engine run handles. During migration Node keeps every other language on today's path.
- For `build`, `output` is the absolute path to a new candidate in an existing folder. Temporary files sit beside it. For `stage`, set `mode` to `"stage"`. The engine ignores a supplied `output` path or `null` and opens no database.
- `base` and `changed` are set for `refresh`: the published base graph (opened read-only) and the repository-relative paths that changed.
- `stage` uses the same guard, start barrier and parallel extraction as `build`, and resolves across the full extracted set. The request language ids are `python` for `.py`, `typescript` for `.ts`, `.mts` and `.cts`, `tsx` for `.tsx`, `javascript` for `.js`, `.mjs` and `.cjs`, and `jsx` for `.jsx`. Node's `MEX_GRAPH_ENGINE_LANGUAGES` flag accepts `python`, `typescript` and `javascript` as comma-separated names. `typescript` also selects `tsx`, and `javascript` also selects `jsx`.

### Published schema v5 candidates

When all indexed languages are engine-owned and `MEX_GRAPH_STORAGE=v5`,
Node uses `build` for both rebuild and refresh. It supplies `sourceDirectory`
and per-file `staged` basenames, `contentHash`, `modifiedAt` and
`extractorVersion` from the same contained discovery used for schema v4.
The child verifies the captured content before extracting and indexing it.
The optional `buildMetadata` carries exact Git, manifest, corpus and coverage
provenance for publication. The engine stores it relationally and adds the
health counts from the files it wrote. A standalone engine benchmark may omit
the publication fields. Node retains the lease and validates the finished
database before advancing the pointer. A refresh builds a full base.

## Events

```json
{"type":"progress","phase":"extract","done":1000,"total":1454}
{"type":"result","files":1454,"nodes":15516,"edges":34653,"coverageGaps":2,"usage":{"wallMs":1500,"peakRssMb":310}}
{"type":"error","code":"graph_contract_mismatch","message":"the request is contract 1, this engine is 2"}
```

- `build` can report `progress` while writing the candidate and records per-file coverage gaps there. `stage` reports each file as described below.
- `result` is the last line of a successful job. `files` counts extracted files including failed parses. `nodes` and `edges` count the rows written or streamed. `coverageGaps` counts skipped files and failed parses. `usage` gives elapsed milliseconds (`wallMs`) and peak sampled resident memory in MiB (`peakRssMb`). Node owns validation, publication and usage logging.

### Stage events

`stage` emits one `staged` or `file` line per requested file in request order, followed by `result`. Each edge appears in the file event that owns its source node. Its target may appear in a later event. File lines and result counts are deterministic across extraction thread counts. Node discards the stream if the job fails. If a file is skipped or its content hash differs from discovery, Node extracts that file from the captured source and demotes engine edges whose targets are missing.

```json
{"type":"staged","path":"src/bad.py","contentHash":"3ec855ca91c31025b83d98cffb246849cb3f384768ec3d65ee834cce02789931","size":6,"language":"python","parseStatus":"failed","health":{"status":"failed","diagnosticCount":1,"missingCount":0,"errorCoverage":0.8333333,"diagnostics":[{"type":"ERROR","startLine":1,"endLine":1}]},"nodes":[],"edges":[],"unresolved":[]}
{"type":"file","path":"README.md","status":"skipped","reason":"no adapter yet"}
```

- A skipped `file` has the requested `path`, `status` of `"skipped"` and a `reason` from build coverage (`"no adapter yet"`, `"missing"`, `"outside the repository"` or `"read failed"`).
- A `staged` event has the repository-relative `path`, exact-byte SHA-256 `contentHash` (64 lowercase hex characters), byte `size` and `language` id. `parseStatus` and `health.status` are both `"ok"`, `"partial"` or `"failed"`. `health.diagnosticCount` counts error nodes and `health.missingCount` counts missing nodes. `health.errorCoverage` is the extractor's single-precision coverage fraction. `health.diagnostics` carries up to 100 locations from the facts, each with `type`, `startLine` and `endLine`. Failed parses carry health and empty `nodes`, `edges` and `unresolved` arrays.

#### Python rows

- `nodes` follow definition order with excluded definitions filtered out. Each node has `id`, `kind`, `name`, `qualifiedName`, `filePath`, `language`, `startLine`, `endLine`, `startColumn`, `endColumn`, `identityKey` and `isExported`. The text `id` and NUL-separated `identityKey` use the tree-sitter signature profile. `containerId` is present when the immediate lexical parent is also written. `signature` is present when nonempty. `docstring` and `returnType` are present when captured, and `isAsync` is present on functions and methods. `bodyHash` is the adapter's normalized-body SHA-256 in lowercase hex, present on body kinds. A sketch adds `minhash` (64 unsigned 32-bit integers) and `tokenCount`.
- `edges` contain `source` and `target` text node ids, `kind`, `line`, `provenance` of `"tree-sitter"`, `confidence` of `1` and `resolutionMethod`. Both endpoints must be written nodes, and the source belongs to the current file. `contains` edges come first in child definition order. They use the child's `startLine`, omit `column` as in `stageTreeFile` and carry `resolutionMethod` of `"lexical-containment"`. Resolver edges (`calls`, `instantiates`, `extends`, `imports`) follow in resolver order, carry a `column` and use `"engine-python"`.
- Each `unresolved` entry has `fromNodeId`, `referenceName`, `referenceKind` of `"calls"`, `filePath`, `language` of `"python"`, `line`, `column`, `status` of `"unresolved"`, `resolver` of `"engine-python"` and `metadata` with a string `reason` such as `"untyped_receiver"`. The source is the nearest enclosing written node, with the file node as the module-level source. The name, line and column describe the called name. Entries follow call order. Node's store derives `refKey`.

#### TypeScript and JavaScript rows

- Nodes use the compiler route's ordinal profile for `id` and `identityKey`. They carry `containerId`, names, file and language, spans, and `isExported`. `docstring`, `signature`, `visibility`, `isAsync`, `isStatic`, `isAbstract`, `decorators`, `typeParameters` and `returnType` are included when present. Body kinds carry `bodyHash`, `minhash` and `tokenCount`. The engine derives display text from syntax.
- `contains` uses the child's start line and column and `lexical-containment`. Resolved `calls`, `instantiates`, `imports`, `extends`, `implements` and `references` use `engine-ecmascript`. Resolved edges carry the written `metadata.targetName` and the target's `metadata.targetQualifiedName`. Structural and direct reference edges use `typescript-compiler` provenance and confidence 1, following the v4 compiler-route row convention. Callback edges use `callback-synthesis` and confidence 0.85. Their line and column describe the argument site, with `evidence[].wiringSite` giving its file and coordinates.
- Unresolved entries use the corresponding reference kind, the written name and site, `status: "unresolved"`, `confidence: 0`, `candidates: []` and `resolver: "engine-ecmascript"`. The metadata includes the reason. The Node fallback resolver leaves these references as emitted.
- When present, `imports` contains the named import bindings for the file. Bindings carry the local name, imported name, module specifier, type-only flag, binding key, site metadata and any resolved file path and target id. Node's framework resolvers can use these bindings with the staged nodes and captured source.

Lines across all stage rows and diagnostics are 1-based. Columns are 0-based UTF-16 code units. Node fills `updatedAt` on nodes and supplies the derived or operational `FileRecord` fields (`nodeCount`, `errors` from `health.diagnostics`, the diagnostic counters and coverage from `health`, `modifiedAt`, `indexedAt`, `extractorVersion`).

## Exit codes

| Code | Meaning | Node does |
|---|---|---|
| 0 | `result` written, job complete | validate output and continue publication |
| 2 | Usage or request error (`graph_request_invalid`, `graph_contract_mismatch`) | report a bug; keep today's path |
| 3 | `graph_memory_limit`: over the memory cap | delete the candidate; Health says so, with the cap |
| 4 | `graph_deadline`: past the deadline | delete the candidate; report |
| 5 | `graph_parent_gone`: the parent exited | nothing; the engine cleaned up |
| 6 | `graph_write_failed`: SQLite, disk or stage stdout error | discard job output and report |
| 70 | Internal error | rerun once with `--isolate` to find a bad file |
| killed by a signal | Native crash | rerun once with `--isolate` |

A failed database job deletes its candidate and temporary files. Node cleans them up if the engine was killed. A failed `stage` job leaves cleanup of any streamed rows to Node. The stage guard can exit before writing an `error` event if stdout is blocked.

## Serve mode

stdin takes `{"type":"edit","paths":["src/app.py"]}` and `{"type":"close"}`. stdout answers each edit with `{"type":"edit","status":"published"|"unchanged"|"cold","reason":…,"ms":12.5}`. A published edit has written a new overlay and pointer through the same storage rules as a refresh. A cold edit tells Node to queue a normal refresh. The guard runs for the life of the process.
