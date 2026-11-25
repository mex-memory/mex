# Release resource measurements

Run `node scripts/release-benchmark/run.mjs` after the production build. Use
`--assets-only` for deterministic bytes without starting Chromium or the Hub.
The runner enforces asset budgets on every invocation. Runtime enforcement
still requires `MEX_ENFORCE_RELEASE_BUDGETS=1` on Ubuntu 24.04 x64 with Node
22.22.0.

## Machine Hub

The Vite manifest accounts for the initial JS and CSS closure and every built
font. Route measurements count the bytes added by each lazy Home, Jobs, Knowledge, and Review
page, including their shared chunk. The initial and largest-chunk limits
retain the previous calibration. Route limits use `ceil(built bytes * 1.05)`.

Cold readiness runs `mex hub --foreground --no-open` against a new temporary
MEX home for every sample and times through the first completed, validated
`GET /api/v1/hello`. The warm API reads use the session cookie and time complete
responses from `/api/v1/session`, `/api/v1/projects`, `/api/v1/home`, `/api/v1/jobs`,
`/api/v1/knowledge`, `/api/v1/knowledge/landing`, `/api/v1/review`, and
`/api/v1/review/cards/:key`. Each frozen fixture profile registers one Git
checkout in its own temporary MEX home. Knowledge and Review read 4, 16, or
48 seeded items after their snapshots are ready. Browser heap
uses a fresh Chromium context for each sample after real fixture content appears
on the route, and fails if the page requests any other origin. The benchmark
checks that Hub reads preserve repository state.

There are ten timing samples and five idle and browser samples per profile.
Idle RSS and CPU use the process-tree sampler over two seconds after warming
the authenticated API. HTTP measurements bound response bodies and apply
deadlines to headers and bodies. Linux samples through `/proc` every 10 ms.
macOS uses `ps` and Windows uses one local PowerShell/CIM sampler, both at
100 ms. Sampling may miss short-lived processes. Summed RSS can count shared
pages more than once. Sampling errors fail the run.

The machine Hub has no Graph or Wiki maintenance job endpoints. Current
reports use `maintenance: null` for each profile. The previous job latency and
RSS limits remain provisional, and historical job-stream reports still
validate. Graph and Wiki database ratios continue to use the frozen fixtures
and their existing limits.

Cold readiness, idle, Home heap, session, and projects retain their previous
limits. Home, Jobs, Knowledge, and Review API latency have provisional caps
per fixture size. The Review queue uses the Knowledge page caps. Review detail
has twice that allowance for the selected checkout scan. Repo heap uses the smallest previous route heap limit. Those limits enforce
on the pinned runner, where calibration uses `ceil(measured p95 * 1.15)`.
Local macOS or Windows timing and heap samples are for characterization.

## Startup diagnostics

When small-fixture Hub startup crosses its budget, CI can run ten separate
startup diagnostics after every release measurement has finished. These record
wall time through hello and process CPU, import time, and aggregate
synchronous filesystem/child process time through the printed sign-in link.
Diagnostic reports contain fixed numeric fields and checkout identity. Diagnostic runs do not contribute samples
to a release report or change its verdict, budgets or confirmation policy.

## Separate graph characterization

Run `node scripts/release-benchmark/graph-characterization.mjs --smoke` to verify
the harness on 10 files. Omit `--smoke` for the 180-file characterization corpus;
use `--output <path>` to retain the JSON report. These measurements create no
release budgets and do not replace the pinned release gate.

The corpus contains four TypeScript projects, an overlapping root configuration,
inferred JavaScript, a synthetic installed declaration dependency, and a large
function. It is generated locally without network/package installation. Five
operations run in one disposable engine process: fresh build, unchanged sync,
changed sync, unchanged sync, changed sync. Changed syncs toggle an executable
numeric addition in the large function. The tool validates expected source
coverage and no-op behavior, and records input digest, runtime versions, CPU,
sampled RSS, and post-close memory after three diagnostic GCs. This distinguishes
working set from retained memory without introducing forced GC in production.
The aggregate CPU sample includes cleanup/diagnostic GC; the operation's own
`cpuMs` excludes that work. This engine-only test complements the Hub process
tree measurements; it does not claim to test browser responsiveness.

The worker has a 2 GiB V8 old-space hang guard, a 2.5 GiB sampled RSS stop,
30-second smoke/180-second normal per-operation deadlines, and bounded output.
These are experiment guardrails, not product budgets or exact OS memory caps.
Temporary corpora and source bundles are parent-owned and removed after success
or failure. Run representative characterization serially with other resource
measurements, and never calibrate release limits from laptop results.
