---
name: code-graph-integration
description: Safely change the graph-to-grounding integration without weakening legacy drift checks.
triggers:
  - "code graph"
  - "grounding"
  - "reconciler"
edges:
  - target: context/architecture.md
    condition: when changing the graph/check/sync flow
last_updated: 2026-07-12
---

# Code Graph Integration

## Context

Read the frozen contracts in `src/graph/` and keep the eleven legacy drift checkers graph-independent.

## Steps

1. Build or sync nodes and resolve edges before refreshing fingerprints.
2. Construct grounding through `createGroundingChecker(graph, reconciler)` using `MinHashReconciler` for structural reads.
3. Keep check read-mostly; persist MOVED and refreshed snapshots in sync.
4. Treat absent or failed graph loading as an additive-checker skip.

## Gotchas

- Fingerprint neighbors are only final after cross-file resolution.
- A MOVED result is incomplete until markdown and `_mex_grounded_source` both reflect the new id.
- Never widen frozen interfaces to expose concrete reconciler helpers.

## Verify

- Run typecheck, build, and the full test suite.
- Assert fingerprints exist for body-bearing nodes.
- Exercise body drift → re-ground → clean → rename → durable MOVED.
- Inject a graph-load failure and confirm the legacy report completes.

## Debug

Inspect `.mex/graph.db` file metadata, fingerprint/LSH rows, and grounding baselines in that order.

## Update Scaffold

- [ ] Update `ROUTER.md` current state when phase status changes.
- [ ] Update `context/architecture.md` when graph/check/sync ownership changes.
