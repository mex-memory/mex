# Release gates

`npm run gates` runs the seven free gates and prints one table. A passing
check requires real, nonempty evidence. There are no model calls or paid runs.

```
npm run gates -- --release beta.1 --report test-results/gates/local.json
npm run gates:test
```

The release profile follows the features included in that release:

| Gate | beta.1 | beta.2 and final |
| --- | --- | --- |
| Knowledge bench | required | required |
| Graph quality | later | required |
| Compiler call graph | later | required |
| Saved-session replay | later | required |
| Overlay equals fresh build | later | required |
| Hook timing | required | required |
| Three-repo upgrade | required | required |

Later adapters remain visibly **not built** until implemented. Missing
required adapters block release. An implemented gate that fails blocks every
profile, even if its feature was scheduled later. An unavailable required
tool also blocks. Dirty checkouts cannot provide release evidence.

## Current adapters

Hook timing runs the real Go no-op process test, with its existing 17 ms p95
budget and 3 ms allowance above the bare-process p95 on a slow host. It
records p50, p95 and maximum separately; the maximum has no 17 ms guarantee.
Where present, the counters-active timing test is included too.
An environment variable cannot raise the budget or enable cached test results.

The knowledge bench (`knowledge.mjs`), saved-session replay (`replay.mjs`),
and three-repo upgrade (`upgrade.mjs`) are live. Graph quality, compiler call
graph, and overlay are **not built**.
Supplied historical reports can describe an older release; a current pass
requires the live product checks on the release commit.

**Saved-session replay.** [`replay-corpus/`](replay-corpus/README.md) holds a
public fixture checkout, checked entries, and native Claude Code and Codex
JSONL recordings. Its manifest pins the data and the expected replies. The
adapter builds the hook, indexes a fresh copy of the fixture, stores the
entry verdicts, and feeds the recordings into the agents' hook entry points
in fresh homes. It replays the recorded tool inputs and results as data.

Each session runs twice. All replies must match the reviewed expected bytes
in the same event order. The comparison replaces per-run receipt IDs with a
fixed marker. The adapter checks that stale and broken entries contribute
no claim text or full delivery receipts. It also probes the delivery
verdict for each of those entries and prices each session's input, cache
write, cache read, and output with `scripts/delivery-replay/cost.mjs`.
The search span trial is set to `on` for this replay to exercise delivery.

Run `node scripts/gates/replay.mjs` for local diagnostics. Build the CLI and
install the Go modules beforehand. The replay needs only those local tools
and the committed corpus. The [corpus README](replay-corpus/README.md) shows
how to add a public harness session and regenerate and review the manifest.
Gate reports contain only the outcome and counted checks.

**Three-repo upgrade.** `upgrade-corpus/` holds preserved MEX 0.8 scaffolds as
data, one JSON bundle per project, pinned by `manifest.json`, whose digest is
pinned in `upgrade.mjs`: Hono's (generated at the pinned commit, 60 code
groundings), novu's (a setup that was never committed and edited the root
`AGENTS.md` in place) and the exact post-commit hook that 0.8.5 `mex watch`
wrote. MEX's own scaffold is read from its pinned public commit. The adapter
shallow-fetches each pinned commit once into its cache (`MEX_GATE_CACHE`, or the
system temp folder), builds a 0.8 user's checkout behind a local `origin`
(Hono with `core.autocrlf=true`, as on Windows), and runs the built CLI:

- preview: reads every document, changes no byte and creates no machine state;
  pinned counts of entries, team and personal entries, tracked and local
  changes, review items and removed caches; no 0.8 template or workflow text,
  no heading as a summary, a bounded number of removed unverified commands, and
  every original grounding kept byte for byte unless its document is reported;
- apply: exactly the previewed tracked files on one branch with the previewed
  bytes, nothing pushed without `--pr`, only local changes in the checkout,
  retained documents unchanged, the old index cache and the generated watch hook
  removed, personal entries stored, and a second run reporting the upgrade;
- publication (MEX): `--pr` with a failing stand-in `gh` keeps the pushed
  branch, and `--finish --pr` opens the pull request against the default branch;
- refusal (novu as found): an uncommitted, edited `AGENTS.md` blocks the upgrade
  and nothing changes.

The stand-in `gh` is built from a few lines of Go and never reaches a network
or account. A changed count is a reviewed change to `manifest.json` and its
pinned digest. No network means `tool-unavailable`, which blocks a required gate.
`node scripts/gates/upgrade.mjs` prints each failed check for local diagnosis.

**Knowledge bench.** The adapter clones the public subject (Hono) into the
system temp folder, rebuilds the deterministic corpus with
`scripts/knowledge-bench/build-corpus.mjs` and refuses it unless its digest is
the one pinned in `knowledge.mjs`, builds the hook binary, and runs
`scripts/knowledge-bench/run.mjs`: at T0 it registers a worktree with MEX,
records each claim's check with the real evaluator and writes the claims as
team facts; at each of the six checkpoints it refreshes the file index, runs
the evaluator (storing verdicts) and asks the delivery controller what it
would send (`mex-hook --delivery-probe`). The corpus is 46 hand-written claims
(20 package.json keys, 12 source literals, 14 behaviours backed by symbol
fingerprints) with independent truth functions over `git show` text; 15 are
false by T1. It stands in for a corpus written by setup and capture: run
`run.mjs --corpus <dir>` with any corpus of the same shape to swap one in.
No network means `tool-unavailable`, which blocks a required gate.

`knowledge-score.mjs` scores the observations. The corpus states its size
(at least 40 claims) and needs six exact source checkpoints, the expected
corpus digest and candidate commit, source-only truth labels and observations
from the real verdict/delivery path. Corpus file hashes are verified before
scoring. Every query records a full fact, pointer,
withheld result or retrieval miss; a pointer must contain no original claim.
Broken delivery, stale full text and changed/unknown-changed full code facts
fail. Check evaluation has a fixed 1,000 ms ceiling per checkpoint; query and
graph-build time are not included in that measurement. True/stale counts and
rates remain available to the private report. Empty C0 delivery and incomplete,
duplicate, stale-commit or mismatched-corpus observations fail closed.

Historical percentages and legacy warning-only results cannot satisfy its
input format.
Only the reduced count result goes into the public gate report.

Adapters are fixed, repository-owned functions, given the checkout root, release
profile and current OS. A future private corpus is data,
never a command to execute. Keep saved transcripts and any fixtures containing
private text outside the public repository. Do not upload raw child stdout,
stderr, session content or paths as CI artifacts. Reports admit only gate IDs,
fixed reason codes, check counts, bounded timing metrics and commit identity.

## CI and publication

`Release gates` runs on demand and for 0.9 release tags. Linux, macOS and
Windows each produce a sanitized report. The final `release-gates` check
requires all three reports, the same exact commit and release profile, clean
checkouts, and successful producer jobs. Missing or malformed evidence fails
closed. The full test suite remains in the existing Linux CI jobs.

For tagged runs, package version and tag must match. beta.1 and beta.2 tags
select their own scope; RC and final tags require all seven gates. A manual
profile cannot reduce a tagged release's requirements. This workflow does not
publish a package: the release procedure must require a green `release-gates`
check on the tagged commit before publication.

Child processes have bounded output and deadlines. A timeout or output overflow
terminates the process tree, including children holding inherited output pipes.
The parent never prints raw diagnostics. Tests cover those termination paths,
release policy, invalid evidence, and cross-OS report aggregation.
