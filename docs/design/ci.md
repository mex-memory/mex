# CI and releases

Require **`ci-passed`** on `next`, then on `main` at integration. It collects all
CI gating jobs, including Hub browser tests. Failed, cancelled or unexpectedly
skipped jobs fail it. One required check lets jobs change without editing branch
protection or leaving skipped matrix checks waiting forever. Do not require
advisory or path-filtered workflows.

| Workflow | Checks | Triggers |
| --- | --- | --- |
| `ci.yml` | Node 22/24 suites (two shards each), types/packages/evaluators, three-OS Go, serial portability parts, browser and workflow lint | Every PR; `next`/`main` pushes |
| `statechart-checker.yml` | Real TLC and packed skill on three OSes | Relevant source/skill/Hub/build/dependency PR paths; `next`/`main` pushes |
| `typescript-servers.yml` | Compiler-server parity on pinned repositories | Relevant PR paths; `next`/`main` pushes; manual |
| `release-performance.yml` | Pinned budgets and conditional fresh-runner confirmation | `next`/`main` pushes, 0.9 tags, manual; advisory; one tracking issue for red `next` results |
| `gates.yml` | Seven release gates and three-OS `release-gates` verdict | Called by Release; manual once on `main` |
| `release.yml` | Decisions, seven packages, three-OS registry smoke, dry/real publication | `v0.9.0*` tags; release-path PRs (always dry); manual once on `main` |
| `setup-agent-smoke.yml` | Setup with controlled fake agents | Manual |

Docs-only PRs run scope detection, a workflow-lint no-op and the aggregate. Only
Markdown under `docs/` and diagram SVGs qualify. Root Markdown ships in the
package; skill files, calibration JSON, code and workflow edits run full CI.
Renames consider both paths. Pushes run everything. PR runs replace older runs;
pushes retain a verdict per commit. Windows temporary files and caches use the
fast `RUNNER_TEMP` disk before setup actions restore caches.

Treat a red check as a failure to investigate. If a test fails and passes on the
same commit, fix its cause in the next PR touching it, or in a dedicated PR.
A rerun is a temporary diagnostic, never the resolution. Do not widen product
budgets, ignore unhandled errors or add blanket retries. These fixes use no retries.

## Failures fixed

| Failure and evidence | Cause and fix |
| --- | --- |
| Vitest `onTaskUpdate` RPC timeout: seven jobs on 13 November; [failed](https://github.com/mex-memory/mex/actions/runs/43386214015/job/131755397141), [same-commit pass](https://github.com/mex-memory/mex/actions/runs/43386214015/job/131761722362) | The record interop test compiled its Go peer with a synchronous call. A cold compile blocks the Vitest worker past its 60-second RPC timer, so the run fails after every test has passed. A local 65-second synchronous child reproduces it; the async version passes. `next` already fixed the cause on 13 November: the interop compile became async, and the acknowledged runner waits for replies before fixture work. None has happened since. On top of that, the root jobs now set up Go with its cache, so the compile is fast, and the file-index parity test compiles asynchronously too. |
| TLC `resource-limited` and premature test timeout: [failed](https://github.com/mex-memory/mex/actions/runs/43491181614/job/132112478879), [same-commit pass](https://github.com/mex-memory/mex/actions/runs/43491181614/job/132114145466) | The failed revisions launched a separate JVM with a five-second cap and abandoned checks at a 15-second test timeout. Current code records provenance in the checking JVM, fixes heap/CPU/workers at 512 MB/2/1, and lets the unchanged 60-second checker limit settle before the test hang guard. Ten real TLC checks pass locally, including cancellation and deliberate resource exhaustion. |
| DNS blackhole cancellation: [failed](https://github.com/mex-memory/mex/actions/runs/43224152952/job/131202892032), [same-commit pass](https://github.com/mex-memory/mex/actions/runs/43224152952/job/131720565325) | A 150 ms wall-clock assertion measured scheduling delay. The real loopback DNS test now awaits and asserts the actual `ECANCELLED` callback, resolver cancellation, settled send and purged queue. The test hang guard remains; production deadlines are unchanged. |
| Killed setup recovery: [macOS failure](https://github.com/mex-memory/mex/actions/runs/43388888751/job/131763793497), [Linux failure](https://github.com/mex-memory/mex/actions/runs/41837404813/job/126599777958) | Killing when the first scaffold file appeared raced remaining file writes. A child-only preload parks the real built CLI after scaffolding and before population. The test kills it there, then proves the same complete recovery and unique knowledge/grounding assertions. Windows tree cleanup is asynchronous and bounded, with direct owned-child termination if tree enumeration is denied. |
| Counter timing sample loss: [macOS failure](https://github.com/mex-memory/mex/actions/runs/43580726558/job/132404735726) | Reopening the SQLite observer between calls added WAL/pager work. One read-only observer now releases each read transaction before the next hook; a separate test proves fresh reads and refused writes. The 200 persisted samples, 210-attempt ceiling and timing rules remain. Slower-machine counter loss outside this fixture remains a product problem, described below. |

Historical record writer/migration/interop contention did not recur in the
435 recorded jobs after the 13 November 18:14 UTC merge of the fixture-budget
and readiness fixes (62 successful Go jobs, 43 successful root jobs). It is not
an active flake or a retry exemption. Feature-branch assertion/package bugs are
also excluded. Release performance had 24 failures in the history; it remains
advisory on pushes/tags/manual runs, with no flake retry.

## Hook timing

Local runs and release gates require p95 <=17 ms, or <=3 ms above a bare process.
Ordinary CI reports shim/bare p50, p95 and max, plus the strict verdict. Its
current per-OS p50-overhead baseline lives in
`native/cmd/mex-hook/testdata/timing-baseline.json`; a regression exceeds
`max(2 * recorded overhead, recorded overhead + 3 ms, 5 ms)`. The release adapter
clears report mode and budget overrides. A reported strict failure still needs
product investigation even when ordinary CI passes.

The counter write is best effort: a 10 ms opener/write deadline and 1 ms busy
timeout can lose counts on slow storage. Windows CI measured about 5 ms extra
at the median with counters (15.69 versus 10.47 ms); this is real work. Local
profiling separates open/pragmas/schema/guard/insert/commit/close with
`go test -v ./record -run '^$' -bench BenchmarkCounterPhases -benchtime=100x`
from `native/`. The isolated opener still reported 98 deadlines in 100 cycles
on the development machine. Keeping a timing observer open improves fixture
mechanics; it does not certify standalone counter reliability or fix the storage
design. Neither this cost nor strict timing failures qualify for a retry.

## Release path

PR rehearsals skip the expensive gates, prove that absent same-commit evidence
refuses a real release, and say so in the summary. They build and smoke all seven
packages, run `npm publish --dry-run` in order, then print the GitHub release
command. No credentials or environment approval are needed.

Real publication is currently blocked: required gate adapters are not built and
the strict Windows timing budget is not satisfied. A rehearsal cannot certify
those gates. For a real release:

1. Commit matching root/lockfile and six platform manifest versions. Push the
   matching version tag. A mismatch stops immediately. Release calls gates once
   on that commit; every later job requires the same-commit `release-gates`
   verdict. The current gate profiles support beta.1, beta.2 and final/rc.
2. Linux builds all binaries and the production app, packs seven tarballs and
   writes `SHA256SUMS`. Checksums, versions, constraints and all six exact root
   optional dependencies are checked before publication. Each OS installs
   `mex-agent@<version>` from a read-only loopback registry containing the actual
   tarballs; public npm supplies other dependencies. npm must select only the
   host package, its native resolver/self-test must pass, and `mex --version`
   must match. There is no tarball-install shortcut.
3. A real publish waits for **`npm-publish`** environment approval. Checksum-pinned
   npm 11.6.1 publishes with provenance/public access: Linux x64/arm64, macOS
   x64/arm64, Windows x64/arm64, then `mex-agent`. Beta/rc use `next`; `0.9.0`
   uses `latest`. Existing versions are skipped on retry; registry/authentication
   errors fail. Nothing is unpublished. Failed-only reruns reuse the build artifact.
4. After npm succeeds, another job creates the GitHub pre-release (beta/rc) or
   release, attaching seven tarballs and checksums. It requires an existing tag
   and completes existing assets on retry. Releases per ref queue without cancellation.

Manual inputs default to `dry_run: true`, `require_gates: true`. Only dry runs
may set `require_gates: false`; real manual runs also need the matching existing
tag on this commit. Dispatch is unavailable until the workflow reaches `main`;
until then use a release-path PR rehearsal. Tag pushes always take the real,
gated path.

## One-time owner setup

- Require only `ci-passed`; remove the old matrix requirements. Apply to `main`
  at integration.
- Claim `mex-agent-hook-linux-x64`, `mex-agent-hook-linux-arm64`,
  `mex-agent-hook-darwin-x64`, `mex-agent-hook-darwin-arm64`,
  `mex-agent-hook-win32-x64`, `mex-agent-hook-win32-arm64`; confirm publish rights
  for these and `mex-agent`.
- Create `npm-publish` with required maintainer reviewers and release-ref restrictions.
- Configure trusted publishing for all seven packages: this repository,
  `release.yml`, environment `npm-publish`. Alternatively set an authorized
  publishing token as the environment's `NPM_TOKEN` secret (supplied as
  `NODE_AUTH_TOKEN`). Without it npm uses OIDC. Only publish requests
  `id-token: write`; only GitHub-release requests `contents: write`.
  See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) and
  [provenance](https://docs.npmjs.com/generating-provenance-statements/).
- After all six platform versions are published, commit all six exact root
  `optionalDependencies` and regenerate/test the lock with npm 10 and 11. Until
  then packing stages them without changing the checkout: npm 10 omits
  unpublished entries, while npm 11 rejects that lock or creates versionless
  placeholders. Packing always pins all six to the packed root's own version.

Keep actual tags, credentials, namespace claims and approval with the owner.

