# Full-run verification

No paid agent calls were run. Pilot artifacts were read only and copied to `<scratch>/pilot/{hono,ts,dj}`. All created test worktrees were removed with dependency junctions unlinked first.

## Intended commits

Git staging and committing failed to create this worktree's index.lock (permission denied). Changes remain on eval/agent-arm-harness; nothing was pushed. Intended split:

1. Cumulative accounting, prices, delivery measures, reports and pilot fixtures.
2. Warm-up/independence, persistent workspaces, incremental preparation, schedules, launcher, heavy suites and fake tests.
3. Usage documentation and verification evidence.

## Recomputed pilot

All 18 rows' input, cache-write, cache-read and output totals equal the original rows. Final cumulative modelUsage agrees with the original continuation sums. Every table-repriced cost matches the last reported cost within $0.0001 (actual difference below 1e-15). The two-result TypeScript R2w row is $0.2804974, previously $0.5401423. Total actual spend is $2.003868.

Median warm prefixes are computed separately per output. R3 had no cold sessions: its exact neutral/actual total remains $0.5245082. The published $0.53 uses rounded displayed amounts; the raw total rounds to $0.52. Files and R2w neutral totals round to $0.73 and $0.61.

Uptake is a lexical/timestamp heuristic. Legacy search-hit packets count as graph packets; explicit graph kinds are supported. Off-gold counts apply only to tasks with gold knowledge. Missing gold-file visits are excluded from latency medians (files: one session; R2w: one; R3: zero). Per-injection uptake and off-gold follow-up calls are in the scratch reports/rows.

### hono

| Arm | Rows | Processed tokens | Neutral USD | Real USD | Discovery calls | Used / ignored injections | Redundant searches | Off-gold prompt injections | Median calls to gold file | Wiki shows | Graph / knowledge injections |
|---|---|---|---|---|---|---|---|---|---|---|---|
| files | 2 | 118247 | 0.0929 | 0.0929 | 7 | 0 / 0 | 0 | 0 | 2.0 | 0 | 0 / 0 |
| mex-r2w | 2 | 123175 | 0.1037 | 0.1494 | 4 | 3 / 1 | 1 | 1 | 2.0 | 0 | 2 / 2 |
| mex-r3 | 2 | 115284 | 0.1048 | 0.1048 | 4 | 2 / 0 | 0 | 0 | 2.0 | 0 | 2 / 0 |

### ts

| Arm | Rows | Processed tokens | Neutral USD | Real USD | Discovery calls | Used / ignored injections | Redundant searches | Off-gold prompt injections | Median calls to gold file | Wiki shows | Graph / knowledge injections |
|---|---|---|---|---|---|---|---|---|---|---|---|
| files | 2 | 880118 | 0.4266 | 0.4494 | 23 | 0 / 0 | 0 | 0 | 5.5 | 0 | 0 / 0 |
| mex-r2w | 2 | 725571 | 0.3627 | 0.3855 | 15 | 6 / 0 | 3 | 0 | 2.0 | 0 | 2 / 4 |
| mex-r3 | 2 | 311598 | 0.2668 | 0.2668 | 11 | 5 / 0 | 0 | 0 | 3.5 | 0 | 1 / 4 |

### dj

| Arm | Rows | Processed tokens | Neutral USD | Real USD | Discovery calls | Used / ignored injections | Redundant searches | Off-gold prompt injections | Median calls to gold file | Wiki shows | Graph / knowledge injections |
|---|---|---|---|---|---|---|---|---|---|---|---|
| files | 2 | 337105 | 0.2128 | 0.2357 | 19 | 0 / 0 | 0 | 0 | 2.5 | 0 | 0 / 0 |
| mex-r2w | 2 | 167260 | 0.1437 | 0.1665 | 7 | 2 / 1 | 1 | 0 | 3.0 | 0 | 1 / 2 |
| mex-r3 | 2 | 202462 | 0.1528 | 0.1528 | 10 | 3 / 0 | 2 | 0 | 3.0 | 0 | 1 / 2 |

## Setup profile

TypeScript, existing pilot graph and frozen CLI; agent calls excluded. Before: checkout/scaffold/setup commit 96,314 ms; index copies 317 ms; whole-source graph-status scan 23,832 ms; hooks install/status 2,603 ms: **123,066 ms**.

After, first workspace: create 122,296 ms (checkout 120,432; scaffold 1,296; commit 523), copies 295, hooks 2,621, independence 1,622: about **126.8 s**. Reused workspace: reset 2,320 ms, copies 186 ms, hash/HEAD/status checks 1,527 ms: **4,033 ms**. Initial checkout remains expensive and varies with filesystem conditions. Copies were not the bottleneck.

The pinned setup commit has the task base as an ancestor; only scaffold/hooks and configured instruction patches may differ. Independence verifies source identity, clean status, absent session state, no pending database WAL and cache byte hashes. Mutable databases are copied, never hardlinked. Subsequent graph caches use incremental refresh seeded from the previous graph. A fake CLI test covers that path; a complete real multi-base prepare was not benchmarked.

## Plan

`node evaluate/arm/parallel.mjs --plan --config evaluate/arm/full-run.example.json`

| Repo | Sessions | First files / R2w / R3 | Estimated measured USD |
|---|---:|---|---:|
| hono-hooks-arm | 30 | 4 / 3 / 3 | 1.7352 |
| ts-hooks-arm | 51 | 5 / 6 / 6 | 9.3652 |
| dj-hooks-arm | 42 | 5 / 4 / 5 | 3.8853 |

Total **123** measured sessions, combined first positions **14 / 13 / 14**. Pilot-median estimate **$14.9857**, separate warm-up allowance **$3.075**. Heavy tasks may exceed these medians. Exact schedule: `<scratch>/full-plan.json`. Plan runs no CLI and creates no output.

## Heavy graders

The reusable verifier used writable scratch dependencies and an explicit Python override. The requested Python 3.13 launcher failed because its base executable is inaccessible in this sandbox. The substitute is Python 3.14 with existing pure-Python dependencies copied into a scratch venv; this is not native 3.13 verification.

| Task | Grader | Base | Upstream fix |
|---|---|---|---|
| hono-heavy-jsx-attr-names | three upstream test files | 1043 pass, 20 fail | 1063 pass, 0 fail |
| hono-heavy-validator-body-trace | five answer points | 9 gold source spans verified | question |
| ts-heavy-watch-edit-trace | five answer points | 16 gold source spans verified | question |
| dj-heavy-bool-literal-sqlite | upstream lookup tests | 135 pass, 2 errors, 2 skip | 137 pass, 0 fail, 2 skip |
| dj-heavy-admin-delete-trace | five answer points | 12 gold source spans verified | question |

Logs and exact interpreter: `<scratch>/verification/verification.json` and adjacent text files. The excluded TypeScript heavy change was not added.

## Expected Stop review

MEX fact groundings identify **two** expected tasks:

- `compose-refactor`: the expected edit to `compose` intersects four grounded facts in src/compose.ts. There is no upstream fix for this refactor; compare its explicit gold edit with fact groundings.
- `ts-change-flow-container-crash`: upstream hunks overlap `getContainerFlags` (Container flags decide scopes) and `bindContainer` (Each function body starts a new flow graph, except IIFEs and static blocks), in src/compiler/binder.ts.

Other upstream fixes do not intersect grounded fact symbols. Neither heavy change has a matching grounding. Cached grounded symbol spans were compared with changed source hunks/symbol context, rather than path overlap alone. Evidence: `<scratch>/stop-review.json`. Triggering depends on the agent editing the expected code and the hooks installed for the run.

## Checks and limitations

**36/36 arm tests pass.** Tests cover all pilot prices/tokens, exact neutral totals, selected/combined schedule balance, fake warm-up state cleanup, cold validity, injection measures, reset/cache corruption, incremental preparation, complete fake prepare/run lifecycle and process-path containment. Focused comparison schedule tests: 3/3. Broader comparison tests: 36 pass, 11 fail because the existing guard expects /bin/sh on Windows.

Real paid warm-up behavior was intentionally not tested. Native Python 3.13 execution and Windows CIM process inspection are denied in this sandbox; the matcher is tested against own-workspace and sibling paths. Use an environment with those permissions for the full run. Product source, frozen CLIs, pilot outputs and protected repositories were not modified.
