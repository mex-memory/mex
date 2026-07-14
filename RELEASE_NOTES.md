# mex 0.7.0 Developer Preview — Code-aware project memory

> **Unreleased:** These are preview notes for `code-graph-preview`. npm and `main` remain on stable v0.6.3. Do not use this document as an announcement of a GitHub or npm release.

The upcoming mex 0.7.0 adds a deterministic code knowledge graph beneath the existing markdown scaffold. Memory can now ground itself to exact code nodes instead of relying only on file paths, so mex can tell an agent precisely which symbol changed and which surrounding code or scaffold memory is affected.

The graph is local, zero-AI infrastructure: tree-sitter extraction writes SQLite in `.mex/graph.db`, body hashes detect edits, and MinHash fingerprints reconcile confident renames and moves.

## What is in the preview

- TypeScript, TSX, JavaScript, and JSX extraction.
- Cross-file calls, imports, inheritance, containment, and reference edges.
- An Express reference resolver linking route registrations to handler nodes.
- Grounding checker #12 for changed, moved, ambiguous, or removed code nodes.
- Query-time task neighborhoods through `mex graph scope`, hydrated with signatures, callers, callees, source, ids, and fingerprints.
- Setup-time grounding plus an idempotent migration path for existing scaffolds.
- Durable re-grounding of frontmatter and inline anchors during `mex sync`.
- A contributor-facing extractor test pattern in the source repository.

## New commands

```bash
mex graph
mex graph --json
mex graph scope <task>
mex graph ground
mex graph query where-defined <symbol>
mex graph query who-calls <symbol>
mex graph query what-calls <symbol>
mex impact <symbol-or-file>
```

`mex graph scope`, `mex graph query`, and `mex impact` emit compact hydrated JSONL intended for coding agents to call during setup, repair, and implementation tasks.

## Grounded scaffold memory

Setup now authors grounding as it populates memory. It follows **read broad, ground tight**: read the relevant scope neighborhood, then ground only prose claims that depend on specific behavior. Broad architecture, stack, and convention files remain sparse; pattern and deep-domain files ground tightly.

Behavioral assertions use frontmatter with both a node id and fingerprint:

```yaml
grounds_to:
  - node: "function:a3f8...c21"
    fingerprint: "mh:64:9f2a..."
```

Load-bearing symbol mentions use readable inline navigation anchors containing only the node id:

```markdown
[`calculateCheckoutTotal()`](mex://function:a3f8...c21)
```

An unchanged node is clean. A body edit produces a grounding warning with old/new source for sync. Sync repairs the prose when needed, refreshes the frontmatter fingerprint, and updates or removes stale anchors. A high-confidence rename is rebound automatically; an uncertain candidate is surfaced for agent adjudication. Broken inline navigation remains warning-only.

## Installation and upgrades

The preview is not published to npm. Test it by building the `code-graph-preview` branch from source. The upcoming 0.7.0 requires Node.js 22.5 or newer because the graph uses Node's built-in SQLite module.

Fresh `mex setup` runs build the graph before population, and the setup agent consumes it through the hydrated retrieval commands while authoring grounding.

Existing populated scaffolds remain valid, but need a one-time pointer migration to participate in graph drift detection:

```bash
mex graph
mex graph ground
```

`mex graph ground` preserves the existing prose and adds tight `grounds_to` entries plus load-bearing `mex://` anchors. It is safe to rerun. Scaffolds that have not migrated continue to behave as before under the original eleven checkers.

## Graceful degradation

The graph is additive. If no graph exists, a grammar is unavailable, or SQLite cannot load on a platform, mex skips graph grounding and continues running the rest of `mex check`. Unsupported-language files are skipped rather than crashing graph construction.

## What comes next

The 0.7.x series is intended to broaden language and framework coverage through bounded extractor and resolver contributions. The developer preview starts with a thin complete base—TS/JS plus Express—so that contributor testing can improve it before the stable 0.7.0 release.
