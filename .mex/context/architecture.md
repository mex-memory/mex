---
name: architecture
description: How the major pieces of this project connect and flow. Load when working on system design, integrations, or understanding how components interact.
triggers:
  - "architecture"
  - "system design"
  - "how does X connect to Y"
  - "integration"
  - "flow"
edges:
  - target: context/stack.md
    condition: when specific technology details are needed
  - target: context/decisions.md
    condition: when understanding why the architecture is structured this way
# Broad overview: keep this empty unless a claim depends on a few specific symbols.
# Entry shape: { node: "function:<tier-1-id>", fingerprint: "mh:64:<hex>" }
grounds_to: []
last_updated: "2026-08-05"
---

# Architecture

<!-- Read broad, ground tight. Architecture usually grounds sparsely. When a
     specific symbol is worth navigating to, use this inline form:
```markdown
[`someFunction()`](mex://function:<tier-1-id>)
```
-->

## System Overview

Source files → tree-sitter language walkers → normalized graph nodes and edges → `.mex/graph.db`.
Agent query → `GraphStore.search()` → FTS plus identifier-component candidates.
Candidates → `selectScope()` → lexical scoring, bounded caller/callee expansion, and quotas.
Selected nodes → agent protocol ledger → compact JSONL facts under a hard token ceiling.
Chosen ids → `graph get` → grouped source ranges; structural follow-ups use `graph query` or `impact`.

## Key Components

- **Extraction walkers** — convert supported language syntax trees into the frozen graph node/edge vocabulary.
- **GraphStore** — owns SQLite persistence, FTS, identifier-component lookup, and deterministic result ordering.
- **Scope selector** — combines name evidence, corroborating context, frequency damping, graph neighbors, and quotas.
- **Agent protocol** — emits budgeted JSONL and keeps source/fingerprints opt-in.

## External Dependencies

- **Node SQLite** — local graph persistence and FTS5; graph reads remain synchronous and offline.
- **web-tree-sitter** — parser runtime used by language-specific extraction walkers.
- **tree-sitter-wasms** — bundled grammars copied into `dist/` during the build.

## What Does NOT Exist Here

- No embedding model, vector database, or network dependency in graph retrieval.
- No automatic semantic synonym expansion inside the CLI; the agent gets one bounded vocabulary-assisted retry.
