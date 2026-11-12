# Contract: the local record (version 3)

Owner: the local record (`src/record/`, `native/record/`).

Everything MEX records about its own work belongs under the MEX home, or the
local database cache described below. CLI, Hub, session lines and reports read
these records. This page covers the two files, their schemas, the usage log,
the own-usage reader, the job model and the background process.

## Two files, one writer each

| File | Sole writing side | Readers |
| --- | --- | --- |
| `record.db` | Node: CLI, background process, jobs | Go and Node |
| `hooks.db` | Go: hook shim, evaluator, trimmer, wrapper | Go and Node |

Both use SQLite WAL. Node writers wait at most 5,000 ms for a lock. Go readers
retain a 10 ms busy timeout and 100 ms SQL operation deadline. Go writers use a
200 ms busy/wait budget within a 250 ms SQL operation deadline. Session writes
use waits of at most 25 ms per attempt, resetting SQLite's exponential backoff
without restarting the total 200 ms budget; this prevents a busy writer from
continually missing short lock-release windows. The remaining operation time
allows commit/cleanup. A lock that remains unavailable returns an ignorable
error. Already-current hooks files need no migration write lock on each open.
Node read-only connections use a 10 ms busy timeout. Hooks never wait for the
background process. A missing, busy, unreadable or incompatible file produces
an error the hook caller ignores, allowing the agent call. Never use SQLite's
`immutable` option for these live databases: readers must see WAL commits.

There is no separate `usage.db`. The machine-wide usage log is `model_calls` and
`own_usage` inside `record.db`. Existing checkout `.mex/graph.db`, `wiki.db`,
`team.db` and Hub jobs are unchanged by this storage foundation.

## Schema and module ownership

`PRAGMA user_version` is each file's schema version. Version 1 is the first
shipped schema. Migrations are numbered, forward-only and applied by that
file's writer, with **one transaction per migration**, including the version
update. A failed migration rolls back its SQL and leaves the previous version.
The writer obtains an immediate transaction and rechecks the version under
the lock, so two first opens cannot apply a migration twice.

Version 0 denotes an empty file or a compatible pre-release subset of the
version-1 tables (identical definitions). Migration 1 creates missing tables
and preserves compatible existing rows. Arbitrary historical layouts are not
a supported migration input; no version-0 schema was shipped. Future structural
changes need a numbered migration rather than editing migration 1.

Current versions: **record.db = 2; hooks.db = 1**. Node migration 2 adds only
own-usage reader bookkeeping and plan-window tables; all version-1 definitions
and rows are preserved. Go's read-only record reader recognizes version 2;
its hooks writer/migrations remain at version 1.

A writer seeing a newer version refuses to write, with the file, found version,
supported version and upgrade instruction in its error. Read-only Node handles
expose `version` and `diagnostic`; Go returns an explicit incompatibility error.
Older readers do not migrate: they read existing compatible tables, returning
normal errors for unavailable tables or columns. All Go APIs return errors,
never deliberately panic; callers must treat errors as an empty hook result.

Node schema and migrations live in `src/record/schema.ts`; opens and typed reads
live in `src/record/index.ts`. Node exposes only a read-only opener for
`hooks.db`, and only opens it when it already exists. Go opens `record.db`
read-only, never creates or migrates it.

The Go module is **`github.com/mex-memory/mex/native`**, at `native/go.mod`.
Import **`github.com/mex-memory/mex/native/record`**. Hooks schema files live
beside their writer in `native/record/schema/hooks/0001_init.sql`, embedded in
Go. This module contains no shim or CLI; the hook shim adds its commands to
the same module. The SQLite driver is `modernc.org/sqlite` **v1.62.0**,
BSD-3-Clause, the latest stable version returned by the module proxy during
this review. It requires Go 1.26 or later; `native/go.mod` declares **Go 1.27.0**
to match the tested toolchain and existing Go CI job. Its `modernc.org/libc`
requirement is kept at the exact upstream v1.80.1. SQLite 3.54.1 itself is public
domain. No C toolchain is required. Upstream publishes its
[complete third-party license inventory](https://gitlab.com/cznic/sqlite/-/blob/v1.62.0/LICENSE-3RD-PARTY.md),
including the separately imported MIT sqlite-vec extension, which MEX does not
import, and the inherited BSD/MIT notices in libc/memory.

Node command entry points call `openRecord({ projectPath })`, then `close()`
in a `finally` block. `writer.checkout(path).project_id` is the authoritative
registered identity; raw `projectIdentity` computes only the fallback candidate.
First registration does not create the per-project data folder. Provisional
promotion can rename an already-existing folder, as described below.
Read surfaces use `openRecordReadOnly()` or `openHooksReadOnly()`; `undefined`
means the file is absent. A handle exposes typed `project`/`setting` reads and
generic read-only `get`/`all` projections. Show a nonempty `diagnostic` plainly.

Go callers first use `ResolveLocation(LocationOptions{ReadOnly: true})` for a
pure read, followed by `OpenRecord(location)` and `defer reader.Close()`.
`CheckoutProjectID(path)` returns id, found, error using only native realpath
and indexed `checkouts` reads: **no Git call on the registered hook path**.
It accepts checkout roots, case/link aliases, and descendants inside registered
repositories, stopping at an unregistered nested `.git` boundary. Only a miss
may use `ResolveProject` as an explicit fallback for an unregistered folder.
`Project(id)` returns a row or nil; `Setting(scope,key)` returns value, found,
error. For the Go-owned writer, use `ResolveLocation(LocationOptions{})` to
create directories, then `OpenHooks(location)`, `PutSession(session)` and
`Session(id)`. Close the handle. Handle every error by returning the empty
hook result; the storage package does not exit the process or print a reply.

The driver's required indirect modules (no additional feature dependency;
target-specific linkage is detailed in the upstream inventory):

| Module | Version | License |
| --- | --- | --- |
| `modernc.org/libc` | v1.80.1 | BSD-3-Clause |
| `modernc.org/mathutil` | v1.7.1 | BSD-3-Clause |
| `modernc.org/memory` | v1.12.1 | BSD-3-Clause (additional attribution notices) |
| `golang.org/x/sys` | v0.49.0 | BSD-3-Clause |
| `github.com/google/uuid` | v1.6.0 | BSD-3-Clause |
| `github.com/remyoudompheng/bigfft` | v0.0.0-20230129092748-24d4a6f8daec | BSD-3-Clause |
| `github.com/dustin/go-humanize` | v1.1.0 | MIT |
| `github.com/mattn/go-isatty` | v0.0.24 | MIT |
| `github.com/ncruces/go-strftime` | v1.1.0 | MIT |

The complete transitive Go module graph for this pinned release is below;
module presence does not imply linkage. The upstream inventory distinguishes
runtime packages, upstream-test-only packages and graph-only tooling. In
particular, the lru module is graph-only under this driver; the existing BSD/MIT
runtime notices remain separate from its MPL-2.0/BSD-3-Clause metadata.

| Transitive module | Version | License |
| --- | --- | --- |
| `github.com/dustin/go-humanize` | v1.1.0 | MIT |
| `github.com/google/pprof` | v0.0.0-20261016150608-1facf8f91b50 | Apache-2.0, BSD-3-Clause |
| `github.com/google/uuid` | v1.6.0 | BSD-3-Clause |
| `github.com/hashicorp/golang-lru/v2` | v2.0.7 | MPL-2.0, BSD-3-Clause |
| `github.com/mattn/go-isatty` | v0.0.24 | MIT |
| `github.com/ncruces/go-strftime` | v1.1.0 | MIT |
| `github.com/remyoudompheng/bigfft` | v0.0.0-20230129092748-24d4a6f8daec | BSD-3-Clause |
| `golang.org/x/mod` | v0.42.0 | BSD-3-Clause |
| `golang.org/x/sync` | v0.24.0 | BSD-3-Clause |
| `golang.org/x/sys` | v0.49.0 | BSD-3-Clause |
| `golang.org/x/tools` | v0.52.0 | BSD-3-Clause |
| `modernc.org/cc/v4` | v4.30.6-0.20261101114202-1b9d1a076f6b | BSD-3-Clause |
| `modernc.org/ccgo/v4` | v4.38.1 | BSD-3-Clause |
| `modernc.org/fileutil` | v1.4.0 | BSD-3-Clause |
| `modernc.org/gc/v2` | v2.6.5 | BSD-3-Clause |
| `modernc.org/gc/v3` | v3.2.0 | BSD-3-Clause |
| `modernc.org/goabi0` | v0.2.0 | BSD-3-Clause |
| `modernc.org/libc` | v1.80.1 | BSD-3-Clause |
| `modernc.org/mathutil` | v1.7.1 | BSD-3-Clause |
| `modernc.org/memory` | v1.12.1 | BSD-3-Clause, attribution reference |
| `modernc.org/opt` | v0.2.0 | BSD-3-Clause |
| `modernc.org/sortutil` | v1.2.1 | BSD-3-Clause |
| `modernc.org/strutil` | v1.2.1 | BSD-3-Clause |
| `modernc.org/token` | v1.1.0 | BSD-3-Clause |

## Location

The record home is exactly Node's existing `mexHomeDir()`: append `.mex` to
trimmed, nonempty `MEX_HOME`, otherwise append `.mex` to the user's home.
**`MEX_HOME` is the base directory in both languages.** For `MEX_HOME=/x`, config,
telemetry identity, records and project data all live under `/x/.mex/` (with
only the database files redirected when that home is remote). Go implements the
same base rule. There is no direct-override mode or second meaning for the
variable. Explicit `LocationOptions.home` / `LocationOptions.Home` are already
resolved home paths for dependency injection, not interpretations of MEX_HOME.

Paths are absolute and cleaned. On Windows ASCII letters are lowercased in
both languages; Unicode spelling comes from the filesystem's native realpath,
so case aliases resolve identically without incompatible Unicode case maps.
Node uses native realpath; Go uses GetFinalPathNameByHandleW. On other systems
case is preserved. Project paths resolve links. Home/cache paths resolve the
existing prefix to its real path and retain any absent suffix's spelling.
IDs and pointer bytes use these normalized paths, including Unicode folders.

For a local home, both databases live directly in the home. For a network home,
they live in `<cache-root>/<home-hash>/`, where `home-hash` is the first 24
lowercase hex characters of SHA-256 of the normalized absolute home, UTF-8:

| OS | Cache root |
| --- | --- |
| Windows | `%LOCALAPPDATA%/mex`, falling back to `~/AppData/Local/mex` |
| macOS | `~/Library/Caches/mex` |
| Linux | `$XDG_CACHE_HOME/mex`, falling back to `~/.cache/mex` |

`<home>/location` contains the normalized database directory followed by LF.
It caches local decisions as well as network decisions. Both implementations
accept only the computed home or computed cache destination, and cap pointer
reads at 4 KiB. First publication uses exclusive creation; a simultaneous
opener adopts the published destination. Invalid pointers are ignored and
detection runs again. A valid pointer to a missing directory is honored and
the directory is recreated by a writer. Read-only opens create no directories,
pointer, project folder or database.

Detection checks Windows UNC paths or mapped remote drive type, Linux NFS,
SMB/CIFS filesystem magic values, and macOS nfs/smbfs/cifs/afpfs/webdav types.
Go uses native OS calls. Node uses `statfs` on Linux, a bounded `mount` listing on macOS,
and first checks Windows UNC/native-realpath UNC expansion (including common
mapped drives) without PowerShell. Otherwise its uncached Windows drive query
has a **5,000 ms** timeout: cold CIM startup can exceed 1.5 seconds. This is a
one-time startup trade-off to avoid permanently misclassifying an ordinary
remote drive. Both allow injected detection. If detection still fails, keep
the files in the home and publish that local fallback in `location`, so Go and
Node agree and hooks continue. That fallback is cached until the pointer is
removed explicitly; it is not retried on every hook/open. Cache hashes separate
independent homes and tests.

Project data is **`<home>/projects/<project-id>/`**, even with database redirection.
The project folder is created only by an explicit `projectDataDirectory` /
`ProjectDataDirectory` call, not by read or project registration.

## Project id

Both implementations use this exact rule:

1. Resolve the requested folder to its real absolute path. Windows uses native
   filesystem spelling (case aliases converge), then lowercases ASCII letters;
   other systems preserve case. Unicode case conversion is never used to
   rewrite a physical filename.
2. Ask Git for the checkout top level, whether the repo is shallow, and
   `git rev-list --max-parents=0 HEAD`. Each invocation is bounded to 1,500 ms.
3. For a non-shallow repository with root commits, select the lexicographically
   smallest lowercase full root hash reachable from `HEAD` only. The ID is `g-`
   plus the first 24 lowercase hex characters of SHA-256 of that hash's UTF-8
   bytes (no newline). The checkout path is the real top level.
4. With no commits, a shallow repository, missing Git, or a Git error/timeout,
   use `f-` plus the first 24 lowercase hex characters of SHA-256 of the real
   folder path (UTF-8, no newline). If Git already established a top level,
   use that path; otherwise use the requested real folder. Record `kind=folder`
   honestly. A shallow clone cannot prove its historical root, so its folder
   ID intentionally changes to a Git ID when full history becomes available.

Ordinary clones and worktrees whose HEADs share historical roots initially
share a Git ID. Fetching unrelated orphan refs does not affect the candidate.
Multiple roots reachable from HEAD are deterministic; submodules use their own
roots. Both languages may use bounded Git commands for **unregistered fallback
resolution only**. No repository build command is run.

### Pinning and provisional promotion

A registered checkout's `checkouts.project_id` is authoritative, even if HEAD
later switches to another history. Node checks this row before any Git call;
Go's hook path uses `Reader.CheckoutProjectID`, never `ResolveProject` for an
already-registered checkout. Native realpath/ASCII normalization is identical
on registration and lookup, including links and Windows case aliases. Registered
Git ancestors can be found without Git, but an unregistered nested repository
is not mistaken for its registered parent. Ordinary folder projects do not
implicitly absorb their subfolders.

Only folder IDs caused by a verified unborn symbolic HEAD or a shallow clone
are provisional. `checkouts.provisional` is nullable TEXT with CHECK values
`unborn` / `shallow`; NULL is pinned. Missing Git and other errors honestly
produce folder kind without inventing an unborn/shallow reason. A later Node
open retries resolution only for a provisional row. If it still resolves to a
folder, keep the stored ID, its data and marker. If it resolves to Git:

- In one record.db transaction, create/reuse the Git project, preserve checkout
  switches, clear the provisional marker and update checkout/job/model-call/
  review references. Move judgement and project-scoped setting rows to the Git
  ID; keep conflicting values under the retired ID and record a notice instead
  of overwriting them. Keep the retired project row for history.
- Write scope `global`, key `project.alias.<f-id>`, value `<g-id>`. Historical
  Go-owned rows are never rewritten by Node. Readers use this alias to resolve
  historical project IDs (and moved project-folder prefixes where necessary).
- Commit a scope `global`, key `project.move.<f-id>`, value `<g-id>` intent before
  touching folders. Node replays pending intents on later opens, so a crash
  after the database commit or after a successful rename is recoverable.
- If the old folder exists and the Git target does not, rename one contained
  `projects/<f-id>` directory entry to `projects/<g-id>`. Reject redirected
  parents/source directories; never recursively copy/delete or merge data.
  If both folders exist, keep both and write an idempotent `project-data-conflict`
  notice. Filesystem errors retain the intent and old data and emit a
  `project-data-move-failed` notice for a later retry.

Settings/row conflicts emit `project-record-conflict` notices. These notices are
record metadata only; this step adds no Hub surface or job behavior. Stable IDs
are never changed merely because another root/branch was fetched or selected.

## Tables in record.db

All timestamps/days are UTC ISO text, paths/IDs/text are TEXT, flags are INTEGER
0/1 with CHECKs, token/count fields are nonnegative INTEGER. Nullable values
are called out below. Structured progress/checkpoints/summaries/values are text
(consumers may encode JSON). Accounting observes calls; it never initiates one.

Every table below has **Node as its sole writing side**; the named component is
its logical writer. Go and Node may read every table.

| Table | Columns and primary key | Logical writer |
| --- | --- | --- |
| `projects` | PK `id`; `root_path`, `kind` (git/folder), `shared` (default 0), `created_at` | Command project registration; sharing updates `shared` |
| `checkouts` | PK (`project_id`,`path`), UNIQUE `path`; `state` (on/off/off until), nullable `off_until` required exactly for off until; nullable `provisional` (unborn/shallow) | Registration/promotion; checkout settings |
| `jobs` | PK `id`; nullable `project_id` for machine jobs; `kind`, `state`, nullable `reason`, `progress`, `checkpoint`, `tokens_estimate`; `tokens_used` default 0, `created_at`, `updated_at`; migration 3 adds JSON `params`, `batch` (next batch number), `results`, `failures` (same cause in a row), `request` (pause/cancel, applied after the current batch), `owner` (the runner holding it), `finished_at` | Job runner |
| `job_results` | PK (`job_id`,`batch`); `summary` | Job runner, per batch |
| `model_calls` | INTEGER PK `id`; `ts`, nullable `project_id`, `purpose`, `agent`, `model`, `input`, `cache_write`, `cache_read`, `output`, `estimated`; migration 2 adds `kind` (headless/interactive, default headless) and nullable `session_id` | Model-call accounting boundary |
| `own_usage` | PK (`day`,`agent`); `input`, `cache_write`, `cache_read`, `output`, `estimated` | Own-usage log reader |
| `usage_files` (migration 2) | PK `path`; `agent` (claude/codex), `root`, `identity`, nonnegative `offset` and last observed `size`, `anchor`, JSON `state`, file `mtime`, line counts `usage_lines`, `skipped_lines`, `problem_lines`, and 0/1 `failed` (the file itself couldn't be read) | Own-usage log reader |
| `usage_events` (migration 2) | PK (`agent`,`event_id`); `day`, four nonnegative token classes | Own-usage deduplication/attribution |
| `usage_snapshots` (migration 2) | PK (`session_id`,`day`); nonnegative cumulative `input`, `cache_read`, `output` | Codex daily cumulative endpoints |
| `usage_windows` (migration 2) | PK (`agent`,`window`); `observed_at`, nullable `used_percent` (0..100), `resets_at`, `status` (allowed/allowed_warning/rejected) | Own-usage plan-window reader |
| `background` (migration 3) | One row (`id`=1): the lease `owner`, `pid`, `version`, `started_at`, `heartbeat_at`, `request` (exit: hand over), `hub_until` (seam for open Hub tabs), `spawned_at` | Background process |
| `installs` | INTEGER PK `id`; `agent`, `path`, `key`, nullable `old_value`, `new_value`, `ts` | Installer/settings change journal |
| `notices` | PK `id`; `kind`, `text`, `created_at` | Node notice queue |
| `review` | PK `id`; `project_id`, `entry_id`, `reason`, `state` (pending/accepted/dismissed), `created_at` | Review service |
| `judgements` | PK (`project_id`,`entry_id`,`inputs_hash`); `result` (still-true/rewritten/cannot-tell), `at` | Judge |
| `counters_node` | PK (`day`,`name`); `value` | Node counter accumulator |
| `settings` | PK (`scope`,`key`); `value` | Node settings service |

Job states are exactly: **queued, running, paused, waiting, done, done with
gaps, failed, cancelled**. Waiting requires one nonempty `reason`; failed
requires one nonempty `reason` describing the cause. The single reason column
holds the current reason, not several concurrent wait states. Transitions,
single-runner claims and checkpoints are step-3 behavior. There is no new job
runner in this step.

Foreign keys protect project references and job results. Indexes support job
state/project/time scans, model-call time/project scans, install path/key/time,
notices by creation, and review by project/state/time. The composite primary
keys support settings and judgement lookups and day-based totals.

## Usage APIs and token classes

`src/record/usage.ts` exposes `recordModelCall(call, options?)`,
`recordInteractiveLaunch(launch, options?)`, `modelCallTotals(reader, from, through)`
and `mexSpendTotals(reader, from, through)`. A call records purpose, agent, model,
optional project, the four classes and an estimated flag. The timestamp defaults
to now. `projectPath` uses the existing pinned checkout registration. Invalid
counts, busy/missing/broken/incompatible storage and even a throwing warning
observer cannot fail the calling command: return false and emit only
`MEX could not record model usage; the command continues.` By default that line
is printed once per process, on exit, so it can never land inside a full-screen
view such as setup's; a caller may pass its own `warn`. No private SQLite
diagnostic or prompt is printed. The existing Node 5-second writer wait applies.

Both own usage and MEX totals use **UTC calendar days**, never machine-local
midnight. Ranges are inclusive UTC dates. Model totals group day, agent and
purpose and kind, sum each class, count rows and expose whether any row was
estimated. `mexSpendTotals` is what MEX itself spent: headless rows only, plus a
count of interactive launches.
The reader opens no files or models itself. No usage CLI is needed for this
step; later budget and Hub consumers use these APIs.

The four classes are disjoint:

| Agent/source | input | cache_write | cache_read | output |
| --- | --- | --- | --- | --- |
| Claude Code | `input_tokens` | `cache_creation_input_tokens` | `cache_read_input_tokens` | `output_tokens` |
| Codex | `input_tokens - cached_input_tokens` | 0 (not separately reported) | `cached_input_tokens` | `output_tokens`, already including reasoning; do not add `reasoning_output_tokens` again |

Claude cache counts are additional classes; Codex cached input is inside its
reported input. Absent optional cache counters are zero. Invalid/noninteger or
negative required counts are rejected. A model not reported by an agent is
`unknown`, never inferred from a product default. Multiple observed model names
without per-model totals use `mixed`. Claude's terminal `modelUsage` breakdown,
when complete and consistent with terminal totals, produces separate model rows.

### Kept call sites

All headless setup agents pass through `src/setup/headless-population.ts`, using
the arguments constructed by `src/agent-command.ts`. A separate bounded observer
does not change the existing activity/transcript/usage callbacks, flags, agent
selection, permissions, success/failure handling or stdout. It records after
pipe drains, including failed/cancelled attempts. One row represents an agent
invocation's reported aggregate (or one row per reported model), including its
turns, tools and retries; assistant block usage and terminal totals are never
added together.

| Site | Accounting purpose and source |
| --- | --- |
| `setup/headless.ts` single population / direct shared launcher | `setup.population`; Claude terminal JSON usage (deduplicated assistant usage fallback); Codex sum of `turn.completed` usage |
| `setup/subsystem-runs.ts` shared/subsystem sessions and fixes | `setup.<shared or subsystem>.<write or fix>`; same shared observer for every launch/retry |
| `setup/finalize-repair.ts` | `setup.finalize-repair`; same observer |
| `setup/interactive-population.ts` | `setup.interactive`; an `interactive` launch row with no token numbers |
| `sync/index.ts` (also legacy `setup/population.ts`) | `sync.interactive` / `setup.interactive`; an `interactive` launch row with no token numbers, inherited stdio preserved |

The research scripts under `evaluate/` are not the product and don't write to the
record: a developer's evaluation runs must not show up as MEX spend.

Headless rows keep the agent's own session id when its output reports one
(Claude Code stream events carry `session_id`; Codex reports `thread.started`
with `thread_id`).

Cursor/Copilot terminal `result.usage`, when it supplies the named numeric
fields, is observed; otherwise counts are estimated. OpenCode `step_finish`
uses `part.id` deduplication and `part.tokens` input, output plus separate
reasoning, cache.read and cache.write. Unknown protocols fall back to a marked
estimate: ceil(UTF-8 sent-prompt bytes / 4), ceil(received stdout bytes / 4),
zero cache classes. Encoded stdout includes protocol overhead, so this is a
heuristic, not a tokenizer or a cost claim. Partial reports without a complete
terminal total are also marked estimated when malformed/missing usage is seen.
An interactive session MEX opens is driven and watched by the person, and its
real tokens are written to the agent's own transcripts, which the own-usage
reader counts. So MEX records only the launch (`kind = interactive`, zero tokens,
`estimated = 0`) and never counts it as its own spend; a prompt-size guess would
understate the session and mix it into MEX's spend.

Pure command
builders/decoders make no calls. `hub/setup/commit.ts` invokes Git only, so it
has no model row. Graph evaluation runs deterministic CLI commands. Installer
checks, availability probes and manual prompt printing make no model calls.
The subsystem final navigation pass is deterministic and launches no agent.
Arbitrary externally supplied evaluation driver modules own their own calls.

### Known gaps

- **Headless runs are counted twice.** In 0.8 the headless runs MEX starts are
  still saved by the agents as ordinary sessions, so the own-usage reader counts
  them as the person's usage too. Making MEX's own runs leave no saved session
  (`--no-session-persistence`, `codex exec --ephemeral`, `MEX_BACKGROUND=1`,
  is part of the install work. Until then, a consumer can subtract
  them: headless `model_calls` rows carry the agent's `session_id` when it was
  reported.

### Own-usage reader

`src/record/own-usage.ts` exposes explicit `refreshOwnUsage(writer, options?)`,
read-only `ownUsageTotals(reader, from, through)`, `ownUsageStatus(reader)` and
`usageWindows(reader)`. Refresh is maintenance, never a hook or totals read.
Defaults: `CLAUDE_CONFIG_DIR` or `~/.claude`, `projects/**/*.jsonl` including
subagents; `CODEX_HOME` or `~/.codex`, `sessions/**/rollout-*.jsonl` and
`archived_sessions/**/rollout-*.jsonl`. Explicit directory options are test seams.
No source logs are changed. No transcript text is saved in the record.

- Claude: only real assistant records with usage, message ID and request ID
  count. Deduplicate globally by `(message.id, requestId/request_id)`; repeated
  content-block lines retain the component-wise largest reported counters and
  add only their increase. Use the earliest reported UTC day of that response,
  reallocating if an older duplicate is discovered later. Ignore
  lines with no usage, synthetic records, `<synthetic>` models and API-error
  assistant messages. Missing identity or invalid usage on an assistant message
  is a problem line, never a guessed count. Distinct request IDs remain distinct.
- Codex: identify sessions from `session_meta.payload.id`. Use only
  `event_msg.payload.type=token_count`, `info.total_token_usage`; never add
  `last_token_usage`. Keep a cumulative maximum per session and UTC day.
  Contributions are that day's positive increase over all prior daily maxima.
  Repeated snapshots, resumed/archived copies and older totals add nothing.
  Discovering an older day later reallocates the affected contributions without
  changing the session total, so traversal order cannot move tokens to a newer
  day. The first observed cumulative total belongs to its observed UTC day;
  activity predating all available snapshots cannot be reconstructed. A reused
  session ID with reset counters is not treated as a new billable session.
- `usage_files` remembers identity (device/inode/birth time), byte offset,
  last size, prefix/tail hashes at the committed boundary and session/drop-line state.
  Replacement, truncation or a changed anchor resets the file cursor. Persistent
  global response keys/daily maxima prevent recounting old lines after rereads.
  Arbitrary same-inode rewrites strictly between unchanged anchors cannot be
  detected; normal append-only transcripts and rotation are the supported format.
  A missing fully consumed healthy file retires its cursor, retaining global
  deduplication and totals. A file that can't be opened or read is `failed`.
- Every file batch obtains a Node write transaction, re-reads its current cursor,
  and atomically commits totals, deduplication, windows and offset. A rollback
  advances none of them. Complete newline-terminated JSONL records only: retain
  the offset before a partial final line and pick it up next time.
- **Only usage-bearing lines can be problems.** Claude Code and Codex add new
  line types often, so every line that isn't a Claude Code assistant message with
  usage or a Codex `token_count` event is skipped and counted, whatever its type
  (including valid JSON that isn't an object). A problem line is a usage-bearing
  line that can't be read (bad numbers, missing ids or timestamp, no Codex
  session), a line that isn't JSON at all, or an oversized line. Counts of usage,
  skipped and problem lines are kept per file and summed in the status, so a
  format change shows up as rising problem counts instead of silent zeros.
- **Bounded history.** Discovery only registers logs modified within the window
  (35 days, the plan's 4-week base plus a week; `windowDays`). Usage lines older
  than the horizon (window plus a 7-day margin) are skipped, because their dedup
  rows may already be gone. Each refresh prunes, in one transaction: Claude
  dedup rows older than the horizon; a Codex session's snapshots and dedup rows
  once its newest snapshot is older than the horizon (a session that spans the
  horizon keeps all of them, since each day's share is the difference from the
  previous snapshot; days past the horizon serve only as its baseline); and the
  cursors of fully read logs last modified before the window. Daily totals in
  `own_usage` are never pruned.
- Default work cap: **64 log files and 4 MiB total read bytes per refresh** across
  both agents, including at most 1 KiB of anchor verification/update per file.
  The byte option has a 64 KiB minimum to guarantee bounded-line progress.
  Maximum line size is the smaller of 1 MiB and half the configured byte budget;
  larger lines are discarded through their newline and flagged, never buffered
  in persistent state. A file/byte cap leaves pending=true and continues next
  refresh through a durable round-robin path cursor. Catalog reads use bounded
  keyset pages. Discovery visits at most 4096 entries per source per refresh,
  with a durable directory queue and entry index; one OS directory listing is
  materialized at a time. Links are not traversed; opened files must resolve
  inside the selected source root. Discovery cycles repeat to find new files.
- Scope `own-usage` settings store `scan.<agent>.<root hash>` (queue), `last-file`
  (round-robin cursor) and `status.<agent>` (latest API status). **Unreadable**
  means no usage could be read for that agent: a missing folder, no logs in the
  window, or logs where nothing usage-bearing could be read (only problem lines
  or failed files). It never means "saw a new line type". Known counts stay
  available; consumers must consult status. `partial` means bounded pending
  work; `readable` means everything tracked has been read, with any problem
  lines visible in the counts. Recorded counts are reported, `estimated=0`; this reader invents no
  transcript-based estimates. The fixed weekly budget fallback comes with the budget work.

Plan room is observation only: `usage_windows` keeps the latest timestamped
Codex primary/secondary used_percent and reset epoch, or Claude
`rate_limit_event.rate_limit_info` utilization (fraction converted to percent),
resetsAt and allowlisted status/window type. Missing/null usage can still carry
a window update. No status strings outside the closed set, log text or account
details are saved. Missing information returns no window, not inferred room.
Claude transcripts need not contain these events; no real local transcripts
were inspected to claim their availability. Cap policy, pausing, model choice,
session invisibility and token levers are separate work.

## Jobs and the background process

### One job model

`src/record/jobs.ts` holds the one job model for the machine. The states are
exactly: queued, running, paused, waiting (with one reason), done, done with
gaps, failed (with a cause), cancelled. The allowed transitions live in one
table (`JOB_TRANSITIONS`) and one function changes state; anything else is
refused with a plain message.

| From | To |
| --- | --- |
| queued | running, paused, cancelled |
| running | queued (between batches, or its runner died), done, done with gaps, failed, waiting, paused, cancelled |
| paused | queued, cancelled |
| waiting | queued (its condition cleared), paused, cancelled |
| failed | queued (resume: position kept, failure count reset), cancelled |
| done, done with gaps, cancelled | none |

**Batches and checkpoints.** A job kind runs one batch at a time and returns
what the batch produced and its next checkpoint. The runner commits the
`job_results` row, the checkpoint, the batch number, results, tokens and the
next state in one transaction, so a process killed at any point redoes at most
the batch in flight and never leaves half a batch recorded. A kind declares
`sideEffects`: `none`, or `idempotent` when a batch also changes things outside
the job rows; those must be safe to run twice from the same checkpoint. A
waiting result isn't a batch: nothing is recorded and the position stays.

**Failures.** A batch that throws keeps a one-line cause (never a stack) in
`reason` and goes back to the queue. The same cause three times in a row stops
the job as failed; a different cause restarts the count.

**Requests.** Pause and cancel apply at once to a job that isn't running; a
running job is asked (`request`) and stops after its current batch.

**Concurrency, per kind.** Project jobs need a project and run at most one at a
time per project; machine jobs have none. A `machineExclusive` kind (learning)
runs at most once per machine. The runner enforces both when it claims a job,
inside a write transaction, and `blockedReason` gives the plain wording
("Waiting: Graph build is running in repo-a"). Queuing a job whose kind already
has an unfinished job for that project returns the existing one.

**Recovery.** A job left `running` by a runner whose process is gone goes back
to the queue (or to paused/cancelled if that was requested), resuming from its
last committed checkpoint. Owner strings carry the process id, so a live
foreground runner's job is left alone. A kind this version doesn't know (from a
newer MEX) is left queued and listed as "Unknown job (needs a newer MEX)".

**Rule for new job kinds.** Register with `registerJobKind` (built-ins in
`src/record/job-kinds.ts`); give a plain `label`, the scope, whether it's
machine-exclusive and its side effects; return results through the batch result
rather than writing job rows; make external effects idempotent per batch; use
`wait` with one plain reason and `ready` for conditions that clear by
themselves. The first real kind is the usage refresh (machine-exclusive, runs
until the reader has caught up). A `demo` kind exists only when
`MEX_JOBS_DEMO=1`.

### The background process

- **On demand, one per user.** `ensureBackground()` returns at once and never
  waits. It starts the process only when work is pending (queued, waiting or
  running jobs of known kinds) and none is running or starting. The process is
  `process.execPath` with the CLI entry and `__background`, never a shell, with
  `--max-old-space-size` at the memory cap, detached, no window, stdout and
  stderr appended to `<home>/background.log` (rotated at 1 MiB). Its
  environment has `MEX_BACKGROUND=1`, so nothing it runs triggers MEX.
- **The lease.** The `background` row holds the owner, pid, version and a
  heartbeat (every 3 s). A lease is live while its heartbeat is younger than
  15 s and its process exists; a dead pid is taken over at once, and a reused
  pid only delays takeover until the heartbeat goes stale. A process that finds
  a live lease of the same version exits ("duplicate"). `spawned_at` stops two
  commands in a row from starting two processes.
- **Version handshake.** A CLI of a different version that finds a live process
  sets `request = 'exit'` and starts its own. The old process finishes its
  batch, releases the lease and exits; the new one waits up to 30 s for it.
- **Limits.** Idle exit after 15 minutes with no pending work and no open Hub
  (`background.idle_minutes`). Memory cap 1024 MB of resident memory
  (`background.memory_mb`): over it, the process exits between batches and the
  job resumes later. Off with `MEX_BACKGROUND=0` or `background.enabled =
  false`. `MEX_BACKGROUND_*_MS` variables shorten the timings for tests.
- **No network listener.** Everything goes through the record. The Hub seam is
  `noteHubActivity(writer, untilMs)`: an open Hub tab keeps the process alive.
- **Without it.** `mex jobs run` (and `runPendingInForeground`) runs pending
  batches in the current terminal. Any `mex` command restarts the process when
  `<home>/jobs-pending` exists; that marker check opens no database. The
  session-start hook calls `ensureBackground()` (wired with the hooks).

`mex jobs` lists every job on the machine, newest first: the project's name and
path, the kind in plain words, the state with its reason or cause, what it's
doing (only while it is active, so a stopped job never shows "387 / 387
parsed"), results so far and tokens against the estimate. Jobs are addressed by
their number in the list (`mex jobs pause 2`); there are no raw ids. `--json`
prints the same rows. `pause`, `resume`, `cancel` and `run` are subcommands.

The Hub's graph and wiki jobs keep their own storage and contract for now (the
Hub pages that show them are being rebuilt); their
states map onto this model as succeeded = done, interrupted by the user =
cancelled, interrupted by a restart = queued.

## Tables in hooks.db

Every table below has **Go as its sole writing side**; the named component is
its logical writer. Node and Go may read every table. No cross-file foreign
keys exist. Session keys in this file are protected by foreign keys.

| Table | Columns and primary key | Logical writer |
| --- | --- | --- |
| `sessions` | PK `session_id`; `agent`, `project_id`, `checkout`, `started_at`, `last_seen_at`, `paused` default 0 | Session lifecycle/heartbeat |
| `epochs` | PK (`session_id`,`agent_id`,`epoch`); `started_at`, `tokens_sent` default 0 | Session/compaction lifecycle |
| `deliveries` | PK `id`; `session_id`, `agent_id`, `epoch`, `ts`, `moment`, `entry_id`, `form` (full/one-line/pointer/card), `tokens`, `action` (given/withheld/replaced/held-back) | Delivery check-and-mark transaction |
| `followups` | INTEGER PK `id`; `delivery_id`, `ts`, `kind` (followed/missed/opened/wrong/edit/command), nullable `detail` | Delivery feedback |
| `verdicts` | PK (`project_id`,`checkout`,`entry_id`); `verdict` (held/changed/broken/unknown), `inputs_hash`, `checked_at` | Check evaluator |
| `ledger` | PK (`session_id`,`agent_id`,`lever`); `tokens_removed`, `turns_carried`, `cost_tokens`, `refetches`, all default 0 | Lever accounting |
| `journal` | AUTOINCREMENT INTEGER PK `id`; `session_id`, `ts`, `kind` (typed/command), `text`, nullable `exit_code`, `marks` | Capture hook |
| `outputs` | AUTOINCREMENT INTEGER PK `n`; `session_id`, `path`, `bytes` | Output trimmer/wrapper |
| `notices_shown` | PK `notice_id`; `session_id`, `ts` | Session notice display |
| `counters_go` | PK (`day`,`name`); `value` | Hook counter accumulator |

`agent_id` defaults to empty text for the main agent. `epoch` is nonnegative.
`ledger` adds the session/agent identity omitted from the version-0 column list
to implement its stated per-session meaning. `journal.marks` is one of empty
text, `pasted`, `scripted`, `pasted,scripted` (canonical order); monotonically
allocated journal/output numbers are never reused after pruning.
`notices_shown` has a unique notice ID so a notice is marked once across sessions.
Indexes cover active sessions by project/time, deliveries by session/agent/epoch/
entry/time and by time, followups by delivery/time, journal by session/id, and
outputs by session/number. `moment`, `lever`, agent and job kinds remain open
text because their owning delivery/adapter/job contracts evolve independently.

## Crossing the line

- Node finished a capture batch: write the last consumed journal ID into
  `record.db.settings`, scope = project ID, key = `journal.consumed`, value =
  decimal ID. Go prunes up to that ID at the next session start.
- Go wants a judge/filter run: never call a model or write Node tables. The
  background process reads `verdicts` and `journal` and queues jobs itself.
- Delivery check-and-mark is one transaction entirely inside `hooks.db`.
- Node enqueues a notice in `notices`; Go marks it once in `notices_shown`.
- No shared writable connection, no ATTACH-based cross-file write, and no
  migration of the other side's file. Filesystem `location` publication is
  shared, exclusive-create metadata, not a shared database writer.

## Changes

- Version 3: record.db migration 3 adds the job columns and the
  `background` lease row. The job model, its transitions and the rule for new
  job kinds; the background process with its lease, handshake, limits and
  marker; `mex jobs`. Readers without a location pointer no longer run network
  detection (no writer has run, so the files can only be in the home). The
  usage reader caches its prepared statements.

- Version 2, later changes: the research scripts under `evaluate/` no longer write to the
  record. Unknown line types are skipped and counted instead of making an agent
  unreadable; `usage_files` keeps line counts in place of the `recognized` and
  `problem` flags. Discovery and dedup storage are bounded by a 35-day window
  with a 7-day margin, with pruning. `model_calls` gains `kind` and `session_id`
  in migration 2: interactive launches carry no invented numbers and are left
  out of MEX's spend. The usage warning waits for process exit.

- Version 2 adds record.db migration 2: `usage_files`, `usage_events`,
  `usage_snapshots`, `usage_windows` and the source-root/path index. The reason
  is restart-safe incremental deduplication and plan-room observations without
  storing transcript text. Existing version-1 tables/data and hooks schema stay
  unchanged; Go recognizes additive record schema 2 for its existing reads.
- Added the fail-open call writer, kept-call-site inventory, UTC totals, exact
  per-agent token mapping, unreadable status and bounded incremental rules.
- Record opens load `node:sqlite` lazily through `createRequire`, preserving
  the builtin protocol through the existing bundle target and the CLI's quiet
  startup. Only SQLite's experimental warning is suppressed during that load;
  other warnings and record/schema error handling are retained.

- Version 1 specifies the first shipped schemas, transactional migrations,
  exact columns/keys/constraints, table ownership and typed opening APIs.
- One database and a separate `usage.db` were considered and dropped: exactly
  two files, with usage tables in Node's `record.db`, keeping writers separate.
- Added the shared `native/` Go module/import path and writer-owned embedded
  hooks SQL so the hook shim can be added without moving storage code.
- Fixed the shared base-home/cache/pointer and deterministic project-ID rules,
  including shallow, unborn, multi-root, worktree, submodule and missing-Git cases.
- Specified native Windows realpath plus ASCII folding so Node and Go agree
  on Unicode folder names as well as ordinary case aliases.
- Added row IDs where repeated events need identity, session/agent keys for
  ledger, an off-until deadline, explicit review states and once-only notices.
  These fill version-0 gaps without adding product behavior or a third file.

- Version 1, later changes: removed directOverride, use only HEAD-reachable roots and pin
  registered checkout IDs; added explicit unborn/shallow markers and recoverable
  Node-only promotion/data-folder moves with alias and conflict metadata.
- Added the Git-free Go checkout lookup and separate bounded writer/read timeout
  policies, with real multi-process Go contention tests and fail-open locking tests.
- Added the native-UNC fast path and a 5-second uncached Windows drive-query limit;
  detection failure deliberately caches the home fallback for agreement.
- Updated to the latest stable driver v1.62.0 and declared Go 1.27, matching the
  tested toolchain; refreshed transitive-license and cross-build evidence.
