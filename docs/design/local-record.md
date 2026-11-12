# Contract: the local record (version 1)

Owner: foundation-02. Design sheets 16, 31, 35, 38, 45.

Everything MEX records about its own work belongs under the MEX home, or the
local database cache described below. CLI, Hub, session lines and reports read
these records. This contract reserves the usage and job shapes; their behavior
is implemented in later foundation-02 steps.

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

There is no `usage.db`. Sheet 16's machine-wide usage log is `model_calls` and
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
Go. This module contains no shim or CLI; foundation-03 adds its commands to
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
(consumers may encode JSON); no model behavior is attached to them yet.

Every table below has **Node as its sole writing side**; the named component is
its logical writer. Go and Node may read every table.

| Table | Columns and primary key | Logical writer |
| --- | --- | --- |
| `projects` | PK `id`; `root_path`, `kind` (git/folder), `shared` (default 0), `created_at` | Command project registration; sharing updates `shared` |
| `checkouts` | PK (`project_id`,`path`), UNIQUE `path`; `state` (on/off/off until), nullable `off_until` required exactly for off until; nullable `provisional` (unborn/shallow) | Registration/promotion; checkout settings |
| `jobs` | PK `id`; nullable `project_id` for machine jobs; `kind`, `state`, nullable `reason`, `progress`, `checkpoint`, `tokens_estimate`; `tokens_used` default 0, `created_at`, `updated_at` | Job runner |
| `job_results` | PK (`job_id`,`batch`); `summary` | Job runner, per batch |
| `model_calls` | INTEGER PK `id`; `ts`, nullable `project_id`, `purpose`, `agent`, `model`, `input`, `cache_write`, `cache_read`, `output`, `estimated` | Model-call accounting boundary |
| `own_usage` | PK (`day`,`agent`); `input`, `cache_write`, `cache_read`, `output`, `estimated` | Own-usage log reader |
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

- Version 1 specifies the first shipped schemas, transactional migrations,
  exact columns/keys/constraints, table ownership and typed opening APIs.
- The ticket's one database and sheet 16's `usage.db` are superseded: exactly
  two files, with usage tables in Node's `record.db`, keeping writers separate.
- Added the shared `native/` Go module/import path and writer-owned embedded
  hooks SQL so foundation-03 can add its shim without moving storage code.
- Fixed the shared base-home/cache/pointer and deterministic project-ID rules,
  including shallow, unborn, multi-root, worktree, submodule and missing-Git cases.
- Specified native Windows realpath plus ASCII folding so Node and Go agree
  on Unicode folder names as well as ordinary case aliases.
- Added row IDs where repeated events need identity, session/agent keys for
  ledger, an off-until deadline, explicit review states and once-only notices.
  These fill version-0 gaps without adding product behavior or a third file.

- Review fixes: removed directOverride, use only HEAD-reachable roots and pin
  registered checkout IDs; added explicit unborn/shallow markers and recoverable
  Node-only promotion/data-folder moves with alias and conflict metadata.
- Added the Git-free Go checkout lookup and separate bounded writer/read timeout
  policies, with real multi-process Go contention tests and fail-open locking tests.
- Added the native-UNC fast path and a 5-second uncached Windows drive-query limit;
  detection failure deliberately caches the home fallback for agreement.
- Updated to the latest stable driver v1.62.0 and declared Go 1.27, matching the
  tested toolchain; refreshed transitive-license and cross-build evidence.
