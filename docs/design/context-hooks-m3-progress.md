# M3 progress (stop, settle, batch reground)

Builder log. M3 is complete.

## Done
- Step 1 (6041a5b): batch `mex wiki reground <id...> --apply`; tests in `reground-batch.test.ts`.
- Step 2: flags file, review rule (`review.ts`), `mex context confirm|status`, Stop event, settle worker (lock, again-marker, refresh log, batch reground, index rebuild), `context.stopReview`; tests in `hook/__tests__/stop.test.ts`.
- Step 3: `mex hooks install|status|remove` manage the Stop entry; CLAUDE.md block; design doc milestone 3.
- Step 4: an older base record without prose hashes learns them at the next prompt (found by the smoke run).
- Checks: typecheck, build, wiki-architecture, public-api, capabilities, src/context, src/hooks, reground tests all pass.

## Smoke run (C:\mex-test-tmp\arm\stop-repro-edit, Hono, Windows, built dist)
- Edits: 2 comment-level code edits touching `compose` and `route` (8 facts touched), one prose rewrite, 2 ids confirmed.
- Stop hook that blocks: 1.1 s warm (2.4 s when it also rebuilt the context index); the question was 1,370 characters. The prose-edited fact was not asked about.
- Stop hook that starts the worker: 1.0 s wall.
- Settle worker: graph refresh 73.3 s, batch reground of 3 ids 7.6 s, whole pass 82.2 s. 5 untouched-by-vouching facts stayed flagged (`mex context status`).
- Plan-mode reground of 5 ids: one batch 6.5 s versus 5 single calls 20.7 s (about 3.2x).

## Open decisions
- A confirmation with no `--session` goes to the newest session file; the Stop question always passes `--session`, so this only matters for hand-typed confirms.
- The prose baseline is per HEAD, not per session: prose edited in an earlier uncommitted session does not count as an edit in a later one.
