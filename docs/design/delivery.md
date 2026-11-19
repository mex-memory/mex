# Delivery controller

## Surfaces and efficacy

`native/record/surfaces.go` defines the closed surface vocabulary. Read pitfalls,
read-risk rules, edits (including rejected alternatives and file creation),
command recipes, failure fixes, prompts, start briefs and recovery keep their
existing `on` default. Recovery includes subagent briefs and corrections.
New rescue, history, card and working-set start-brief surfaces default to
`trial`. Handoff and "where we left off" blocks have the `carry` surface, on.
A delivery path the ledger doesn't know yet maps to `unknown`, which also
stays on: the ledger measures surfaces and never silences one by omission. Unknown
historical moments migrate to `unknown`.

A `trial` surface is shadow until 30 of its shadow firings have settled, so its
base rate is measured before anything is sent. From then on each session is
assigned to the sending arm or the shadow arm by a stable hash of session,
agent and surface: one session never mixes arms, and the shadow arm keeps
measuring the base rate alongside the sending one. That makes the comparison
a randomized one rather than a coincidence rate. A passed gate turns the
surface on for every session; two failed batches turn it off. `shadow` never
sends; `on` always sends while its gate allows.

`mex config set delivery.surface.<surface> on|shadow|trial|off [--project]` uses
the same global/project settings and mirrors as the scorer. Mirrors carry a
`surfaces` object. `MEX_DELIVERY_SURFACES` accepts a whole-surface override or
a JSON object for deterministic tests. Policy files are read only after an
eligible candidate exists. An explicitly off candidate is filtered before
opening hooks storage. Gate-off markers are derived from committed SQLite
state; a missing marker can cost a database check but cannot authorize a send.

Shadow uses the live selection, shaping, packing, locked admission, budget
debit and dedupe. Only the receipt action changes; its rendering is empty.
Shadow entries count as virtually present for later shadow selection and recovery.
Live recovery never corrects or recovers an item that was only shadowed.
Immutable receipt targets describe the exact observation to test, so changing
an entry after delivery cannot rewrite the outcome. No observed prompt, edit
body or command is retained; command targets are exact-command digests.

Acted is positive evidence in the next 40 original tool calls of the same
session and agent, ending at epoch closure if sooner. Batch tools count once
each; derived shell-read views and patch files do not add calls. The first
successful scoped edit settles a read/edit rule: it either avoids every
recorded literal or edits an explicitly named file. Missing edit text cannot
prove avoidance. A recipe needs its exact command to run, even if it fails;
a failure fix needs a recorded fix command to run or a proven successful
identical rerun. Claude success batches prove success; an unlabelled Codex
shell result does not prove a rerun or file open succeeded. Prompt,
start and recovery items need a scope open/edit. A rescue needs a named path
or identifier. Unknown command exit status never proves a successful rerun.
Cards reserve an id but require a later replacement-specific acted definition.

Three controls are retained separately: shadow, held-back, and time-matched
suppression. The last records an actual eligible candidate suppressed by
epoch dedupe, once per entry/epoch, with the same acted target. Empty candidate
sets get no invented target or control row. The report chooses a settled
shadow base first, then held-back, then time-matched suppression, and exposes
all three counts. These are conditional coincidence rates, not randomized
causal controls. A base with no settled windows is reported as unavailable.
One firing is one surface/block/action, with separate receipts and targets for
its entries. A firing settles once all its windows settle and counts as acted
if at least one named item was used. First/repeat is per surface/session/agent/
checkout; items in the same block share the firing's classification.
The first block is an atomic SQLite claim, independent of session length.

The stored gate is fixed before admission: at least 30 settled live firings,
acted at least 30%, a Wilson 95% lower bound strictly above the control rate,
and repeats no worse than first firings. Missing controls/repeats keep
collecting after the primary efficacy checks. An ineffective first-only
surface can still fail. Surfaces that fire once per session by construction
(the start brief) have no repeats, so the repeat rule doesn't apply to them. Evaluations use rollup deltas of at least 30 new settled
live firings, with cumulative first/repeat populations; revisiting old evidence
cannot count as another failure. Two
consecutive failed batches turn the surface off and claim one person-facing
notice atomically on a capable event (otherwise at the next lifecycle open).
Knowledge is never deleted. Shadow-only evidence cannot
promote a surface, and offline replay cannot advance any gate.

`mex what --surfaces [--json]` reads the Go projection: live/shadow firings,
settled acted rates beside their named base rates, first/repeat counts,
estimated tokens, false-send estimate (settled windows with no acted evidence),
and gate state/reason. Daily telemetry receives aggregate counts only.
The pre-existing probe-based false-send estimate remains available in `mex what`.

A tool call that delivers nothing and only adds evidence to open windows
doesn't open SQLite: it appends its observations as one JSON line to
`surface-pending/<session-agent hash>/observed` (one append, no
read-modify-write). The next transaction that happens anyway (a delivery, a
lifecycle event, session end) claims the log by renaming it, so two
transactions can never settle the same calls, and settles the logged calls in
order before its own. A transaction that fails puts them back; a log over
512 KiB, or a call it can't be written for, settles in a transaction as
before. Retiring the hint drops the log, since no window is left to settle.
Measured on Windows, paired against `next`: calls inside an open window went
from +13.9 ms to +2.2 ms at p50.

Pending windows and rollups are SQLite state. A per-session directory is only
an existence hint to avoid opening storage on an ordinary tool miss. Its active
marker is created while holding the writer lock. Retirement keeps a unique
guard until commit; rollback restores active, and a crash leaves a conservative
hint. Post-commit cleanup cannot remove another writer's active marker. There
is no shared JSON counter. Work is bounded to current pending windows, not
historical events. Non-tool no-op events still return before this hint lookup.

`scripts/delivery-replay/run.mjs --surfaces-shadow` forces every surface to
shadow and uses the same Go report. Saved sessions without MEX measure
coincidence, not effect. Historical tool commands are never executed.

### Contention

An epoch records candidate tokens, admitted tokens, its budget and budget-only
holdbacks. Candidate demand is the largest rendered size offered per canonical
entry and checkout in that epoch, after identity, verdict, native coverage,
similarity and dedupe checks. A repeated rejected offer cannot inflate demand.
Moment-size holdbacks are included in demand, but do not count as epoch-budget
holdbacks. Companion sizes are included individually; a rejected family counts
as one held root bundle. Budget-only means capacity failed while the scorer
would admit it. A scorer rejection, including one also exceeding capacity,
does not meet that definition.

Admitted tokens include live and virtual shadow selections, reserved corrections
and existing exemptions. Those lanes can exceed the ordinary budget by policy;
offered over budget alone does not prove the scorer constrained selection.
Contention is the share of measured epochs with offered tokens above budget,
reported with actual budget-only holds. Pre-migration epochs are explicitly
unmeasured. Epochs belong to the session's primary checkout because its budget
is shared across checkouts; per-checkout demand is claimed separately within
it. The view covers retained epochs and does not invent a lifetime denominator.

### The working-set start brief

The background job `working-set` (`src/working-set/`) computes each
checkout's working set and caches it as
`projects/<id>/working-set/<checkout key>.json`, the key the file index uses.
It runs on request: at session start the brief reads the cache and the
checkout's `.git` files (branch and commit, no git process), and when the set
is missing, from another commit or branch, or older than ten minutes, it
writes `working-set-requests/<project>~<key>.json` and touches
`working-set-pending`. The hook starts the background process after delivery,
so a request made by the brief is picked up at once. The brief never waits:
a set from an older commit of the same branch is still used, and one from
another branch is not.

Seeds, in order, at most 30: uncommitted and staged files (`git status`),
files the previous session on this checkout edited (`epoch_files`) and files
committed since it started, then the branch's diff against the default branch
(`origin/HEAD`, else `main` or `master`). One hop, at most 100 files: relative
imports in both directions from the file index, then each seed's co-change
partners, at most 25, most supported first. Co-change comes from the
project's change-together facts (`code-facts.json`, the code-facts job's one
walk over the last 2,000 non-merge commits, re-read when HEAD moves), so the
working set reads no history of its own and history is walked once. That
walk also writes the fix table for the bug-history notice. Branch-name words
are split on `/ - _ .` and case changes, at least three letters, generic
words dropped. Git runs without optional locks, so the job never rewrites the
person's index.

An entry's relevance adds up per link and is capped at 1: a scope naming a
seed file 0.6, one naming a hop file 0.3, a directory scope at least two
folders deep half of those, and a branch word in its one-line 0.4. A
top-level directory scope (`src/**`) links nothing. A repo-wide scope gets
0.5, and at most two repo-wide team entries go out. The score multiplies in
confidence by evidence (person 1, CI 0.9, docs 0.85, review 0.8) and
`1 - 0.6 × staleness`, where staleness is 0 for a held check, 1 for a changed
one and 0.25 with no usable check. Nothing under 0.20 is sent. The brief keeps
knowledge-05's bound (300 tokens counted as UTF-8 bytes) and at most 6 lines;
a group that doesn't fit is skipped and the next tried. Observed hints the
hint gate allows, and entries proposed but not in force, can only appear in a
separate "Not yet accepted:" lane of at most 2 lines and 120 bytes, which never
displaces accepted entries.

With an empty working set the brief keeps knowledge-05's folder selection and
nothing is compared. Otherwise both selections are computed and the choice is
itself a trial: by a stable hash of session, agent and surface, a session is
sent either the working-set choice (`start-brief-working-set`) or the folder
choice (`start-brief`), and the items of the choice not sent are recorded in
shadow under their own surface. Both arms send something real, so there is no
base-rate period: the ledger compares two randomized arms directly.
`delivery.surface.start-brief-working-set` `on` or `off` forces one choice;
`shadow` sends the folder choice and records the working-set one. The lane
belongs to the working-set choice. Compaction and resume keep their own blocks.

### Rescues

Three rescues answer moments where agents get stuck, from the file index only
(`native/delivery/rescue.go`). Each is pointer-shaped, has its own surface and
starts in trial.

- `rescue-wrong-path`: a read or edit (or a Codex shell read) of a path that
  doesn't exist names up to two indexed files with the same name; with more,
  only those sharing the most trailing folders with the failed path, and
  silence if still more than two. Silent after an interrupt, when the agent
  already got "Did you mean", when the file exists, or outside the checkout.
- `rescue-search`: a search that returns nothing, with at least two words in
  its pattern (split at non-letters and case changes), names up to two
  definitions spelled as the pattern, camelCase, PascalCase, snake_case or
  SCREAMING_SNAKE, in that order; the first spelling that names something
  decides, and a name defined in more than 5 files says nothing. Only
  definitions inside what the search covered count: a search that found
  nothing is rescued by a spelling it missed there, and a definition elsewhere
  is a guess. Regex-heavy patterns and searches of one non-code file are
  skipped. A glob that matches nothing names files with its literal file name.
- `rescue-wide`: a search with 1 to 13 result lines speaks only when the best
  definition inside what the search covered is in a file the search didn't
  return (a set difference).

A search with a file filter (Claude Code's Grep `glob` or `type`, carried as
the tool input's `filter`; `rg -g/-t`, `grep --include` and the like on
Codex) gets no search rescue: the agent chose which files to look at, and a
pointer outside them is noise. The saved-session census found every early
wide firing to be a scoped or filtered search.
- `rescue-glob-timeout`: a Claude Code glob that timed out is answered from the
  index, at most 30 paths, without brace expansion, silent on no match.

A rescue is acted on when the agent opens or edits a path it named.

### Freshness per file

The file index readers (Go and Node) check each file they serve: when its
time on disk matches neither its last parse nor an edit the hook recorded,
its outline, file info and definitions are left out as "changed since the last
parse". Freshness is never decided for the whole index, so a change elsewhere
in the checkout puts no answer in doubt. Knowledge entries already carry
per-entry verdicts, and graph cards (graph-03) follow the same rule.

### Bug-history notice

When the agent edits a file with at least three fix commits in the code-facts
walk (the last 2,000 commits), the last within 180 days, one line says "History: <file> was fixed N
times, the last <age>." with the age in whole days, weeks or months. At most
once per file and three per session, both checked under the record's write
lock (`SessionOnce`, `SessionMax` on a candidate). The fix history is written
beside the working set as `<key>.fixes`: "MXF1", then 16-byte little-endian
records (FNV-1a 64 path key, fix count u32, last fix Unix seconds u32) sorted
by key, so an edit looks a file up with one open and a binary search. A commit
is a fix when its subject starts `fix:`/`fix(...)` or says fix, fixes, fixed,
bug, regression or crash as a word. The notice starts in trial and counts as
acted on when the agent runs tests (pass or fail) or reads the file's git
history.

## Ranking and observations

`delivery.scorer` selects `bm25` (default), `tiers`, `fcfs` or `risk`.
The existing global settings and project control mirrors carry it; the
`MEX_DELIVERY_SCORER` environment override is intended for deterministic
comparisons. Tool misses do not read settings; only a pending acted window or
a covered edit makes a miss open the observation ledger.
The same scorer orders candidates and supplies admission values. FCFS uses
only the budget; the other settings retain exact-match exemptions and the
rising bar, including its increase after the session ceiling.

Packing uses full forms while the 200-token target permits, then complete
one-line forms, with a 600-token ordinary ceiling. Estimates include appended
ids and the block marker. Companions travel with an admitted parent and their
cost is checked with it. Context remains append-only and contains no clock
times. Broken entries are withheld; changed code facts become pointers.

Similarity runs before the cut and again under the ledger lock. It compares
stemmed, stop-word-filtered word sets over the one-line and body, requiring
0.95 containment and either the same kind or overlapping scope. Numbers and
negative words must agree. This deliberately favors avoiding false merges;
it does not recognize most paraphrases. Native rule text is read with existing
per-file bounds and a 1 MiB aggregate bound. `withheld` receipts carry a
`similar` detail instead of adding another action value.

Conflict detection is narrow: opposing literal triggers, different observed
values at an identical check target, or different commands for the same
recipe command name in overlapping scopes. Personal notes precede native
instructions, team entries and hints; evidence then id breaks ties. The
winner names the other id in one line. Go writes `delivery_conflicts` in the
same transaction as admission; Review/Hub consumers can read that table.
Prose disagreement and the person's implicit experimental preference are
not inferred.

Typed prompts use the shared Go lexical ranker, also called by `mex recall`
through `mex-hook --recall`. BM25F normalizes each field separately; title
and derived aliases have weight three. Exact identifiers, query coverage,
score gaps and other bounded features feed a small L2 logistic abstain gate.
At most two candidates pass. Weights in `rank/frozen.go` were trained only
on development prompts after five-fold validation; the sealed split was
not read. Structural task notifications, standalone tool/log output and slash
expansions do not create prompt moments. Exact decision and recipe moments
remain separate. Recall applies its truth/privacy gates before ranking and
reports legacy fallback in JSON when the native binary is unavailable.

Prompt calls reuse one ranking result. A prompt-only `.rank.bin` cache next
to the light snapshot stores term frequencies, document frequencies, lengths
and exact-match metadata, validated against the listing stamp and entry
hashes. It omits original title/body strings. Tool misses never read or build
it. A cache miss builds once from the full snapshot; an admitted candidate
loads only canonical selected entries, companions and prior entries needed
for similarity, proving containment, regular files, hashes and active ids
again. The optional BM25 admission setting retains its full corpus load. Ordinary
hooks use no embeddings; the offline study scripts remain reproducible.

Prompt statistics use a bounded, versioned `.rank.bin` cache, preserving the
same scores and metadata checks as the statistics representation. No source
prose is persisted there; canonical selected text is still proved afresh.
`--delivery-trace` emits diagnostic phase durations to stderr only, including
record open, lock, reads, admission/write and commit. Deadlines are unchanged.

Epoch intent starts as `investigating`; an observed edit establishes
`working`, literal removal can establish `changing`, and conservative typed
shortcuts can establish `changing` or `reproducing`. A structured dependency
removal from package.json establishes changing; an isolated JSON property
deletion is insufficient evidence. An unchanged rerun of the latest observed
failing command establishes reproducing on an existing record path. This
observation stores only an epoch-local digest, never the command.
Investigating rules wait
until edit risk. Removing a convention can deliver it once as the current
convention, without inventing an area usage count. Branch-name inference,
manifest removal and unchanged-failure rerun detection are not implemented.

Receipt probes observe exact recipe commands, written anti-patterns, explicit
opened/wrong actions and subsequent scope touches. They run only on paths
that already open storage. Explicit CLI feedback uses the Go writer and
abstains when the active context is ambiguous. Counts feed local telemetry
and risk; they never delete entries. Generic corrections are not guessed.
The estimated false-send projection uses only closed epochs with neither a
followup nor later scope touch; unobserved events limit that estimate.

`mex what [--session id] [--json]` reads receipt titles and counts without
creating or migrating storage. An exact, trimmed, case-insensitive typed
`mex what` is consumed with one person-facing `MEX ·` line and no model
context. It works through the existing prompt-consumption capability.

`scripts/delivery-replay/` converts saved transcripts into normalized events
and feeds the real binary's controller. It never executes saved commands or
applies historical edits. Replays use current, copied source/check/rule files,
so session-level labels are useful-at-some-point comparisons, not historical
code-state or timestamp ground truth. Semantic output excludes random ids and
timestamps; latency lives in a separate report. The synthetic fixture checks
byte-identical output for all four settings. Offline model and ranking studies
default to development data; only the reviewer should invoke `--split test`.

The Go shim calls `native/delivery.Handle` after its existing checkout,
off-switch and session-pause gates. The controller is silent by default: a
note goes out only when its moment comes, every hard gate passes and its
verdict allows it, and the ledger admits it in the same transaction that
records it. Events with no moment return before any snapshot read or SQLite
open; events whose moments find no candidate return before SQLite.

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

Source metadata is inspected on every full load, including additions and
removals; an in-place edit cannot be discovered from a directory timestamp
alone. Parsed entries are reused by size/mtime with the evaluator's two-second
race window. Full/one-line strings include derived labels. Token estimates are 2.3 UTF-8 bytes per
token for code and tool output and 4 for prose, rounded up (see the cost
instrument below for the calibration). They used max(UTF-8 bytes/4, words x 1.3)
before the calibration.

Scopes in the common shapes (a plain path, `dir/**`, `**`) match without a
regular expression; other globs compile once per distinct scope in a load.

**The light snapshot.** Every call with a moment reads only a light index
(`delivery-entries/<key>.light.bin`): each entry's id, kind, level, scope,
`when` triggers, command-check targets and one-line form, with no text. It is
valid while a stamp over the stores' listings is unchanged: a hash of every
entry file's name, size and modification time, read from the directory
listing alone (one handle per folder), and while no file is newer than two
seconds before the index was written. Any change, or an unreadable index,
falls back to the full load, which rewrites both files. The full snapshot (with
text) is loaded only after a moment found a candidate that this epoch doesn't
already have.

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

All on one Windows 11 laptop that was also running other builds (Go 1.27),
so absolute numbers are high; compare columns, not machines. On CI's
windows-2022 runner the no-op shim measured 7.65 ms p50 against 6.84 ms for a
bare process (foundation-03).

Snapshot loads, 500 synthetic pitfalls, `go test -bench 500 -benchtime 1000x
./delivery/entries` (measured):

| Load | per call |
| --- | ---: |
| Full snapshot, unchanged files | 13-21 ms |
| Light index, unchanged files | 2.0 ms |

The full load's cost was file-system calls around each read and decoding
the JSON cache of all entries; compiling 500 scope globs added about 4 ms
before scopes matched without regular expressions. The light index uses a small
length-prefixed binary encoding (`native/internal/binenc`): JSON decoding
alone was 5 ms of 8 ms, and `encoding/gob`, tried first, adds about 0.5 ms of
package start-up to every hook call. With it the light load is 2.0 ms.

Whole process, Claude Code `PostToolBatch` of Read calls through the real
binary, 200 interleaved runs each,
`MEX_DELIVERY_MEASURE=1 go test -run TestDeliveryBatchTiming ./cmd/mex-hook`
(measured, ms):

| Entries | Tools | bare p50 / p95 | no match p50 / p95 | repeat match p50 / p95 |
| ---: | ---: | --- | --- | --- |
| 50 | 1 | 19.97 / 31.02 | 30.37 / 41.26 | 38.41 / 55.41 |
| 50 | 4 | 19.80 / 28.18 | 31.19 / 42.08 | 40.00 / 52.66 |
| 50 | 10 | 20.50 / 26.94 | 34.79 / 45.74 | 42.88 / 55.87 |
| 500 | 1 | 19.58 / 24.48 | 30.83 / 37.58 | 38.57 / 46.64 |
| 500 | 4 | 19.07 / 25.09 | 30.93 / 37.22 | 38.64 / 45.89 |
| 500 | 10 | 19.68 / 25.00 | 33.82 / 41.58 | 41.96 / 52.13 |

"No match" reads files no entry covers: no SQLite is opened. "Repeat match"
reads files whose pitfalls this epoch already has: hooks.db is opened and the
presence read answers, without loading text. The no-op shim on the same
machine runs about 7 ms over the bare process, so a batch that matches
nothing costs about 4 ms more than a no-op, and the cost no longer grows with
the number of entries. Before the light index, 500 entries cost 39.8 ms p50
for one tool (no match).

The same test on Linux (WSL 2, Ubuntu, Go 1.27, 200 interleaved runs each,
measured, ms). The no-op shim there measured 7.95 p50 / 9.72 p95 against 4.54 /
5.36 for the bare process:

| Entries | Tools | bare p50 / p95 | no match p50 / p95 | repeat match p50 / p95 |
| ---: | ---: | --- | --- | --- |
| 50 | 1 | 4.69 / 10.97 | 9.12 / 12.70 | 12.79 / 19.63 |
| 50 | 4 | 4.78 / 8.81 | 9.39 / 14.57 | 13.26 / 22.00 |
| 50 | 10 | 4.57 / 6.87 | 9.57 / 12.55 | 13.97 / 20.07 |
| 500 | 1 | 4.63 / 5.92 | 14.13 / 18.86 | 17.51 / 22.25 |
| 500 | 4 | 4.46 / 5.76 | 13.68 / 16.69 | 17.46 / 20.48 |
| 500 | 10 | 4.60 / 5.92 | 15.17 / 19.12 | 19.58 / 23.70 |

On Linux the listing stamp costs one `lstat` per entry file (Windows gets
size and time from the directory read itself), so 500 entries add about 5 ms
over 50. A checkout with hundreds of entries in one store is the case to
watch; a stamp per kind folder would cut it if it matters.

Opening SQLite exceeds the 3 ms p95 heartbeat allowance (OpenHooks plus Close,
200 runs: 3.75 ms p50, 6.15 ms p95), so no-op calls keep file heartbeats.
Transactions update the database sighting when already open; status combines
both sources.

## Moments

| Kind | Moment | Trigger |
| --- | --- | --- |
| pitfall | `read` | First read this epoch of a file in its scope; one whose text says the files are generated also fires at an edit (`edit`) |
| rule | `read-risk` | A read whose text contains one of its `when: anti` literal patterns. A rule with no pattern is never pushed at a read |
| recipe | `command` | A shell command that runs the recipe's command: same tool and script, recipe arguments as a prefix. Package-manager `run`, launchers, leading `VAR=x` and anything after `--` are ignored |
| hint (recorded fix) | `failure` | A failed command whose output contains the fix's `when: anti` signature whole (whitespace collapsed). Near misses stay silent. Codex failures are read from its `Exit code:` header |
| decision | `rejected` | An edit, write or patch that adds the rejected option, in scope or in a manifest; or a typed prompt that names it as a word |
| procedure | `create` | A new file matching its `when: creates` globs (or scope). Creation comes from the payload: Claude's Write response, Codex's `*** Add File` |
| recipe | `prompt` | A typed prompt that asks to test, build, lint, typecheck, format, migrate, deploy or bench brings the recipe whose script names that word |

Facts are not pushed at moments; their edit check is the next ticket's.

Claude Code sends PostToolUse per call and PostToolBatch once per batch of
parallel calls. Moments go out once per batch; PostToolUse delivers nothing
there and stays for output trimming. Failures use their own event everywhere.

## Gates

- **Repo:** each touched path resolves its own registered checkout through the
  hook checkout mirrors; a command uses its literal leading `cd` folder, else
  the shell's folder. A path whose repo is off or unregistered gets nothing.
- **Verdict:** the table below.
- **Once per epoch,** after alias resolution, in the ledger transaction.
- **Native coverage:** an entry read from a rule file the agent loads for that
  path (Claude Code: `CLAUDE.md`, `CLAUDE.local.md` and `.claude/CLAUDE.md`
  along the path, `.claude/rules/*.md`, and `AGENTS.md` where a folder has no
  `CLAUDE.md`; Codex: `AGENTS.override.md` or `AGENTS.md` along the path) is
  not sent; nor is an entry whose id marker `<!-- mex:<id> -->` is in one of
  those files.
- **Hints** observed in agent memory go out only when the Node side's mirror
  `delivery-hints/<short hash of project id>.json` lists them, unexpired, for
  this agent. Node rewrites it after every hint refresh, expiry, confirmation
  and forget (`writeHintMirror` in `src/knowledge/hints.ts`), and removes it
  when it can't be written. No mirror means no hints.

## Verdicts

| Kind | held | changed | broken | unknown |
| --- | --- | --- | --- | --- |
| rule, decision, pitfall, procedure | full | full | withheld; one correction if given this epoch | full |
| fact | full | pointer to today's code | withheld | pointer |
| recipe | full | full while its script exists, else re-derived | re-derived, else withheld | full while its script exists, else re-derived |
| hint (observed) | full | withheld | withheld | full (the mirror vouches) |
| team hint | full | withheld | withheld | full |
| personal note | full | full | withheld | full |

A pointer names the symbol and its current line range from the file index
(or the file when the symbol can't be placed) and never repeats the claim; no
location means withheld. Re-derivation reads the recipe's manifest and up to 63
workspace manifests (`packages/*`, `apps/*`, `libs/*`, `services/*`), scores
script names by shared name parts and the recipe's own words, and answers only
when one script wins by a clear margin. Observed hints carry no checks by
design, so their verdict is unknown; the Node side's mirror, written from the
same eligibility a read uses (the source still holds the claim, not the
agent's own memory, not forgotten, not expired), stands in for it. A check
that runs and doubts a hint withholds it.

## Admission and form

Candidates are packed per reply: failure fixes first, then trigger strength
(exact pattern, command, file, folder, prompt), then evidence. Full forms fill the 200-token target, then complete one-line forms fit
under the 600-token moment ceiling; items that don't fit are logged as held back. Companions travel
in one-line form beyond the ceiling. Under the ledger lock each item must clear
the online-knapsack bar psi(z) = (U*e/L)^z * (L/e) for value per token, where z
is the share of the epoch budget used; past three epoch budgets in a session z
rises by 0.5. Exact matches and failure fixes are exempt from the budget;
failure fixes and corrections use the reserved lane. Withheld and held-back
outcomes are logged once per entry per epoch.

The rendered block is `[mex <block id>]` then one line per item, ending with
the entry id so the agent can ask for more. No warnings and no clock times.

## Session life

- **Epochs** advance at startup, clear, fork, compaction and a new subagent;
  resume keeps the epoch. Compaction's two signals (PostCompact and
  SessionStart `compact`) confirm one transition in either order.
- **Edited files.** An edit, write or patch to a file that some entry's scope
  covers is written to `epoch_files` (at most 512 per epoch). Edits to files
  no entry covers write nothing.
- **Recovery after compaction** goes out on SessionStart `compact`, the
  compaction signal that can carry text on both agents: one-line forms of the
  entries the previous epoch gave whose scope covers a file it edited, newest
  first, verdicts re-checked, within 400 tokens; then the ids of the rest, at
  most 20. Recovered entries count as given in the new epoch. Everything else
  comes back at its next moment. The priority line and "where we left off"
  slots are empty until the start brief and capture fill them.
- **Resume** sends nothing again. An entry given in this epoch that is now
  broken or gone gets a correction; one whose text changed gets its new
  one-line form, marked "Updated". Both use the reserved lane.
- **Rewind (Claude Code).** Before skipping a repeat, the controller checks
  that a block which carried the entry is still on the transcript's active
  branch: the chain of `parentUuid` links from the newest message. The answer
  is cached per transcript (`delivery-transcripts/<hash>.bin`) and updated from
  appended bytes; a new branch re-walks the stored links. A block the
  transcript never mentions, a transcript over 64 MiB, or more than 16 MiB
  appended since the last look all answer "still there": no resend on doubt.
- **Subagents** have their own ledger and a 600-token budget. An editing
  subagent starts with one-liners of what the main session was given this
  epoch. Types that only look (`Explore`, `Plan`, `claude-code-guide`,
  `statusline-setup`) get moment items only; unknown types count as editing.
- **Shell reads.** A shell command that reads files (`cat`, `sed -n`, `head`,
  `tail`, `nl -ba ... | sed -n`, the PowerShell forms) is a read of each file,
  so Codex, which reads through its shell, gets read moments too. The output
  is matched for anti-patterns only when one file is read.

## Knowledge bench gate

`scripts/gates/knowledge.mjs` runs the bench through the real evaluator and
this controller (see `scripts/gates/README.md`). Its probe,
`mex-hook --delivery-probe`, runs the verdict stage a moment uses for given
entries, without the ledger. Result on the pinned corpus (46 claims, six
checkpoints of Hono from T0 to T1, measured on Windows, two runs alike):

| Checkpoint | True | Stale | True, full | Stale, full | Pointers | Withheld |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| C0 | 46 | 0 | 46 | 0 | 0 | 0 |
| C1 | 43 | 3 | 38 | 0 | 5 | 3 |
| C2 | 41 | 5 | 34 | 0 | 9 | 3 |
| C3 | 37 | 9 | 27 | 0 | 12 | 7 |
| C4 | 32 | 14 | 21 | 0 | 13 | 12 |
| C5 | 31 | 15 | 20 | 0 | 13 | 13 |

No stale claim and no broken entry reached the model in full at any
checkpoint. At T1, 65% of the claims still true go out in full; the rest go
out as pointers because their code changed. Evaluator time per checkpoint was
317-752 ms against the gate's 1,000 ms. The corpus is hand-written and small;
the numbers describe this corpus, not MEX in general.

The first run found an evaluator bug: a symbol with TypeScript overloads was
fingerprinted at its first signature, so a change to the method body (here,
removing a cache) left the check held and a stale claim went out in full. The
check now fingerprints all same-named declarations together; a symbol declared
once keeps its fingerprint.

## Demo

`node scripts/delivery-demo.mjs` builds the binary, makes a throwaway repo and
MEX home, and sends Claude Code payloads: a read of a file with a pitfall, a
command that has a recipe, a failure with a recorded fix's signature, then the
same three again. It prints three deliveries, each once.

## Written aliases and asks

The ranker indexes an entry's written `aliases` (x3) and `asks` (x2) as two more
BM25F fields beside the derived aliases; an entry without them scores exactly
as before. `delivery.aliases on|off` (machine-wide, mirrored in `controls.json`,
override `MEX_DELIVERY_ALIASES`) decides whether typed prompts and `mex recall`
use them. It is **off** by default. The keep rule is at least +5 net (helped
- 2 x wrong) with no rise in wrong or false sends, on prompts written blind to
the entries; the only measurement so far isn't blind (below), and wrong sends
rose by one in it.

Measured on the delivery-02 question set with the shipped learned gate
(`scripts/delivery-replay/aids-measure.ts`), helped/wrong/false sends. The
aliases and the prompts were written by the same model family, so every gain is
likely inflated; dev is in sample and the test split had already been used.

| Variant | Dev (210 prompts) | Test |
|---|---|---|
| No aliases | 39/1/1 | 29/6/4 |
| Aliases in the derived field | 46/2/2 | 40/7/4 |
| Written aliases field | 46/2/2 | 40/7/4 |
| Written, through the filter | 43/2/2 | not run |

The filter keeps 135 of the set's 162 hand-written aliases. It drops 15 that
would already send another entry, 9 that lead by less than the margin and 3
that rank another entry above their own. On these careful hand-written aliases
it prevents no wrong send; its job is machine-written ones, which aren't
measured yet.

## Decision capture line

After a commit whose message has two distinct decision phrases (a fixed list,
`native/delivery/decision.go`, the same as Node's), the hook offers one line,
once per session: after a shell `git commit -m`, or at the next session start
from the commit the background process noted. The hook never runs git. Over
the newest non-merge commits of five repositories, two phrases occur in 0.0% to
1.8% of commits (`scripts/measure-decision-trigger.ts`; hono 1.4%, novu 0.1%,
django 1.8%, flask 0.0%, requests 0.1%), so the line is rare. A proposed
decision is delivered only once it is in force.

## Prompt anchors, search answers, lanes and the cost instrument

The reason for this work: in the saved sessions most of the spend goes to the
agent's own search, so delivery now finishes that search instead of ranking
more prose. Everything below fails open, appends only after a tool result and
never edits an earlier message, so the prompt cache stays intact.

### Surfaces added

| Surface | Default | Acted means |
|---|---|---|
| `prompt-anchor` | trial | the agent opens or edits a file the line named, within the usual 40 calls |
| `search-span` | trial | no ranged Read overlaps the answered span in the next 3 calls (avoided) |

`prompt-anchor` covers three lines of one kind: the unique-symbol pointer, the
arm-and-release of scoped entries (below) and the team-phrase pointer. A
`search-span` window needs three observed calls to count as avoided; a session
that ends sooner proves nothing and stays out of the settled denominators.
A Read of other lines of the same file is recorded as a harm signal, not as
acted. The gate adds three settings to delivery-06's fixed gate:
`minimum_avoided_delta` .30 (avoided follow-up reads beat the control by at
least 30 points), `minimum_cost_sessions` 10 and `no_harm_rise` 1 (reads
elsewhere in the same file must not rise). The cost check comes from the
per-task cost ledger that delivery-05 owns; replay never writes it, so without
ten priced sessions a trial surface keeps collecting.

### Prompt anchors

A typed prompt (host tags and machine-written turns already stripped) is
scanned deterministically, within 32 KiB and 24 anchors: paths and
`path:line` (stack frames included), CamelCase and snake_case identifiers (6
characters or more, or with a separator), quoted error strings and backticked
commands. Only anchors the file index verifies survive: a path that exists and
is indexed and contained in the checkout; an identifier `SymbolsNamed` resolves
to at most 3 definitions, fresh on disk; an error string found by a bounded scan
of the first 32 indexed files (256 KiB in all). No index is built or repaired for this.

- **Pointer now.** One identifier with exactly one definition anywhere (stale
  collisions count) sends `path:line signature`, once per prompt.
- **Arm.** An entry whose scope (or a literal `when`) covers a verified anchor
  is armed: a `prompt-arm` receipt held-back, released at the first successful
  touch of its named file (`anchor-touch`), under the normal truth, coverage and
  dedupe checks. The arm survives later prompts without rewriting the earlier
  target.
- **Vocabulary pointer.** When a typed prompt contains a team phrase that
  exactly matches an entry's `aliases` value (case-insensitive, whitespace
  collapsed, word boundaries; the alias is at least 2 words or at least 6
  characters), one line goes out: the phrase, then the entry's verified code
  anchors. Those are the entry's scope paths that exist in the file index (a
  glob counts when it matches at least one indexed file) and up to three of the
  identifiers its text names that resolve to exactly one definition. The line
  never carries the entry's text. At most 2 such lines per prompt, inside the
  prompt lane. An entry with no verified anchor stays silent, and an entry that
  needs the hint gate waits for it. This path reads the written aliases itself,
  so it does not depend on the `delivery.aliases` ranker setting.
- The learned gate remains only as the filter for the remaining prose lane.

### Search answers

After a Grep, or a shell `rg`, `grep` or `git grep`, whose pattern is
definition-shaped (`func X`, `class X`, `def X`, `type X`, `interface X`, `X =`
and similar) or a bare identifier, and only when the file index resolves the
name to exactly one fresh definition (per-file freshness) and the name is
defined in at most 3 files, the hook appends the definition's signature and
body, at most 600 characters, with `path:line-range`. It stays silent when the
span exceeds 600 characters (a useful signature is sent instead), the name
collides, the file is stale, the search was filtered (the index cannot prove the
filter admits the answer), or the search already returned the whole span. One answer per event, eight tools
inspected. The batch that produced the search is excluded from its own
follow-up window.

### Budget lanes and packing

Inside the epoch budget, admission runs per lane under the writer lock:

| Lane | Share | Carries |
|---|---|---|
| critical | 20% | failure fixes and corrections |
| cards | 40% | `search-span`, later graph cards |
| prompt | 15% | `prompt-anchor` and the prose lane |
| brief | 15% | accepted and not-yet-accepted briefs |
| ordinary | 10% | every other moment |

Packing skips an item that does not fit and continues; it never stops at the
first. A card that does not fit as full text falls back to a signature or a
one-line form. Four explicit lane rules are exempt from the lanes and the
scorer: exact pattern matches, failure fixes, edit violations, and a scoped
pitfall at the first read of its file. They may exceed their reserve without
consuming another lane. `DefaultScorer` is now `bm25`; `tiers`, `fcfs` and
`risk` remain overrides.

### Token estimates

Code and tool output use 2.3 UTF-8 bytes per token (one constant per runtime,
Go and Node, with a parity test); prose uses 4. The old estimate was
`max(bytes/4, words x 1.3)` everywhere. Code estimates rise about 74%, and every
token-denominated cap is unchanged, so an indexed file, a graph output or a
card now carries about 42% fewer characters at the same cap. Entry text loses
the 1.3-per-word fallback. The entry snapshot cache and the file-index
extractor version were bumped so cached estimates are replaced on the next
explicit refresh; nothing rebuilds an index on a read.

### The cost instrument

`scripts/delivery-replay/cost.mjs` reads saved transcripts and prices the token
classes of each assistant response once (parallel tool calls share one usage
block) from `prices.json`, the single model price table. Per session it reports
price-weighted tokens, calls to the first edit, shares by tool and shell kind,
floods, and the search-then-ranged-read chain rate (a Read whose range covers a
line a search reported 1 to 3 calls earlier). A task counts as solved when an
edit succeeded, unless an explicit outcome label is passed. It holds no
transcript text.

### What the saved sessions say

Saved sessions measure coincidence, not effect. Numbers with their
denominators; all of them dev data, with the test split untouched:

- Cost instrument, 38 transcript files / 965 calls / 22 sessions with a
  successful edit: exploration-only calls are 62.6% of call cost; the
  search-then-ranged-read chain is 9.7% (103 of 203 ranged Reads); 7.6% when
  parallel chained Reads are counted once. Tool output measures 2.31 characters
  per token above 20k characters (n=2) and 2.20 above 5k (n=143). Median 14 calls
  before the first edit; 81 floods of 50 lines or more and 13 of 8k characters
  or more.
- Anchors, 120 dev prompts: anchors extracted on 44 (36.7%), at least one
  verified on 11 (9.2%), 13 of 89 anchors verified (14.6%), 3 potential
  pointers. One pointer on the 47 prompts with no gold entry (2.1%, under the
  5% line). Required entries available at the first touch of a verified
  anchor: 21 of 77, against 16 of 77 for the prompt channel alone (a proxy, not
  a measured on-time gain: the labels have no touch deadlines). On the 61 real
  typed turns: extracted on 45 (73.8%), verified on 5 (8.2%), 10 of 284 anchors
  verified, 0 pointers.
- Vocabulary pointer, 120 dev prompts: none contain a frozen alias phrase
  (the aliases were frozen before the prompts were written), so 0 pointers and
  0 false sends on the 47 no-gold prompts, and 0 of 61 real typed turns.
  As a positive control only, putting each eligible alias into a generic
  sentence earns a pointer for 94 of the 110 entries that have eligible
  aliases (142 pointers over 162 phrases): most entries have a scope path or a
  unique identifier the index can verify. That shows the line can be built, not
  that people type the phrase.
- Search answers, 38 files / 965 calls / 103 chained Reads: 1 eligible firing
  (0.026 per session), 55 tokens offered, 0 of 103 chain reads covered and 0
  full ranges covered. The snapshots are today's index, not the historical
  file bodies. The replay is flat: the answer would almost never have fired on
  these sessions. The surface ships in trial and the live run decides.
- Lanes, 66 labelled session epochs at the 500-token main budget: only the
  critical lane had demand (38 lane/epoch observations, 4,096 tokens offered
  and admitted, 0 holds). At a 25% budget, a synthetic five-lane rotation
  admitted one 20-token item per lane (30 of 50 offers admitted, 20 capacity
  holds, no lane starved).
- Ceilings, 109 offers over 66 epochs replayed at a 10% budget: every offer sat
  in the critical lane (63 given, 41 controlled as similar, 5 held back as
  investigating), so no ceiling bound (0 of 109) and nothing followed from one.
- Intent shortcut words on the 61 real typed turns: a changing word (replace,
  migrate, remove, rename, deprecate) on 1 (1.6%), a reproducing word on 13
  (21.3%), either on 14 (23.0%).

### Timing

Cold Windows processes, alternating pairs against a `next` binary, 200 pairs
per row, a synthetic repository with one indexed source file, 50 and 500
entries (`scripts/delivery-replay/answer-timing.mjs`). Milliseconds as
p50 / p95, the per-pair difference last.

| Entries | Case | `next` | This branch | Added |
|---|---|---|---|---|
| 50 | typed prompt with anchors | 48.9 / 64.8 | 79.9 / 97.9 | 30.4 / 45.8 |
| 50 | search with a span answer | 51.5 / 65.9 | 74.1 / 92.2 | 22.4 / 39.7 |
| 50 | silent search | 48.1 / 64.8 | 48.4 / 63.5 | 0.3 / 16.7 |
| 50 | no-op tool call | 45.4 / 60.6 | 44.6 / 59.5 | -0.6 / 14.3 |
| 50 | first touch of an armed file | 46.8 / 59.2 | 83.4 / 201.8 | 36.1 / 155.6 |
| 50 | read of a pitfall's file, both deliver | 76.6 / 90.9 | 75.8 / 93.1 | -1.2 / 11.9 |
| 500 | typed prompt with anchors | 54.5 / 67.2 | 81.5 / 92.1 | 27.2 / 37.6 |
| 500 | search with a span answer | 51.5 / 64.3 | 73.9 / 87.7 | 22.4 / 34.9 |
| 500 | silent search | 49.1 / 63.0 | 48.9 / 61.9 | -0.2 / 10.3 |
| 500 | no-op tool call | 45.0 / 58.8 | 44.7 / 51.0 | -0.5 / 4.8 |
| 500 | first touch of an armed file | 47.3 / 61.3 | 79.1 / 92.7 | 31.5 / 46.0 |
| 500 | read of a pitfall's file, both deliver | 86.9 / 97.4 | 77.4 / 89.6 | -9.5 / 0.0 |

`next` sends nothing in the first five cases, so their difference is the cost
of one delivery transaction, about 22 to 36 ms at p50 on this laptop. That is
the same cost `next` pays when it delivers (the last row: 76 to 87 ms against
a 45 to 55 ms call that sends nothing), so the new paths cost no more than an
existing delivery, but a firing call does not meet "about 15 ms p95". The
paths that stay silent do: the no-op and silent-search rows add nothing at p50;
their p95 differences are pair jitter, because the `next` lane's own p95 varies
by about 15 ms. A repeat of 600 pairs found 3 fail-open deliveries
(`record-commit: context deadline exceeded`, an empty reply) in 1,200 prompt
transactions, none in 1,200 read transactions; the cause is not known, and the
live run should watch the rate. On Linux the same four paths run in CI as
`TestAnswerPathTiming`, which enforces 15 ms p95 there.

### Daily false-send counts

At the close of an epoch, once (`epochs.false_send_counted` claims it), the
hook adds two daily counts to `counters_go` per agent:
`knowledge.closed_deliveries` (given or replaced, not corrections) and
`knowledge.false_send_estimate` (the same, with no followup and no later scope
touch). Counts only; the telemetry report schema lists both names. An offline
replay writes none. The estimate is a proxy for absence of evidence, not a
judgement of relevance.

## Contract changes to copy

- Hook events: optional normalized `model` on session start; a rendered block's
  id names committed receipt rows through `deliveries.block_id`.
- Local record: hooks schema version 2, the epoch/delivery columns, aliases,
  bounded pruning, database/file heartbeat fallback and delivery cache above.
- Hook events: `kind` (`add`, `update`, `delete`) on patch files; optional
  `agent_type` on subagent start.
- Local record: `epoch_files` in hooks schema version 2; deliveries keep the
  block id that carried them, and a resend after a rewind is a second
  `given` row in the same epoch.
- Entry file: the native coverage marker `<!-- mex:<id> -->` for entries
  written into agent rule files; a recorded fix is a `hint` whose `when: anti`
  literal is its failure signature. There is no successor metadata field.
- Hint mirror file `delivery-hints/<short hash>.json`, written by Node.
- Hook binary: `mex-hook --delivery-probe` (JSON request on stdin, like
  `--check-run`).

Measured surfaces and the working set:

- Local record: hooks migration 0007 (surface column and the action set with
  `shadow` and `control`; `surface_firings`, `surface_windows`,
  `surface_session_first`, `surface_stats`, `surface_gates`, `epoch_offers`;
  epoch `tool_calls` and contention columns); the `trial` surface state; the
  `surface-pending/` and `surface-off/` hints; candidate `SessionOnce` and
  `SessionMax`; the working-set and fix-table files and the request queue.
- Hook events: `interrupted` on a tool output (Claude Code's `is_interrupt`);
  `filter` on a search's input (Grep `glob`, or `type:<name>`).
- Hook binary: `mex-hook --surfaces`; `--delivery-replay` honours
  `MEX_DELIVERY_SURFACES`.
- File index: readers leave out a file whose time on disk matches neither its
  parse nor a recorded edit ("changed since the last parse"); the Go reader
  gains `PathsMatching`, the Node reader `importEdges`.

Anchors, search answers, lanes and measurement (delivery-02, second pass):

- Local record: hooks migrations 0008 (span windows, gate settings,
  `surface_cost_checks`), 0009 (`deliveries.lane`, `lane_offers`) and 0010
  (`epochs.false_send_counted`); hooks schema version 10, read-only in Node.
- Settings: `prompt-anchor` and `search-span` surfaces (default `trial`);
  `DefaultScorer` is `bm25`; `delivery.scorer` documents the override values.
  `MEX_DELIVERY_BUDGET_PERCENT` exists only for `--delivery-replay`.
- Hook events: none added. New moments `prompt-arm` and `anchor-touch`; the
  span target stores start/end lines and an originating-call digest.
- Files: derived `anchor-armed/<session-agent hash>/<checkout-path hash>`
  hints; light entry snapshot version 2 (written aliases); entry snapshot cache
  version 2; file-index extractor version 2 (token estimates).
- Counters: `knowledge.closed_deliveries` and `knowledge.false_send_estimate`
  in the daily telemetry report, counts only.
- Token estimates: 2.3 UTF-8 bytes per token for code and tool output, 4 for
  prose, one constant per runtime with a parity test.
- Hook binary: `mex-hook --span-study` and `--anchor-study` are read-only
  study entry points; they never open hooks.db.
- Scripts: `scripts/delivery-replay/{cost,spans-replay,anchors-replay,leftovers,answer-timing}`
  and `prices.json`.

## Left for later tickets

Pattern automata,
the speed bump and edit checks for rules and code facts (delivery-03, which
drops its prompt symbol pointer: `prompt-anchor` carries it); the
compaction steer and the single ledger that credits avoided calls and fills
`surface_cost_checks` (delivery-05); callers and tests cards on the
`search-span` slot (graph-03). The start brief fills the session-start and recovery
slots (knowledge-05); capture fills "where we left off" and writes recorded
fixes (learning-01), which need a check to be sent.

## Output levers

Output levers are off by default. Turn them on with
`mex config set levers.output on`; use `off` to turn them off. The global
setting is in Node's record.db settings table and its controls.json mirror.
`MEX_LEVERS=on|off` overrides it for the current process. `MEX_RAW=1` shows
whole output; `MEX_OUTLINE=0` skips outlines and their guards. With output
levers off, hooks skip presentation state, rewriting and lever measurements.
Already wrapped commands still run exactly, with whole output. Compaction
topic nudges keep working independently.

Claude Code can see an outline of an indexed, unchanged, unedited file on its
first unranged read in a context. The cutoff is 10,000 calibrated code tokens,
about 23,000 UTF-8 bytes, close to the tested size cutoff. Code and tool output
estimates use 2.3 bytes per token throughout the outline, trim and ledger.
The outline includes task-relevant slices and says how to read the text.
Its range never exceeds the host's original returned line count. An edit
without a follow-up text read is stopped once. The next full read is made an
explicit range to avoid the host's unchanged-file stub. If a stub still
arrives, MEX returns bounded file text only when it matches the outline's
hash; otherwise it asks for an explicit range. Read-risk scans use the
original returned text, including when a later batch carries an outline and
the file has changed since that read.

Long successful search output is grouped by file, and path listings by
directory. No lines are dropped. Blocks retain input order, including context
lines and separators; a recurring file starts a new block. Ambiguous lines
leave the whole output alone. Tree output stays whole. A grouped view must
save at least 25 percent, including its header. Other noisy successful
commands can be trimmed while preserving warnings, errors and summaries.
The exact original output is saved locally and remains one command away:
`mex out <number>`.

Trimming and Codex rewriting pause while delivery's epoch intent is
`reproducing`. Its `investigating` intent still allows them. An explicit
request for full, raw, whole or untrimmed output in the last typed prompt also
keeps output whole. Commands that failed in this context stay whole on rerun.
Codex commands requesting a terminal are never rewritten.

Go owns hooks.db presentation state. Session/subagent state and machine-wide
outline guard counters update together in one bounded immediate transaction.
Startup prunes old session rows after seven days, in bounded batches. Old
JSON lever files are ignored. `mex on --lever outline` resets the outline
kill switch through the existing rearm path. Node never writes hooks.db.
