# Release resource measurements

`run.mjs` retains the frozen small/medium/large fixture profiles and budgets.
Hub idle and maintenance RSS now sum the Hub and its observed descendants in
each sample. Maintenance also records observed process CPU deltas. The report's
`configuration.processMeasurement` describes scope and sampling limitations;
older reports remain schema-valid but measured only the Hub PID.

Linux uses `/proc` with a 10 ms interval. macOS samples `ps`; Windows keeps one
local PowerShell/CIM sampler running, avoiding a shell startup per sample. Those
platforms use a 100 ms interval. CPU already observed from an exited child stays
in the total, and process start identities distinguish reused PIDs. Sampling
can miss short-lived children and CPU between the last sample and exit. Summed
RSS can double-count shared pages; it is not unique physical memory. Sampling
errors fail the run instead of becoming zero usage. Windows/macOS measurement
support does not establish a second calibration platform.

HTTP deadlines cover headers and bounded streamed bodies, including job
creation. Ordinary requests and stream headers are limited to five seconds or
the remaining job deadline, whichever is smaller. Maintenance then waits for a
terminal snapshot on the same SSE route as the production UI, retaining the
absolute job deadline through stream consumption. Events, event count, and
total stream bytes are bounded. This avoids adding repeated SQLite status reads
while the candidate works; no retry hides stream failures. Elapsed time still
covers job creation through terminal delivery, and child resource sampling
continues throughout. New reports identify this method with
`configuration.maintenanceObservation: "job-event-stream"`; earlier reports
without that field used repeated job-status polling.

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

## State diagrams

The `diagrams` and `diagramDetail` routes are measured separately. Detail includes
the lazy statechart canvas, contract, strict Mermaid state renderer and its
static dependency closure; none may enter Home or the initial shell closure.
The fixture adds one saved, explicitly incomplete snapshot through the real
repository service. It does not change the frozen Graph/Wiki input corpus.

The two owned asset leaves and six heap leaves are calibrated from pinned Linux
CI run 40311997168; `docs/design/state-diagrams-calibration.json` retains samples,
formulas, limits, source commit and report hash. Every unrelated budget and the
runner identity remain unchanged. Missing budgets still fail closed with
`budget_missing`; an unknown budget is never confirmable noise or an implicit
pass. Do not copy local timing/heap numbers into the frozen file.
