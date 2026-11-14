# Delivery controller

The Go shim calls `native/delivery.Handle` after its existing checkout,
off-switch and session-pause gates. The controller is silent in this first
slice. Session lifecycle owns durable epochs now; moments, verdict gates,
admission scoring and rendering are added in subsequent slices. Events with
no implemented moment return before any snapshot read or SQLite open.

Each `(session_id, agent_id)` has its own epochs. Startup establishes an epoch;
resume keeps it; clear, fork and compaction advance it. A subagent gets its own
600-token budget. Compaction notifications from PostCompact and SessionStart
confirm one transition in either order. A repeated signal starts the next
compaction cycle. The optional normalized `model` field comes from SessionStart.
An explicit `[1m]` variant selects 3,000 tokens; other/unknown models default
to 2,000. A signal with no model preserves the previous budget. Model/window
selection is isolated for later capability tables.

## Entries

`native/delivery/entries` implements the full entry-file codec separately from
the evaluator's partial projection. Shared fixtures exercise all seven kinds,
every check shape, optional metadata, malformed observations, unsupported
fields, bad paths/dates, duplicate keys, aliases, custom tags and text limits.
The Go and Node tests consume the same fixtures.

The per-checkout snapshot reads team entries from `.mex/learned/`, including
one kind folder, and personal notes/hints from the project's local storage.
It refuses redirected stores, duplicate team ids, filename mismatches,
oversize files and invalid entries. Retired ids are kept separately and never
become candidates. Source discovery is bounded to 10,000 directory children
and 8 MiB; individual reads stop at 64 KiB. Regular-file identity and size/time
are checked around reads. The cache is disposable and lives beside hooks.db.

Source metadata is inspected on every load, including additions and removals;
an in-place edit cannot be discovered from a directory timestamp alone. Parsed
entries are reused by size/mtime with the evaluator's two-second race window.
Scope regexps use the file index's existing dialect and compile on demand,
once per distinct scope in a load. Full/one-line strings include derived labels.
Token estimates use max(UTF-8 bytes/4, whitespace words × 1.3), rounded up.
No offline tokenizer was available for calibration.

A snapshot is a codec/store projection, not authorization to send its text.
Team evidence, privacy, current command/link checks, tombstones and hint source
observations still belong to the delivery gates. Hint items explicitly require
that additional gate. No snapshot text reaches a model in this slice.

## Ledger

`record.CheckAndMark` owns one immediate transaction for lifecycle, aliases,
presence, admission, receipts and counters. Admission runs under the writer
lock with the current budget and session total. Commit precedes rendering;
errors discard receipts and return the empty reply. The public API cannot deny
or block an agent's tool call. The existing telemetry failure counter records
controller errors where telemetry is enabled.

Receipts contain entry revision hashes, random ids and a shared reply block id.
Presence includes project and checkout so two repositories' ids do not collide.
Main and reserved totals are separate; reserved/exempt candidates stay counted.
Age pruning is bounded and never evicts entries from an active epoch just
because it has many deliveries. The migration and precise table definitions
are in [local-record.md](local-record.md).

## Measurements

Measured on Windows with Go 1.27 and synthetic entry files, using
`MEX_DELIVERY_MEASURE=1 go test -p 1 -count=1 -v -run 'TestHooksOpenTiming|TestSnapshotTiming' ./record ./delivery/entries`:

| Probe | Runs | p50 | p95 |
| --- | ---: | ---: | ---: |
| OpenHooks plus Close | 200 | 3.75 ms | 6.15 ms |
| Unchanged 500-entry snapshot | 200 | 7.11 ms | 12.40 ms |

The snapshot's cold rebuild was 328.26 ms (one run, measured). Directory
enumeration metadata avoids a separate stat per file; before that change,
unchanged p50 was 88.68 ms (200 runs, measured). The snapshot misses the design's
few-ms cold/sub-ms warm goal on this filesystem. Freshness checks remain;
future moment wiring must account for this cost. The sample full form is
estimated at 21 tokens. Actual deliveries in this slice: zero, zero tokens.

Opening SQLite exceeds the 3 ms p95 heartbeat allowance, so no-op calls retain
file heartbeats. Transactions update the database sighting when already open;
status combines both sources. Whole-process timing qualification is recorded
with the step report; a lifecycle/open probe includes the real transaction and
is more work than the open-only sample above.

## Contract changes to copy

- Hook events: optional normalized `model` on session start; a rendered block's
  id names committed receipt rows through `deliveries.block_id`.
- Local record: hooks schema version 2, the epoch/delivery columns, aliases,
  bounded pruning, database/file heartbeat fallback and delivery cache above.
- Entry file: no change in this slice. There is no successor metadata field.
  Native coverage markers and InstructionsLoaded belong to the next slice.

## Remaining slices

Moment matching and per-tool checkout resolution precede snapshot candidates.
Hard gates include scope, verdict, presence/aliases, native coverage and consent.
Verdict forms withhold broken text and turn changed code facts into real current
code pointers. Main admission adds the rising bar and per-moment form choice;
the small renderer emits one committed marker block. Batch collection and the
reserved lane follow, then recovery/resume/rewind/subagent briefs. A final
deterministic corpus and demo qualify the complete controller.
