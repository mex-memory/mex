---
name: code-graph-retrieval
description: Diagnose and change lexical graph retrieval without masking recall or token-budget regressions.
triggers:
  - "graph retrieval"
  - "scope ranking"
  - "search recall"
  - "graph vocab"
edges:
  - target: context/architecture.md
    condition: when changing the extraction-to-retrieval flow or agent protocol
  - target: context/conventions.md
    condition: before implementing or verifying graph changes
grounds_to: []
last_updated: "2026-08-05"
---

# Code-Graph Retrieval

## Context

Retrieval has three distinct layers: [GraphStore search](mex://class:3e0f320d79f8d4831e46e9904f057e47), [`selectScope()`](mex://function:df9fb58639b0ee448ab06e6c90fcc91e), and budgeted JSONL emission. A change can improve one layer while losing the answer in another, so measure all three.

## Steps

1. Audit fixtures against symbols that actually exist, then capture the baseline before editing.
2. Add a regression at the failing layer: store ordering, scope selection, or protocol budgeting.
3. Preserve exact/component symbol-name evidence as the admission rule. Signature, docstring, and path terms may corroborate an admitted candidate but must not create one.
4. Down-weight frequent generic words and reward multi-term coverage; keep candidate generation wider than emitted output.
5. Keep minimal facts small. Source, fingerprints, and diagnostic reasons stay opt-in.
6. For true synonym gaps, emit `VOCABULARY_MISMATCH`; allow one `graph vocab` rewrite with 1-12 exact project terms, then fall back to Grep/Glob.
7. Add a persistent split-token FTS column only after a query-time component-search benchmark demonstrates the need and the schema change has been discussed.

## Gotchas

- SQLite FTS5 default tokenization does not split camelCase, so suffix nouns such as `Ledger` in `BudgetLedger` need an explicit component channel.
- A signature mention must not outrank a symbol-name match (`ledger` previously selected `planSource`).
- Generic exact words such as `graph`, `node`, and `source` can exhaust the direct quota unless frequency is damped.
- Ranking gains do not improve recall when verbose facts hit the token ceiling first.
- The scripted end-to-end driver validates deterministic retrieval and cost, not real-model fallback behavior.

## Verify

- `npm run typecheck`
- `npm test`
- `npm run build`
- `npm run eval`
- `npm run eval:e2e`
- Black-box check: `mex graph query where-defined ledger` returns `BudgetLedger` first.

## Debug

Inspect standard-detail scope reasons, determine whether the answer was absent from the store pool, lost during ranking/quota selection, or dropped by the output ledger, and add the regression at that exact boundary.

## Update Scaffold

- [ ] Update `.mex/ROUTER.md` project state when retrieval capabilities change
- [ ] Update `.mex/context/architecture.md` if data flow or protocol boundaries change
- [ ] Add new retrieval gotchas here after a verified failure
