# M3 progress (stop, settle, batch reground)

Builder log. Updated with every step.

## Done
- Step 1 (6041a5b): batch `mex wiki reground <id...> --apply`; tests in `reground-batch.test.ts`.
- Step 2: flags file, review rule (`review.ts`), `mex context confirm|status`, Stop event, settle worker (lock, again-marker, refresh log, batch reground, index rebuild), `context.stopReview`; tests in `hook/__tests__/stop.test.ts` (rule, CORS-style fixture, block once, off, lock/again, refresh failure, partial failure).
- Step 3: `mex hooks install|status|remove` manage the Stop entry; CLAUDE.md block; design doc milestone 3.
- Checks run: typecheck, wiki-architecture, public-api, capabilities, src/context, src/hooks: all pass.

## Next
- Step 4: build, then smoke run in C:\mex-test-tmp\arm\stop-repro-edit; record timings (stop, refresh, batch vs single reground) here.

## Open issues
- none
