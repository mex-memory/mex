# mex 0.7.2 — Source-backed graph retrieval

mex 0.7.2 makes the code graph useful as a first-response retrieval system rather than only a compact symbol manifest. `mex graph scope` now returns the most relevant source declarations and real execution flows under a hard token budget, so an agent can often answer from one graph call instead of repeatedly expanding node IDs or reopening files.

## What changed

- **Source-backed Scope by default.** Task queries return bounded `meta`, `source`, `flow`, and `summary` JSONL records. Primary declarations and trustworthy flows are admitted before optional context.
- **Compiler-backed TypeScript graph.** The TypeScript compiler API adds resolved calls, imports, inheritance, containment, callback flow, and declaration-aware source regions. TypeScript 5.9.3 is therefore an exact runtime dependency.
- **Evidence-aware retrieval.** Lexical search, source chunks, graph neighborhoods, compiler callsites, and declaration identity are fused without inventing edges. Displayed flows use stored edges with confidence at least 0.8 and remain bounded by hop, branch, work, and output-step limits.
- **Honest status and budgets.** `ok`, `partial`, `degraded`, and `no-match` reflect whether mandatory answer evidence was returned. `truncated: true` may now mean only lower-priority optional evidence was omitted.
- **Safer graph publication.** Parser/read failures preserve the previous graph, rebuilds are deterministic, and integrity checks cover extraction loss, duplicate or dangling rows, FTS drift, identity drift, invalid confidence, and suspicious production-to-test edges.
- **Stronger evaluation.** Native Hono, TypeScript-compiler, MEX, and mixed-language holdouts validate files, exact source spans, flows, budgets, construction integrity, and deterministic rebuilds. Headless comparisons pin subject and command identity, constrain tools, support safe resume after provider limits, and blind-grade exact source declarations.
- **Drift-check improvements.** This release also includes frontmatter completeness, stale-pattern checks, and safer tool-config synchronization from the latest `main` branch.

## Agent workflow

For an unfamiliar task, start with:

```bash
mex graph scope "trace the authentication flow"
```

Treat returned source as already read. If the summary is `ok`, answer from the returned evidence even when optional context was truncated. Use `mex graph get <node-id>` for an exact missing declaration, or follow `suggestedNextCommands` when the summary is `partial` or `degraded`. Fall back to Grep/Glob when the graph evidence does not clearly answer the task.

Exact structural commands remain available:

```bash
mex graph query where-defined authenticate
mex graph query who-calls requireSession
mex graph query what-calls createServer
mex impact requireSession
```

## Benchmark snapshot

A descriptive pilot ran 12 tasks across Hono and MEX once with a files-only search arm and once with the 0.7.2 candidate: 24 valid Claude Sonnet sessions in total.

| Metric | Files baseline | 0.7.2 candidate | Change |
|---|---:|---:|---:|
| Blind-correct answers | 6/12 | 7/12 | +1 answer |
| New tokens | 393,637 | 179,179 | **-54.5%** |
| Processed tokens | 3,348,865 | 920,544 | **-72.5%** |
| Estimated cost | $3.6973 | $1.6061 | **-56.6%** |
| Mean latency | 45.62 s | 35.17 s | **-22.9%** |

Candidate first responses returned 22/23 required source spans, every required Hono flow, and graph evidence for all 12 tasks.

This is a small, one-repetition pilot. It compares the candidate with files-only search, not with the released `main` graph implementation, and individual task results—especially Hono schema retries—were noisy.

## Upgrade and compatibility

mex 0.7.2 requires Node.js 22.5 or newer, unchanged from 0.7.1.

```bash
npm install -g mex-agent@0.7.2
```

Existing Markdown scaffolds remain valid. The graph schema has changed, so rebuild an existing graph once after upgrading:

```bash
mex graph
```

Existing projects do not automatically receive updated agent instructions. Copy the new `## Code Graph` section from `templates/AGENTS.md` if you want source-backed one-call guidance in an already-created scaffold.

## Known tradeoff

The compiler-backed graph stores substantially more nodes, edges, source chunks, import bindings, and integrity metadata than 0.7.1, so `.mex/graph.db` is larger. Build memory is not higher than the released baseline in paired Hono/TypeScript measurements, but storage and no-op/incremental rebuild performance remain follow-up work.
