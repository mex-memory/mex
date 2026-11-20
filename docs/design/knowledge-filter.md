# Memory filter and personal consolidation

The filter turns captured prompts and unchecked personal notes into validated
local candidates, then consolidates lasting claims into personal notes. Team
publication, the full evidence rule, Review queue and daily line are later
slices. Model precision and model selection remain the separately authorized
model evaluation.

## Ownership and scheduling

Go retains typed text, command/exit-code rows and edited paths in its existing journal. It
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
including another worktree. The prefix is a cursor only: Go keeps consumed
rows and deletes by retention (90 days or 200 MB) at session start.

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

## Evidence and the working tree

A separate code policy decides which producer-verified evidence can reach the
team: a lasting person statement; two independent sessions for unsure statements;
two distinct authorized, merged PRs for docs/CI/reviews; or an observation with
verified corroboration of the same claim in CI, a script or docs. Repeats inside
one session, pasted/scripted input and delivered-note echoes do not qualify.
The runtime producer here is captured person input. Collection of docs/reviews
and their authority proofs belongs to learn-deeper; the general policy cases
are covered by a deterministic fixture table, not by invented PR observations.

Consolidation transactionally stages one offer per learned note. Previously
consolidated notes are backfilled from their private provenance, never by
adopting arbitrary personal Markdown. The background job rechecks the exact
personal bytes, privacy holds, current native checks, source authority and
repository visibility. GitHub-origin authority is a current write permission or
proof that the signed-in person has merged a PR there. Unavailable authority
stays personal; public or unknown visibility sends session entries to private
Review staging. GitHub lookups happen in the background, never in hooks.

A retained host transcript must contain the exact quote in a unique user message
whose first 1,200 characters match the captured message digest. Assistant/tool
rows do not count. The session/project/host and current delivery ledger are
checked again. A missing, moved, ambiguous or out-of-bound transcript is held;
older session provenance without its message digest is not automatically shared.
Explicit notes retain their existing typed-source proof under their stable ID.

Once the repo shares, eligible entries use the existing exact-diff team writer.
The job queues the diff for its triggering main session and waits for Go's
person-visible-output receipt. The receipt is specific to that session, checkout,
branch and proposed bytes. Source, privacy, consent, checks, team decisions and
checkout inputs are re-proved before publication under the record and Git locks.
The result is an unstaged working-tree file plus a visible status line. MEX does
not create a branch, stage, commit or push in this flow. Recovery recognizes
exact approved output after a write-before-receipt interruption without creating
a second file or repeating the status line.

An existing shared entry is never automatically overwritten by a captured
correction. Retired shared entries stay retired. Potential conflicts with recorded
team decisions are held conservatively when scopes overlap; semantic refinement
belongs to Review. If current write gates would change the verified quote or
fact, the candidate stays personal rather than certifying replacement text.
Undelivered previews time out after five minutes into private Review staging.
The bounded Review list, actions and daily notification line are the next slice.

A project can hold all automatic offers for explicit sharing:

```sh
mex config set learning.sharing manual --project
mex config set learning.sharing automatic --project
```

Automatic mode still requires a shared repo, current evidence, private visibility,
checks, privacy gates and the exact diff receipt. The setting lives only in the
private project record. This adds no entry-file or database schema fields.
