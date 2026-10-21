# heavy-fixture agent-arm report

Fake data only; usage and dollar amounts are simulated. Captured from the
sample fixture's paired run and resumed output, with no model/API sessions.

Rows: 18 (18 valid, 0 invalid).

## Primary measures

Processed tokens count all input, cache and output tokens. Neutral cost reprices a cold first call using the median warm first-call prefix in this output. Warm-up usage is excluded. Injection uptake is a bounded heuristic, not proof of causation.

| Arm | Rows | Processed tokens | Neutral USD | Real USD | Discovery calls | Used / ignored injections | Redundant searches | Off-gold prompt injections | Median calls to gold file | Wiki shows | Graph / knowledge injections |
|---|---|---|---|---|---|---|---|---|---|---|---|
| files | 9 | 108342 | 0.0090 | 0.0090 | 9 | 0 / 0 | 0 | 0 | – | 0 | 0 / 0 |
| mex-r3 | 9 | 108342 | 0.0090 | 0.0090 | 9 | 0 / 0 | 0 | 0 | – | 0 | 0 / 0 |

## Discovery and gold-file latency

A missing gold-file visit stays missing; latency medians exclude it.

| Run | Discovery | Redundant | Calls to gold file | Wiki shows | Alignment |
|---|---|---|---|---|---|
| 01-deep-a-r01-files | 1 | 0 | – | 0 | timestamp-or-explicit |
| 01-deep-a-r01-mex-r3 | 1 | 0 | – | 0 | timestamp-or-explicit |
| 01-deep-a-r02-files | 1 | 0 | – | 0 | timestamp-or-explicit |
| 01-deep-a-r02-mex-r3 | 1 | 0 | – | 0 | timestamp-or-explicit |
| 01-deep-a-r03-files | 1 | 0 | – | 0 | timestamp-or-explicit |
| 01-deep-a-r03-mex-r3 | 1 | 0 | – | 0 | timestamp-or-explicit |
| 02-deep-b-r01-files | 1 | 0 | – | 0 | timestamp-or-explicit |
| 02-deep-b-r01-mex-r3 | 1 | 0 | – | 0 | timestamp-or-explicit |
| 02-deep-b-r02-files | 1 | 0 | – | 0 | timestamp-or-explicit |
| 02-deep-b-r02-mex-r3 | 1 | 0 | – | 0 | timestamp-or-explicit |
| 02-deep-b-r03-files | 1 | 0 | – | 0 | timestamp-or-explicit |
| 02-deep-b-r03-mex-r3 | 1 | 0 | – | 0 | timestamp-or-explicit |
| 03-control-r01-files | 1 | 0 | – | 0 | timestamp-or-explicit |
| 03-control-r01-mex-r3 | 1 | 0 | – | 0 | timestamp-or-explicit |
| 03-control-r02-files | 1 | 0 | – | 0 | timestamp-or-explicit |
| 03-control-r02-mex-r3 | 1 | 0 | – | 0 | timestamp-or-explicit |
| 03-control-r03-files | 1 | 0 | – | 0 | timestamp-or-explicit |
| 03-control-r03-mex-r3 | 1 | 0 | – | 0 | timestamp-or-explicit |

## Injection uptake

Each packet is one hook injection. Follow-up calls are listed for off-gold prompt packets; complete inputs remain in the row.

| Run | Kind / hook | IDs | After call | Uptake | Off gold | Following calls |
|---|---|---|---|---|---|---|
## Per task and arm

| Task | Arm | Valid | Correct | Median new tokens | Median processed | Median time (s) | Median turns | Median tool calls | Median MEX calls | Median discovery calls |
|---|---|---|---|---|---|---|---|---|---|---|
| deep-a | files | 3 | ungraded | 38 | 12038 | 0.1 | 2 | 2 | 0 | 1 |
| deep-a | mex-r3 | 3 | ungraded | 38 | 12038 | 1.1 | 2 | 2 | 0 | 1 |
| deep-b | files | 3 | ungraded | 38 | 12038 | 0.1 | 2 | 2 | 0 | 1 |
| deep-b | mex-r3 | 3 | ungraded | 38 | 12038 | 0.8 | 2 | 2 | 0 | 1 |
| control | files | 3 | ungraded | 38 | 12038 | 0.1 | 2 | 2 | 0 | 1 |
| control | mex-r3 | 3 | ungraded | 38 | 12038 | 0.7 | 2 | 2 | 0 | 1 |

## Task outcomes (all tasks)

Win/loss counts compare paired processed tokens; correctness is shown separately. Invalid or missing pairs are excluded.

| Task | Stratum | Pairs | Token wins / losses / ties | Correct files / treatment |
|---|---|---|---|---|
| deep-a | heavy | 3 | 0 / 0 / 3 | ungraded / ungraded |
| deep-b | heavy | 3 | 0 / 0 / 3 | ungraded / ungraded |
| control | light | 3 | 0 / 0 / 3 | ungraded / ungraded |

## Paired geometric ratios

Treatment / files; equal task weight, geometric mean over repetitions within task. Bootstrap resamples whole tasks (10,000 draws, 95% percentile CI); signed-rank check uses task mean log ratios. Nonpositive or unavailable metrics are excluded. Light controls are separate.

| Arm | Stratum | Metric | Tasks / pairs | Ratio | Cluster 95% CI | Wilcoxon p |
|---|---|---|---|---|---|---|
| mex-r3 | heavy | processed | 2 / 6 | 1.000 | 1.000 … 1.000 | 1.0000 |
| mex-r3 | heavy | costUsd | 2 / 6 | 1.000 | 1.000 … 1.000 | 1.0000 |
| mex-r3 | light | processed | 1 / 3 | 1.000 | – … – | 1.0000 |
| mex-r3 | light | costUsd | 1 / 3 | 1.000 | – … – | 1.0000 |

## Delivery cost and time

Cost per success includes all valid attempts' paid cost; ungraded answers remain ungraded. Test time uses the union of timestamped test tool intervals; missing timestamps stay unavailable.

| Arm | Kind | Correct / graded | USD per success | Median agent minus tests (ms) |
|---|---|---|---|---|
| files | qa | 0 / 0 | ungraded/unavailable | 106 |
| files | change | 0 / 0 | no successes | – |
| mex-r3 | qa | 0 / 0 | ungraded/unavailable | 764 |
| mex-r3 | change | 0 / 0 | no successes | – |

## Session audit

| Run | Hooks fired | Settle launched / outcome | Resume / restart | Accounting |
|---|---|---|---|---|
| 01-deep-a-r01-files | n/a | false / not-launched | 1 / 1 | verified |
| 01-deep-a-r01-mex-r3 | yes | false / not-launched | 0 / 0 | verified |
| 01-deep-a-r02-files | n/a | false / not-launched | 0 / 0 | verified |
| 01-deep-a-r02-mex-r3 | yes | false / not-launched | 0 / 0 | verified |
| 01-deep-a-r03-files | n/a | false / not-launched | 0 / 0 | verified |
| 01-deep-a-r03-mex-r3 | yes | false / not-launched | 0 / 0 | verified |
| 02-deep-b-r01-files | n/a | false / not-launched | 0 / 0 | verified |
| 02-deep-b-r01-mex-r3 | yes | false / not-launched | 0 / 0 | verified |
| 02-deep-b-r02-files | n/a | false / not-launched | 0 / 0 | verified |
| 02-deep-b-r02-mex-r3 | yes | false / not-launched | 0 / 0 | verified |
| 02-deep-b-r03-files | n/a | false / not-launched | 0 / 0 | verified |
| 02-deep-b-r03-mex-r3 | yes | false / not-launched | 0 / 0 | verified |
| 03-control-r01-files | n/a | false / not-launched | 0 / 0 | verified |
| 03-control-r01-mex-r3 | yes | false / not-launched | 0 / 0 | verified |
| 03-control-r02-files | n/a | false / not-launched | 0 / 0 | verified |
| 03-control-r02-mex-r3 | yes | false / not-launched | 0 / 0 | verified |
| 03-control-r03-files | n/a | false / not-launched | 0 / 0 | verified |
| 03-control-r03-mex-r3 | yes | false / not-launched | 0 / 0 | verified |

## Tokens and cost per task and arm (medians)

| Task | Arm | Input (uncached) | Cache write | Cache read | Output | Cost (USD) |
|---|---|---|---|---|---|---|
| deep-a | files | 24 | 0 | 12000 | 14 | 0.001 |
| deep-a | mex-r3 | 24 | 0 | 12000 | 14 | 0.001 |
| deep-b | files | 24 | 0 | 12000 | 14 | 0.001 |
| deep-b | mex-r3 | 24 | 0 | 12000 | 14 | 0.001 |
| control | files | 24 | 0 | 12000 | 14 | 0.001 |
| control | mex-r3 | 24 | 0 | 12000 | 14 | 0.001 |

Totals per arm over valid rows:

| Arm | Rows | Input (uncached) | Cache write | Cache read | Output | Cost (USD) |
|---|---|---|---|---|---|---|
| files | 9 | 216 | 0 | 108000 | 126 | 0.009 |
| mex-r3 | 9 | 216 | 0 | 108000 | 126 | 0.009 |

## Paired deltas (mex-r3 − files)

Matched pairs: 9. Intervals are 95% percentile bootstraps of the mean paired delta.

| Metric | Total files | Total mex-r3 | Total change | Mean paired delta | 95% CI |
|---|---|---|---|---|---|
| Processed tokens | 108342 | 108342 | 0.0% | 0 | 0 … 0 |
| Neutral cost (USD) | 0.009 | 0.009 | 0.0% | 0.000 | 0.000 … 0.000 |
| Real cost (USD) | 0.009 | 0.009 | 0.0% | 0.000 | 0.000 … 0.000 |
| Input (uncached) | 216 | 216 | 0.0% | 0 | 0 … 0 |
| Cache write | 0 | 0 | – | 0 | 0 … 0 |
| Cache read | 108000 | 108000 | 0.0% | 0 | 0 … 0 |
| Output | 126 | 126 | 0.0% | 0 | 0 … 0 |
| Wall time (ms) | 1081 | 7644 | 607.1% | 729 | 646 … 833 |
| Discovery calls | 9 | 9 | 0.0% | 0 | 0 … 0 |
| Tool calls | 18 | 18 | 0.0% | 0 | 0 … 0 |

## Allocation (mex-r3 arm, mean share per session)

| Category | Share of calls | Share of returned chars |
|---|---|---|
| discovery | 50.0% | 50.0% |
| source-read | 50.0% | 50.0% |

Discovery calls per mex-r3 session: median 1; files: median 1.

## Hooks (per session)

Events counted per kind with how many injected something; chars are what the hooks sent to the agent; hook time is in-session only (the settle worker is separate).

| Run | Prompt (inj) | Read (inj) | Edit (inj) | Grep (inj) | Bash (inj) | Hook ms | Injected chars | Budget hit | Stop blocks | Block ids | Flagged at stop | Settle passes | Refresh mode | Regrounded | Failures | Settle wait (s) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 01-deep-a-r01-mex-r3 | 1 (0) | 1 (0) | 0 (0) | 1 (0) | 0 (0) | 4 | 0 | no | 0 | – | 0 | 0 | – | 0 | 0 | 0.0 |
| 01-deep-a-r02-mex-r3 | 1 (0) | 1 (0) | 0 (0) | 1 (0) | 0 (0) | 4 | 0 | no | 0 | – | 0 | 0 | – | 0 | 0 | 0.0 |
| 01-deep-a-r03-mex-r3 | 1 (0) | 1 (0) | 0 (0) | 1 (0) | 0 (0) | 4 | 0 | no | 0 | – | 0 | 0 | – | 0 | 0 | 0.0 |
| 02-deep-b-r01-mex-r3 | 1 (0) | 1 (0) | 0 (0) | 1 (0) | 0 (0) | 4 | 0 | no | 0 | – | 0 | 0 | – | 0 | 0 | 0.0 |
| 02-deep-b-r02-mex-r3 | 1 (0) | 1 (0) | 0 (0) | 1 (0) | 0 (0) | 4 | 0 | no | 0 | – | 0 | 0 | – | 0 | 0 | 0.0 |
| 02-deep-b-r03-mex-r3 | 1 (0) | 1 (0) | 0 (0) | 1 (0) | 0 (0) | 4 | 0 | no | 0 | – | 0 | 0 | – | 0 | 0 | 0.0 |
| 03-control-r01-mex-r3 | 1 (0) | 1 (0) | 0 (0) | 1 (0) | 0 (0) | 4 | 0 | no | 0 | – | 0 | 0 | – | 0 | 0 | 0.0 |
| 03-control-r02-mex-r3 | 1 (0) | 1 (0) | 0 (0) | 1 (0) | 0 (0) | 4 | 0 | no | 0 | – | 0 | 0 | – | 0 | 0 | 0.0 |
| 03-control-r03-mex-r3 | 1 (0) | 1 (0) | 0 (0) | 1 (0) | 0 (0) | 4 | 0 | no | 0 | – | 0 | 0 | – | 0 | 0 | 0.0 |

Per arm (valid rows, mean per session):

| Arm | Rows | Hook events | Hook ms | Injected chars | Sessions with a Stop block | Sessions with failures |
|---|---|---|---|---|---|---|
| mex-r3 | 9 | 4.0 | 4 | 0 | 0 | 0 |

## Loop close (change tasks)

| Run | Tests | Knowledge files edited | Grounding issues vs baseline | Grounding lines rewritten | Hand-edited hashes |
|---|---|---|---|---|---|
