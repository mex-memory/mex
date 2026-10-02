---
name: decisions
description: Key architectural and technical decisions with reasoning. Load when making design choices or understanding why something is built a certain way.
triggers:
  - "why do we"
  - "why is it"
  - "decision"
  - "alternative"
  - "we chose"
edges:
  - target: context/architecture.md
    condition: when a decision relates to system structure
  - target: context/stack.md
    condition: when a decision relates to technology choice
# Decisions usually ground sparsely; add only symbols that implement the decision.
# Entry shape: { node: "function:<tier-1-id>", fingerprint: "mh2:64:<base64url>" }
grounds_to: []
last_updated: 2026-09-06
---

# Decisions

## Decision Log

When a decision changes, retain the old entry, mark it superseded, and add the
replacement above it. Dates below are the date these active decisions were
recorded in the scaffold; they do not assert the date of the original design work.

<!-- mex:entity
id: mx_01M1M0CJC2YM3HEBWE64JZG3F3
type: decision
status: promoted
revision: 1
-->
### Dogfood the ordinary setup path
**Date recorded:** 2026-09-03
**Status:** Active
**Decision:** The MEX repository runs the same `mex setup` flow as consumer repositories; there is no `--self` branch.
**Reasoning:** Self-hosting should exercise the shipped path, and the old repository guard came from the pre-package installer rather than a current recursion or storage constraint.
**Alternatives considered:** A `--self` escape hatch was rejected because it creates a second path that can drift and hides consumer-facing resume bugs.
**Consequences:** Setup must be merge-safe over an authored scaffold, reuse persisted tool selection before population completes, and have packed regression coverage for a MEX-shaped target.

<!-- mex:entity
id: mx_01M1M0CJBATK0BSTMSB0H1183D
type: decision
status: promoted
revision: 1
-->
### Keep canonical knowledge in Git-tracked files
**Date recorded:** 2026-09-03
**Status:** Active
**Decision:** Markdown/JSONL is canonical; Graph, Wiki, and checkout-local SQLite stores are disposable projections or private state.
**Reasoning:** Knowledge, review history, and drift baselines must survive rebuilds and reach another clone through ordinary Git review.
**Alternatives considered:** Database-only knowledge was rejected because ignored indexes disappear on rebuild and are not shared or reviewable.
**Consequences:** Never commit `.mex/graph.db*`, `.mex/wiki.db*`, or `.mex/local/`; maintenance may recreate them, while durable change signals stay in Markdown.

<!-- mex:entity
id: mx_01M1M0CJAJ6XASAWJ7NB1K8KVP
type: decision
status: promoted
revision: 1
-->
### Make reads immutable and writes explicit
**Date recorded:** 2026-09-03
**Status:** Active
**Decision:** Ordinary reads do not initialize, migrate, repair, refresh, or otherwise mutate repository or local state.
**Reasoning:** Hidden writes make observations non-repeatable, introduce races, and can replace the last trustworthy state without user intent.
**Alternatives considered:** Opportunistic migration/repair during reads was rejected in favor of explicit maintenance and preview/apply workflows.
**Consequences:** Reads use immutable snapshots and stable diagnostics; maintenance and canonical mutations require bounded authority, revalidation, and failure-atomic publication.

<!-- mex:entity
id: mx_01M1M0CJ9Y77MGH0R0EFPFT0QJ
type: decision
status: promoted
revision: 1
-->
### Keep internal application boundaries out of the npm API
**Date recorded:** 2026-09-03
**Status:** Active
**Decision:** Only exports from `src/index.ts` are public; Hub and Team workflow contracts remain internal until deliberately promoted.
**Reasoning:** Internal ports can evolve with their consumers without accidentally becoming a compatibility promise to external embedders.
**Alternatives considered:** Deep/public exports for every useful internal adapter were rejected because they widen semver and declaration obligations prematurely.
**Consequences:** New internal functionality should use repository-local imports and conformance tests; a package-root export requires an explicit compatibility decision and public API test update.
