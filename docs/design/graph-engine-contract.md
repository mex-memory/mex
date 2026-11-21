# Graph engine contract (version 1)

How Node runs `mex-graph`, the Rust graph engine (OSS-73). Node keeps discovery, the maintenance envelope (lease, candidate, validate, publish by pointer), jobs, the CLI and every reader. The engine parses, extracts, resolves and writes graph rows. Graph rows never cross into Node.

The version is `CONTRACT_VERSION` in `native/engine/core/src/lib.rs`. Any change a caller could observe bumps it, and Node refuses an engine whose version differs.

## Modes

| Command | Does | Lifetime |
|---|---|---|
| `mex-graph version` | Prints `{"engine":"mex-graph","version":"…","contract":1}` | exits |
| `mex-graph languages` | Prints the language registry: id, level, extensions, grammar version, adapter version | exits |
| `mex-graph build --request <file>` | Builds a candidate graph from scratch | one job |
| `mex-graph refresh --request <file>` | Builds a candidate from a base graph plus changed files | one job |
| `mex-graph serve --request <file>` | Keeps one checkout warm and takes edits on stdin | until stdin closes or the parent exits |
| `mex-graph facts <file>` | Prints one file's facts as JSON, for people and tests | exits |

## Starting a job

1. Node writes the request (below) to a file in the candidate's folder and spawns the engine in its own process group, with an allowlisted environment.
2. The engine reads and validates the request, starts its guard (memory cap, deadline, parent watch), then waits for `start\n` on stdin. Nothing touches the repository before the guard runs.
3. Node writes `start\n`. The engine works and writes events on stdout, one JSON object per line. Logs go to stderr.

## Request

```json
{
  "contract": 1,
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

- `files` is Node's discovery: the same git-aware list as the file index, with sizes. The engine reads only these files and these configs, and only under `root`.
- `languages` names the languages this engine run handles. During migration Node keeps every other language on today's path.
- `output` is the only graph file the engine creates. Temporary files sit beside it and carry the engine's pid.
- `base` and `changed` are set for `refresh`: the published base graph (opened read-only) and the repository-relative paths that changed.

## Events

```json
{"type":"progress","phase":"extract","done":120,"total":454}
{"type":"file","path":"src/bad.py","status":"failed","reason":"parse_timeout"}
{"type":"result","files":454,"nodes":15516,"edges":34653,"unresolvedByReason":{"untyped_receiver":812},"usage":{"wallMs":1500,"cpuMs":9100,"peakRssMb":310}}
```

- `file` events report per-file gaps (failed parse, timeout, adapter panic, over a bound). A gap is coverage for that file, never a failed build.
- The last line of a successful job is `result`. Node validates the candidate, publishes it and logs `usage` in the usage log.

## Exit codes

| Code | Meaning | Node does |
|---|---|---|
| 0 | `result` written, candidate complete | validate and publish |
| 2 | Usage or request error (`graph_request_invalid`, `graph_contract_mismatch`) | report a bug; keep today's path |
| 3 | `graph_memory_limit`: over the memory cap | delete the candidate; Health says so, with the cap |
| 4 | `graph_deadline`: past the deadline | delete the candidate; report |
| 5 | `graph_parent_gone`: the parent exited | nothing; the engine cleaned up |
| 6 | `graph_write_failed`: SQLite or disk error | delete the candidate; report |
| 70 | Internal error | rerun once with `--isolate` to find a bad file |
| killed by a signal | Native crash | rerun once with `--isolate` |

On every non-zero exit the engine deletes its candidate and temporary files first. Node deletes them too if the engine was killed.

## Serve mode

stdin takes `{"type":"edit","paths":["src/app.py"]}` and `{"type":"close"}`. stdout answers each edit with `{"type":"edit","status":"published"|"unchanged"|"cold","reason":…,"ms":12.5}`. A published edit has written a new overlay and pointer through the same storage rules as a refresh. A cold edit tells Node to queue a normal refresh. The guard runs for the life of the process.
