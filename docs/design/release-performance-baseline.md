# Release performance baseline

Status: Checkpoint A benchmark contract. Built-asset and runtime budgets are
frozen. Runtime budgets were characterized by pinned CI run
[`33005876613`](https://github.com/mex-memory/mex/actions/runs/33005876613).
Checkpoint C's bundle and route assets, including Members and Activity, were
characterized by pinned CI run
[`33083122092`](https://github.com/mex-memory/mex/actions/runs/33083122092),
then copied from that retained report using the same formulas before the
enforcing rerun. The retained `release-performance-1` artifact (ID
`9651219193`, report SHA-256
`f83a69133fa916bfd15deed8c107a561b885c0170abb1d44d8820825a76c7c83`)
measured PR head `76cbd154def06dec29325a2ed67687aee0fc7805` through GitHub's synthetic
merge commit `e50116100c9461032e77ba47704248bdb4923df2`. Its request audit recorded
zero outbound requests for every fixture. The exact asset candidates and the
Home, Members, and Activity heap candidates were copied; unrelated runtime
budgets remain calibrated from the original pinned run.

Checkpoint D's Workstreams and Specs list/detail routes were characterized by
pinned CI run
[`33117048710`](https://github.com/mex-memory/mex/actions/runs/33117048710).
The retained `release-performance-1` artifact (ID `9665147644`, report SHA-256
`edb9f14f73f8de8ebda15407362fe57e591075b4dd93686d6a273089d280e997`)
measured PR head `fa2cc3b95242063ac76e0241a2ca72bd098ee302` through GitHub's
synthetic merge commit `4d78fbc141c4a79ee4f076283eb5865b22954ee7`. The
report was produced on Ubuntu 24.04 with Node 22.22.0, validated against the
versioned report schema, and recorded zero outbound browser requests for all
three fixtures. Only the exact Workstreams and Specs list/detail asset
candidates and their per-profile browser-heap candidates were copied; every
pre-Checkpoint-D budget remains frozen.

Checkpoint E's Inbox route, draft/proposal list reads, and Inbox heap were
characterized by pinned CI run
[`33169865368`](https://github.com/mex-memory/mex/actions/runs/33169865368),
release-performance job
[`98844086990`](https://github.com/mex-memory/mex/actions/runs/33169865368/job/98844086990).
The retained `release-performance-1` artifact (ID `9685340925`, report
SHA-256 `6cece5bcda181a0931edf2e3ee9355cff2a45f9d6af0ff463ba3eff0d16cdf50`)
measured PR head `84b6124af88ddfcb6c1798cf95705f2d3850b64f` through GitHub's
synthetic merge commit `f64338799d71a35476301a7458a6b6c96e9e5cde`. The report
validated against the versioned schema on Ubuntu 24.04, Linux x64, Node
22.22.0 with ten timing and five heap samples, one draft and one proposal in
each fixture, and zero outbound browser requests. Only the exact Inbox asset
candidates (`120514` JS, `15589` CSS, `0` font), draft/proposal API candidates
(`7`/`6` ms for small, `7`/`6` ms for medium, and `7`/`6` ms for large), and
Inbox heap candidates (`6492790`, `6497358`, and `6504906` bytes) were copied.
The run's unrelated first-pass runtime crossings were not confirmed after the
expected deterministic Inbox asset failure short-circuited confirmation, so
every pre-Checkpoint-E budget remains frozen. A clean enforcing pinned run is
required before the checkpoint can merge.

Checkpoint F's Relay route, draft/canonical list reads, and Relay heap were
characterized by pinned CI run
[`33249296778`](https://github.com/mex-memory/mex/actions/runs/33249296778),
release-performance job
[`99092066213`](https://github.com/mex-memory/mex/actions/runs/33249296778/job/99092066213).
The retained `release-performance-1` artifact (ID `9713923132`, archive
SHA-256 `6d9373c802bdc33f5f9b4d9abc79c13ff22684912eea08e3a78ead1fc845882f`,
report SHA-256 `4626c75ed887f078036168080853cfb39ee39d950e45f48f5e1b2694c9369347`)
measured PR head `9becb8635e90b324c168b0d387954307808f3e02` through GitHub's
synthetic merge commit `2b25e73292bc1c54d68fae004eca07c7ec7832c7`. The report strictly
validated on Ubuntu 24.04, Linux x64, Node 22.22.0 with ten timing and five
heap samples. Every fixture had two Members, one local Relay draft, one
published Relay, and zero outbound browser requests. The retained measurements
predate the standalone schema-v3 artifact change; the fixture adaptation keeps
the same counts, routes, and budgets, so a clean enforcing run on the final v3
head remains required.

Only the exact Relay asset candidates (`200128` JS, `12285` CSS, `0` font),
draft/list API candidates (`5`/`15` ms small, `3`/`12` ms medium, and
`4`/`13` ms large), and Relay heap candidates (`7753875`, `7754561`, and
`7748627` bytes) were copied using the frozen formulas. The initial shell and
maximum chunk remained below their frozen `460810`-byte ceiling; Home and
Members heap remained below their existing limits and were not changed. The
expected deterministic Relay asset failure short-circuited runtime
confirmation, so all shared first-pass crossings remain unconfirmed and every
non-Relay budget stays frozen. A separate clean enforcing run on the final
exact head is mandatory, including confirmation of the four potentially
material maintenance crossings from the characterization pass.

The identity-first Members workbench was measured again from the final local
production build after its dialog code moved behind an explicit mutation
boundary. The route measured `83232` JS, `12038` CSS, and `0` font bytes. Only
the Members CSS ceiling was recalibrated to the exact frozen formula candidate
of `12640` bytes (`ceil(12038 * 1.05)`); its existing `93022`-byte JS ceiling
and every other asset and runtime budget remain unchanged. A clean pinned
enforcing run on the final exact head remains required before release.

The flagship Overview workbench was measured from its final local production
build after the bounded aggregate validator moved behind the lazy Home route.
That isolation removed roughly 20 KiB of accidental validator weight from the
initial shell. The final build measured `461404` initial JavaScript bytes and
`126001` JavaScript / `16971` CSS bytes for Home. Only the initial/maximum
JavaScript ceilings and Home JavaScript/CSS ceilings were recalibrated to the
exact measured-plus-five-percent candidates: `484475`, `132302`, and `17820`
bytes respectively. Initial CSS/fonts and every unrelated route/runtime budget
remain unchanged. A clean pinned enforcing run on the final exact head remains
required before release.

The fresh-runner confirmation topology was added after PR run
[`33616707003`](https://github.com/mex-memory/mex/actions/runs/33616707003)
and integration push run
[`33619416840`](https://github.com/mex-memory/mex/actions/runs/33619416840)
produced materially different Graph, Wiki, and Search failure sets for Git
commits with the same tree SHA
`950182277ee98719ec6971618cb83b597323e468`. The earlier confirmation logic
started two child processes back-to-back on one hosted VM, so sustained host
contention could satisfy both sides of the exact-metric rule. This hardening
changes only confirmation allocation and provenance: `budgets.json`, sample
counts, material thresholds, category floors, and calibration formulas remain
byte-for-byte unchanged.

The 0.8.1 Settings route is included in the route manifest, isolated asset
closures, and per-profile browser heap measurement. Its readiness check waits
for the loaded logging preference form and current selection, so a loading or
unavailable page cannot satisfy measurement. Settings must remain outside the
initial shell and Home closures. Only its additive asset limits may be copied
from the final deterministic build using `ceil(bytes * 1.05)`.

At the Phase 4 checkpoint, the three Settings heap budget leaves remained
absent, so enforcement emitted `budget_missing` and blocked release. Initial
PR #180 CI run
[`34286120355`](https://github.com/mex-memory/mex/actions/runs/34286120355)
then supplied the retained, schema-valid measurement report on Ubuntu 24.04,
Linux x64, Node 22.22.0. Artifact `10079816681` measured PR head
`6e12e6dd34a3bb11735ce3580aece8d37e2e8043` through synthetic merge commit
`8c046500e2969463014e12dc5844abf76ae403ce`; the raw report SHA-256 was verified as
`98007786b450eb7a6142d0ce43cf2bb6fc85c287d6e0a8837850318d5924fd04`.

Only the three missing Settings heap leaves and calibration-status metadata
are now added using the frozen `ceil(p95 * 1.15)` formula:

| Profile | Measured Settings heap p95 | New limit |
|---|---:|---:|
| Small | 5,480,428 bytes | 6,302,493 bytes |
| Medium | 5,482,104 bytes | 6,304,420 bytes |
| Large | 5,486,028 bytes | 6,308,933 bytes |

The [retained calibration evidence](settings-heap-calibration.json) records all
five raw samples per profile, exact report identity, formula, and a hash of
every unowned budget. Existing Graph and other runtime/asset limits, sample
counts, material thresholds, and confirmation rules remain unchanged. Settings
stays an additive optional schema field so historical reports remain valid.

That first CI run still failed enforcement: the missing leaves produced an
immediate hard failure and suppressed runtime confirmation. Its first-pass
Graph maintenance crossings are unconfirmed, not a runtime pass or an
established regression. A clean enforcing run on the corrected final head must
apply the ordinary fresh-runner confirmation rule; calibration alone does not
satisfy the release gate.

### Accepted graph isolation timing tradeoff

Corrected PR #180 run
[`34288560611`](https://github.com/mex-memory/mex/actions/runs/34288560611)
passed browser, Node 22/24, and Windows/macOS portability checks. Its two
independently allocated pinned runners confirmed exactly five material Graph
maintenance timing failures on PR head
`4d6683eec1a0bdcafe99d7b431d84cde7f02864d`, synthetic merge
`6d92bb04d757c8a00693ef679d1f4281669a9b57`. Repeated memory crossings remained
advisory under the existing materiality/sample-support rules; no memory or
other metric produced a final material failure.

The product decision explicitly accepts disposable-worker startup latency for
Hub responsiveness and compiler-memory release after each job. This is a real
small-job regression. Only the five confirmed timing leaves are recalibrated
from the first healthy corrected report using the existing `ceil(p95 * 1.15)`
formula; the second allocation supplies independent confirmation.

| Graph operation | Prior limit (ms) | First p95 (ms) | Confirmation p95 (ms) | New limit (ms) |
|---|---:|---:|---:|---:|
| Small refresh | 984 | 1420.610 | 1853.568 | 1634 |
| Small rebuild | 496 | 1468.480 | 1608.501 | 1689 |
| Medium refresh | 1237 | 1600.897 | 1714.770 | 1842 |
| Medium rebuild | 743 | 1581.908 | 1550.249 | 1820 |
| Large rebuild | 1229 | 1980.154 | 2074.786 | 2278 |

The [calibration record](graph-maintenance-timing-calibration.json) retains
runner identities, both raw-report hashes and samples, prior limits, and a hash
guard for every unowned budget. Large refresh, all memory/asset/read/Wiki
limits, fixtures, formulas, sample counts, and confirmation rules remain
unchanged. The [local diagnostic](graph-isolation-diagnostic.json) attributes
the fixed startup cost using identical optimized code and parent validation;
its Mac timings are not calibration inputs. A clean enforcing CI run on the
new calibrated head remains required before release.

### Settings route JS for the Hub tour replay

PR #195 adds a "Replay Hub tour" section to Settings. Pinned run
[`34739467180`](https://github.com/mex-memory/mex/actions/runs/34739467180)
on PR head `b5ee04302b841e3e97a450f596f903c78aa2b057`, synthetic merge
`baca280d56be22fac57f84c6867127416acf59a8`, built the Settings route at 8,550
JS bytes against the 8,035-byte limit. That deterministic asset violation was
the run's only hard failure. It suppressed runtime classification, so the
report's first-pass runtime crossings are unassessed, not confirmed.

The product decision accepts the replay control in Settings. Only that leaf is
recalibrated, using the existing `ceil(built bytes * 1.05)` formula:

| Budget | Prior limit | Built bytes | New limit |
|---|---:|---:|---:|
| Settings route JS | 8,035 | 8,550 | 8,978 |

The [calibration record](settings-route-js-calibration.json) retains the
runner identity, raw-report hash, the three measured files, and a hash of every
unowned budget. The test projection restores the prior limit, so the earlier
Settings heap and Graph timing guards keep their original hashes. Initial,
Home, and every other route limit stay unchanged. A clean enforcing CI run on
the calibrated head remains required.

## Runner contract

`npm run benchmark:release` builds the package and writes the bounded JSON
report to `test-results/release-benchmark/report.json`. The report and budget
contracts are versioned by
`scripts/release-benchmark/report.schema.json` and
`scripts/release-benchmark/budgets.schema.json`.

The benchmark generates three fixed Git repositories. Every profile contains
one Workstream, one checkout-local Inbox draft, one pending canonical proposal,
two active Members, one sparse standalone checkout-local Relay draft, and one
standalone schema-v3 published Relay. The Workstream remains an independent
route fixture and is not referenced by either Relay fixture.
Small contains four source files, four Wiki entities, and four canonical
Activity events; medium contains sixteen of each; large contains forty-eight of
each. Relay publication reuses the first existing Activity slot, so Activity and
the declared source, synthetic Knowledge/Wiki, and Inbox fixture counts remain
unchanged. The first four existing Wiki entity IDs form a root
Spec/requirement/constraint/acceptance-criterion slice under `.mex/specs/**`;
no extra synthetic Knowledge or Spec-family records are added. The team-owned
Workstream and Relay remain separately readable through the Wiki index, as in a
real repository. The Relay stores a deterministic clean publication repository
observation and omits Workstream; its Activity uses the same repository state.
IDs, contents, timestamps, Git identity, commit timestamp, and repository shape
are deterministic. Graph and Wiki indexes are built only by explicit setup in
the benchmark. Reads never initialize storage or maintain either index.

Each profile records:

- ten cold Hub readiness timings;
- five idle server RSS and CPU samples over a two-second quiet window;
- ten exact Hub API timings for Search, Code, Knowledge, Activity, Inbox draft
  and proposal listing, and Relay draft and `mine`/open Relay listing;
- ten timings for each Graph/Wiki refresh and rebuild, with five peak-RSS
  samples for each operation;
- Graph and Wiki SQLite-family bytes relative to their indexed input bytes.

Every profile additionally records five Chromium heap samples after every
registered Hub route: Home, Search, Knowledge browse/detail, Code search/symbol,
Workstreams, Specs browse/detail, Inbox, Relay, the honest unavailable Playbooks
route, Members, Activity, Jobs, Health, Settings, and the wildcard not-found route.
Every browser context begins empty. Its request audit fails if a route contacts
any origin other than the exact loopback Hub origin.

Production asset accounting starts from Vite's manifest. It records the
initial static import closure and the incremental JavaScript, CSS, and font
bytes for every registered route. Fonts referenced from global CSS are counted
as initial assets even when Vite does not attach them to a manifest entry.
The initial shell and Home must not statically close over Code, Knowledge,
Workstreams, Specs, Inbox, Relay, Members, Activity, Settings, or setup code, and the
largest JavaScript chunk is checked explicitly. The Activity route is a
read-only workbench and has no nested manual-recorder chunk. Its source
controls, default feed, and accessible shadcn Collapsible controls remain in
the eager route closure; only explicitly expanded context and technical
evidence load on demand. The redesigned eager Activity closure measured
63,488 JavaScript bytes and 18,511 CSS bytes, so its 66,663-byte JavaScript and
19,437-byte CSS limits use the same deterministic measured-plus-five-percent
rule; the initial-shell limits did not change.
Production assets are also scanned for exact development-fixture sentinels.

## Enforcement

Deterministic asset limits are checked on every benchmark invocation. Their
committed values are the measured production bytes plus five percent, rounded
up. Asset-only local verification is available after a build:

```sh
node scripts/release-benchmark/run.mjs --assets-only
```

Wall-clock and memory budgets are enforced only when
`MEX_ENFORCE_RELEASE_BUDGETS=1`. In that mode the runner first proves the exact
budget environment: Ubuntu 24.04, x64, and the pinned Node 22 patch release in
`budgets.json`. This prevents a laptop or a floating CI image from turning
machine variance into a release failure. Node 24 remains in the ordinary CI
compatibility matrix, outside performance enforcement.

Deterministic failures remain immediate: built-asset bytes, outbound requests,
database-to-input ratios, and any unknown runtime metric never receive a retry.
The read and maintenance nonmutation contracts likewise remain ordinary hard
tests. A first pass containing only wall-clock, RSS, CPU, or browser-heap
breaches requests one independent full benchmark pass only when at least one
crossing could still become material. In CI that conditional confirmation runs
in a separately allocated Ubuntu 24.04 hosted job, not as another process on
the first job's VM. Both jobs measure the exact same repository HEAD and pinned
Node version; a final fail-closed aggregation job validates their bounded raw
reports and runner-allocation records before applying the existing exact-metric
rule. A missing, malformed, same-runner, or different-HEAD confirmation is an
operational failure rather than a pass. The local `npm run benchmark:release`
command remains self-contained and uses its existing in-process orchestration.
Producer-specific artifact identities allow GitHub's failed-only rerun to reuse
valid evidence from an earlier attempt of the same workflow run. Aggregation
accepts only the same run and SHA, nondecreasing producer attempts, and evidence
no newer than the finalizer attempt.

A crossing is potentially material when its p95 is strictly above the material
threshold and at least two of its raw samples are also strictly above that
threshold. If every first-pass crossing is below the threshold or has fewer
than two supporting samples, enforcement records the advisories and passes
without allocating a confirmation runner. CI fails a noisy metric only when
that exact metric breaches on the fresh confirmation runner, both p95
measurements exceed its material threshold, and both attempts have at least two
supporting raw samples. This avoids treating the single maximum selected by
nearest-rank p95 over either ten timing samples or five memory samples as
distribution-level evidence, while preventing one contended VM from supplying
both sides of the confirmation. The committed p95 budgets remain the raw
alert/crossing line and are not recalibrated. For each exact metric key, the
blocking threshold is
`budget + max(15% of budget, minimum excess)`:

| Runtime category | Minimum excess |
| --- | ---: |
| API latency | 15 ms |
| Cold readiness | 100 ms |
| Maintenance elapsed time | 50 ms |
| Idle CPU | 25 ms |
| Idle and maintenance peak RSS | 32 MiB |
| Browser heap | 2 MiB |

Crossings from both attempts remain bounded in `firstPassViolations` and
`secondPassViolations`. Repeated exact keys remain in `confirmedViolations`.
`advisoryAssessments` records one-off crossings, threshold misses, and
crossings with insufficient raw-sample support. Each generated assessment
records the required support count and the bounded sample/support counts for
the attempts that observed the metric; raw sample arrays remain in the
retained attempt reports. `materialAssessments` records only repeated crossings
where both measurements and both raw-sample distributions satisfy the rule.
The final `runtimeViolations` list contains only those material crossings plus
immediate hard failures. Operational benchmark failures, including missing or
inconsistent raw sample evidence, are never retried as budget noise.
Enforcement exits 0 for a pass, 1 for a budget failure, and 2 when a pass cannot
produce a valid bounded report.

The dedicated CI topology uses `release-performance-attempt-1`, a conditional
`release-performance-attempt-2`, and the final required
`release-performance` aggregation job. Each measuring job installs Chromium on
the pinned image and retains its raw report and bounded decision manifest for
14 days. The final job retains the combined report; it runs even if a producer
was cancelled or failed so missing evidence cannot silently skip the gate. The
first raw attempt is still retained when advisory sample support makes a second
runner unnecessary. Runtime candidates in that report are `ceil(p95 * 1.15)`
independently for each fixture profile, route, read, and maintenance operation.
The committed values are copied exactly from the first healthy retained pinned
report; its enforcing rerun must pass before Checkpoint A is considered green.
Future recalibration uses the same retained-report workflow. Do not derive
runtime limits from an unpinned local run or collapse fixture profiles into one
worst-case envelope.

The report is capped at 2 MiB. Response bodies, child-process diagnostics,
recorded request paths, asset lists, and violation lists also have explicit
bounds so benchmark failures cannot produce unbounded CI artifacts.

## Agent capability discovery

Checkpoint A also freezes `mex capabilities --json` at schema version 1. The
command performs only bounded, read-only repository and disposable-index
inspection. It bypasses first-run and telemetry hooks, never backfills scaffold
identity, initializes storage, invokes a model, or opens a network connection.
Expected missing/stale/migration and corpus-policy states are successful
discovery results; unexpected inspection failures use one redacted problem and
exit 2.

The installed-capability inventory includes the secure Project Hub, Team
identity, canonical Activity read/record, Graph, and Wiki surfaces. Checkpoint C
adds registered structured Member and Activity commands; Checkpoint D adds
registered Workstream reads/mutations and read-only Spec reads; Checkpoint E
adds registered Inbox draft/proposal reads and governed Spec-authoring preview/
apply commands; Checkpoint F adds Relay draft/canonical reads and its five
signed handoff mutations through a compact static-resolver descriptor. Every Team
mutation advertises distinct preview and apply invocations plus a bounded
machine-readable request schema, complete examples, the exact preview-envelope
apply rule, and the typed process-exit table. Read, preview, and apply
invocations remain separate fixed arrays, Graph's existing protocol-v3 commands
remain JSONL byte-compatible, and unavailable states carry static safe reasons
plus the next initialization action. Writable legacy Wiki synthesis commands
remain omitted from the governed agent surface. Playbooks, Catch Up, and future
team actions remain absent until their application services and structured CLI
contracts exist.

Generated agent anchors direct supported tools to discover this manifest,
prefer its structured reads, preview mutations, and wait for explicit human
approval before an advertised apply command.
