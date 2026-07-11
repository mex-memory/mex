---
name: codegraph-parallel-track
description: Implementing one code-graph track against Phase 0 contracts without crossing parallel ownership boundaries.
triggers:
  - "code-graph track"
  - "Phase 1 Track"
edges:
  - target: "context/architecture.md"
    condition: "when the graph integration flow has been populated"
last_updated: 2026-07-12
---

# Codegraph Parallel Track

## Context
Read the track handoff, build spec sections it names, and frozen `src/graph/` contracts before branching from the specified integration branch.

## Steps
1. Confirm the base branch and preserve unrelated worktree changes.
2. Add implementation in track-owned modules and import frozen contract types.
3. Test through hand-seeded fixtures instead of depending on the parallel track.
4. Run typecheck, build, the full test suite, and a frozen-contract diff audit.
5. Commit only owned files to the track branch.

## Gotchas
- Do not change frozen signatures, schema, unions, or config constant names.
- Read tunable values from config; enforce `BANDS * ROWS == K` at runtime.
- Keep integration and pipeline registration for the post-merge phase.
- SQLite helpers should compose with an outer transaction.

## Verify
- [ ] Every requested outcome has an isolated fixture.
- [ ] Parallel-track and pre-existing worktree files are excluded.
- [ ] Frozen contract diffs are empty except explicitly permitted stub bodies.
- [ ] Typecheck, build, and all tests pass.

## Debug
Check branch ancestry, schema/fixture parity, ESM `.js` imports, and injected contract seams before changing shared files.

## Update Scaffold
- [ ] Update `ROUTER.md` only after the track is merged and project state actually changes.
- [ ] Update context files if merged architecture or conventions changed.
- [ ] Add newly discovered parallel-track gotchas here.
