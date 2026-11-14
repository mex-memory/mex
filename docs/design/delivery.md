# Delivery controller

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
  this agent. No mirror means no hints.

## Verdicts

| Kind | held | changed | broken | unknown |
| --- | --- | --- | --- | --- |
| rule, decision, pitfall, procedure | full | full | withheld; one correction if given this epoch | full |
| fact | full | pointer to today's code | withheld | pointer |
| recipe | full | full while its script exists, else re-derived | re-derived, else withheld | full while its script exists, else re-derived |
| hint (observed) | full | withheld | withheld | withheld |
| team hint | full | withheld | withheld | full |
| personal note | full | full | withheld | full |

A pointer names the symbol and its current line range from the file index
(or the file when the symbol can't be placed) and never repeats the claim; no
location means withheld. Re-derivation reads the recipe's manifest and up to 63
workspace manifests (`packages/*`, `apps/*`, `libs/*`, `services/*`), scores
script names by shared name parts and the recipe's own words, and answers only
when one script wins by a clear margin. An observed hint with no checks has an
unknown verdict and is withheld, so recorded fixes need a check to be sent.

## Admission and form

Candidates are packed per reply: failure fixes first, then trigger strength
(exact pattern, command, file, folder, prompt), then evidence. The first item
goes in full when it fits under the 600-token moment ceiling, the rest in
one-line form; items that don't fit are logged as held back. Companions travel
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

## Remaining slices

A deterministic knowledge corpus with its gate and a demo script qualify the
complete controller.
