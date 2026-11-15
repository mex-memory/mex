# Delivery controller

## Surfaces and efficacy

`native/record/surfaces.go` defines the closed surface vocabulary. Read pitfalls,
read-risk rules, edits (including rejected alternatives and file creation),
command recipes, failure fixes, prompts, start briefs and recovery keep their
existing `on` default. Recovery includes subagent briefs and corrections.
New rescue, history and future card surfaces default to `trial`; the
previous start-brief selection is a comparison that stays `shadow`. Unknown
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

## Ranking and observations

`delivery.scorer` selects `tiers` (default), `bm25`, `fcfs` or `risk`.
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
race window. Full/one-line strings include derived labels. Token estimates use
max(UTF-8 bytes/4, whitespace words x 1.3), rounded up. No offline tokenizer
was available for calibration.

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

## Surface ledger and contention

Every receipt has one closed surface id (`native/record/surfaces.go`). Existing
surfaces default to `on`; new rescues, history and comparison surfaces default
to `shadow`. `delivery.surface.<id>` accepts `on`, `shadow` or `off` globally
or per project. The complete map shares the scorer's small hook mirror.
`MEX_DELIVERY_SURFACES` overrides the map for deterministic tests. An off
surface is filtered before opening SQLite. Shadow selects and spends the same
virtual budget as a live send, commits the same receipt except its action,
and renders nothing.

Schema 7 stores immutable targets and incremental, forty-tool-call windows.
The window ends at forty calls or epoch closure. One firing is a surface's
block, even when it contains several entries; it is acted on if any of those
entries is used. First versus repeat is claimed atomically per session and
agent. Commands are exact digests; paths and scopes are checkout-relative.
The acted definitions are executable Go tables with fixture streams.

Reports show the base kind with its rate: shadow first, then held-back, then
time-matched suppressed candidates. The latter means an otherwise eligible
entry suppressed by epoch dedupe, with the actual target it would name. Empty
matches have no knowable target and create no artificial negative control.
The false-send estimate counts settled firings with no observed use. None of
these observations proves a causal effect.

Gate constants are stored before the first firing: thirty settled live
firings, thirty percent acted, a Wilson 95% lower bound above the available
base rate, and repeat use at least first use. Evaluations use disjoint batches
of new live observations. Missing base or repeat evidence keeps a passing
candidate collecting. Two efficacy failures turn the surface off, preserve
knowledge, and claim one person-facing notice. Offline playback cannot advance
a gate. Configuring `on` does not silently erase a stored off decision.

`mex what --surfaces` and the replay use the same Go report. Telemetry accepts
aggregate counts only. A saved session without MEX measures coincidence,
not effect.

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

`node scripts/delivery-demo.mjs` builds the binary, makes a throwaway repo and
MEX home, and sends Claude Code payloads: a read of a file with a pitfall, a
command that has a recipe, a failure with a recorded fix's signature, then the
same three again. It prints three deliveries, each once.

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

## Left for later tickets

Pattern automata,
the speed bump and edit checks for rules and code facts (delivery-03);
smaller reads and outputs (delivery-04); the compaction steer and the lever
ledger (delivery-05). The start brief fills the session-start and recovery
slots (knowledge-05); capture fills "where we left off" and writes recorded
fixes (learning-01), which need a check to be sent.
