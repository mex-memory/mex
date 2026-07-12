# mex 0.7.0 — Code-aware project memory

mex 0.7.0 adds a deterministic code knowledge graph beneath the existing markdown scaffold. Memory can now ground itself to exact code nodes instead of relying only on file paths, so mex can tell an agent precisely which symbol changed and which surrounding code or scaffold memory is affected.

The graph is local, zero-AI infrastructure: tree-sitter extraction writes SQLite in `.mex/graph.db`, body hashes detect edits, and MinHash fingerprints reconcile confident renames and moves.

## What ships

- TypeScript, TSX, JavaScript, and JSX extraction.
- Cross-file calls, imports, inheritance, containment, and reference edges.
- An Express reference resolver linking route registrations to handler nodes.
- Grounding checker #12 for changed, moved, ambiguous, or removed code nodes.
- Durable re-grounding during `mex sync` after a confident move or completed repair.
- A contributor-facing extractor test pattern in the source repository.

## New commands

```bash
mex graph
mex graph --json
mex graph query where-defined <symbol>
mex graph query who-calls <symbol>
mex graph query what-calls <symbol>
mex impact <symbol-or-file>
```

`mex graph query` and `mex impact` emit compact JSONL intended for coding agents to call during a task.

## Grounded scaffold memory

Agents may add optional grounding frontmatter:

```yaml
grounds_to:
  - node: "function:a3f8...c21"
    fingerprint: "mh:64:9f2a..."
```

An unchanged node is clean. A body edit produces a grounding warning with old/new source for sync. A high-confidence rename is rebound automatically during sync; an uncertain candidate is surfaced for agent adjudication; a deleted node is an error.

## Installation and upgrades

0.7.0 requires Node.js 22.5 or newer because the graph uses Node's built-in SQLite module.

Fresh `mex setup` runs build the graph automatically. Existing users do not need a scaffold migration: without a graph, the original eleven filesystem and lexical checkers keep working and mex shows a one-time suggestion to run:

```bash
mex graph
```

Scaffolds without `grounds_to` behave exactly as before.

## Graceful degradation

The graph is additive. If no graph exists, a grammar is unavailable, or SQLite cannot load on a platform, mex skips graph grounding and continues running the rest of `mex check`. Unsupported-language files are skipped rather than crashing graph construction.

## What comes next

The 0.7.x series is intended to broaden language and framework coverage through bounded extractor and resolver contributions. 0.7.0 deliberately ships a thin complete base—TS/JS plus Express—before that contributor program begins.
