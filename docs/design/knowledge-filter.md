# Memory filter and personal consolidation

The filter turns captured prompts and unchecked personal notes into validated
local candidates, then consolidates lasting claims into personal notes. Team
publication, the full evidence rule, Review queue and daily line are later
slices. Model precision and model selection remain the separately authorized
model evaluation.

## Ownership and scheduling

Go retains typed text and command/exit-code rows in its existing journal. It
atomically replaces one metadata file per session under `filter-sessions/`:
project, checkout, host, session id, last activity, explicit finish status, and
host transcript reference. Only SessionEnd marks finished; later prompts clear
it. The existing per-hook heartbeat detects other activity, including activity
after a finish marker, without adding writes to ordinary tool hooks. Finish
and heartbeat comparisons retain nanosecond precision.
Session start and pre-compaction atomically replace a bounded checkout
request under `filter-pending/`. Neither file contains message or reply text.
Subagents do not request learning. Redirected directories are refused. Hooks
never wait for a model and never write Node's database.

Node validates the registration and controls, then queues the `filter` project
job. It reuses the existing project claim, machine-exclusive learning lane,
dead-process recovery, and automatic model allowance. A fresh eligible request
from another host or checkout can replace an automatically waiting job while
preserving unread input; running and explicitly paused work are not replaced.
Requests remain durable;
Node acknowledges their exact generation without unlinking a concurrent Go
replacement. A pass without eligible input finishes without a model call. A
later session/pre-compaction request revisits deferred input.
Requests retain their triggering session; the shared session-pause guard also
holds learning from older sessions while that requesting session is paused.

Cheap lean runs admit any eligible session; otherwise at least 20 pending typed
messages or an oldest message of 24 hours is required. Explicit unchecked notes
can be enriched independently. Recent activity excludes a session for ten
minutes unless it explicitly finished. Pre-compaction requests still respect
that exclusion; they never block compaction. Batches contain at most 64 messages
and eight unchecked notes. Every message is capped at 1,200 Unicode characters,
without a keyword filter. Bounded current configuration and explicitly named
repository files provide check context; they never provide person evidence.
The job checkpoints its scan after each 4,096-row page, so a full page of
active or already-acknowledged sessions cannot hide later eligible messages.
The next request starts from the beginning and revisits previously active rows.

## Sources and checks

Each response names a supplied message or existing note and copies a contiguous
quote from that source. Code verifies the quote separately for each message,
rejects hidden characters and secret-redaction placeholders, and validates the
entry shape. Task items are discarded before any result is persisted. Remaining
items retain the task/continuity/durability label, captured marks, session and
row reference, supplied privacy assessment, and delivered-note IDs. These are
inputs to later evidence enforcement, not authorization to share.

The worker can read a bounded tail of the host's own JSONL transcript under its
configured session root. Only a unique matching user message associates the
previous assistant tail. Missing, ambiguous or unreadable context is explicit
as null. Replies are transient prompt context; they never enter the journal,
saved candidates or source quotes; replay identity uses only their digest. Tool output and file contents
cannot satisfy quote verification.

The same model call proposes the kind and check targets. The native evaluator
alone records observations and file hashes. Failed lasting-item checks receive
one repair attempt, retaining the original source and claim. The attempt is
durable before invocation; a crash cannot buy additional repair attempts. A
budget hold preserves the first response and leaves the repair eligible. An
unrecordable claim remains marked `needs_checks`: a personal note is not a
certification that its claim holds in code. Explicit notes retain their original
ID and exact input hash; consolidation refuses a changed or retired source.

## Durable results and journal consumption

No database schema or entry-file contract changes. Node uses bounded
project-scoped settings for versioned `filter.batch.<input hash>` drafts and
results, per-session `filter.session.<session hash>` acknowledgements, and
`filter.note.<entry id>` enrichment input hashes. Staged batches and deferred candidates stop before
128 batches or 8 MiB. Consolidation releases completed batches; continuity or
unresolved source/gate context moves to bounded private pending data. One result is bounded
to 512 KiB; prompts to 256 KiB. These are implementation bounds, not measured
quality or cost claims. Logs and generic job summaries contain counts and fixed
diagnostics, never prompts or replies.

Complete candidates and session/note acknowledgements commit in one Node
transaction, after rechecking source, checkout, consent, activity and delivery
inputs. Cached drafts avoid another initial call after a repair hold or lost
job checkpoint. Native baselines are checked again before publication.

The existing `journal.consumed` contract remains a **fully consumed prefix**.
Node walks journal rows in order, stopping at the first typed row not covered
by its session acknowledgement. Commands need no filter and can advance the
prefix. A later finished session never acknowledges an earlier active session,
including another worktree. Go alone prunes through the safe prefix on the
next session start, preserving its existing ownership and cap.

TOML configuration parsing already exists on the base branch. Dependency
membership checks need a separate entry/check contract amendment and are not
introduced here. Team publication and Review consume the private provenance
and privacy metadata in subsequent slices.


## Personal consolidation

The same project job drains completed batches before extracting more input. A
cheap, capped model call groups candidates against at most 64 relevant existing
notes/seen-once observations. It selects identities and corrections; it cannot
write facts, source quotes, checks, dates or files. Code validates every member,
stable explicit-note ID and target. Grouping is cached before publication, so a
cap wait or failed publication does not buy the same grouping again.

Duplicates produce one active note. Later corrections win by captured timestamp
and row; old text and its exact source remain in a retired canonical copy with
its creation date and replacement date. Existing duplicate files are retired in
the copied store, without claim tombstones that would suppress the winning note.
An older batch cannot replace a newer statement. An uncertain observation stays
private as seen once; an independent repeat in another session can make it
lasting. Repeats in one session, pasted/scripted text and delivered-note echoes
do not provide new person evidence. Unavailable delivered context remains pending.
Next-session items remain private pending data for continuity integration.

Publication builds and validates a full sibling copy of the personal notes
directory. Under the record writer lock it proves the original snapshot and
current check inputs, fences readers with a pending manifest/revision, swaps the
directory, then commits metadata and the receipt. Any pre-commit failure restores
the previous directory. Background recovery uses the durable receipt to finish a
committed swap or restore the previous copy after an interrupted writer. Reads
never repair storage. Node readers and native delivery/check loaders withhold a
pending or changed snapshot; native light-cache identity includes the revision.
Manual note creation, edits, judge fixes and upgrade imports use the same writer
lock. Redirects, unexpected files and unproved recovery copies are refused rather
than recursively removed. No entry schema or canonical file location changes.

## Privacy holds

Code scans new candidates for secrets, carries the original message's private-tag
flag, and checks capitalized names, hosts and emails against a bounded repository
vocabulary. Learned files cannot attest to their own vocabulary. Unknown words
remain held when a repository file is unavailable; older candidates without the
source tag flag get an uncertainty hold. The filter's AI privacy question adds
another independent hold. Holds are sticky across duplicate merging and
seen-once promotion, with fixed reasons in private record settings. Every output
in this slice stays personal; no hold grants authority to share.

The vocabulary scan is conservative, not an entity-recognition guarantee. Model
classification quality and plain-word private facts still need the separate
model evaluation. Deterministic fixtures use fake model responses and exercise
rollback, recovery, corrections, duplicate retirement, privacy holds, uncertainty,
cap holds and source/consent changes without live model calls.
