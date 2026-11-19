# Contract: the local record (record version 5, hooks version 10)

## Surface ledger

Migration `0007_surfaces.sql` rebuilds the deliveries action constraint with
`shadow` and `control`, preserving receipt ids, order, followups and touches.
The copy refuses more than 100,000 receipts or followups. Historical moments
map to their surface; unrecognized moments become `unknown`.

`surface_windows` holds immutable bounded targets, a 40-call expiry, first/repeat,
acted and settled bits. Commands are digests; observed tool text is not stored.
`surface_firings` groups a surface/block/action's windows; pending decreases
incrementally and the group's maximum acted bit settles once, avoiding repeated
samples from multi-item replies. Rollups retain both firing and receipt counts.
`surface_session_first` atomically claims each surface's first block for a
session/agent/checkout, so first/repeat never scans historical receipts.
`surface_stats` rolls up firings, settled/acted and estimated tokens by project,
checkout, surface, action and repeat. `surface_gates` stores fixed minimums
(30 firings, .30 acted rate, Wilson z 1.959963984540054), evaluation snapshots,
consecutive failures, state/reason and the once-only notice claim. Windows,
rollups, gate transitions and receipt admission use the same writer transaction.
Pruning receipt windows preserves their aggregate counts.

Epochs gain `tool_calls`, `candidate_tokens`, `admitted_tokens` and `budget_held`.
The last three columns reserve contention accounting in this migration.
Node recognizes version 7 read-only; Go remains its sole writer (version 10 is
current, see "Hooks schema 8 to 10").
Empty hooks databases initialize the same embedded schema atomically in one
transaction. Existing databases retain one transaction per numbered upgrade;
already applied versions do not acquire redundant writer locks. Initialization
and upgrades keep the existing writer deadline and roll back on failure.

`delivery.surface.<id>` is an `on|shadow|trial|off` setting at global/project scope.
`trial`, the default for surfaces added after the ledger, resolves per session
inside the write transaction: shadow until 30 shadow firings of the surface
have settled in the project, then a stable hash of session, agent and surface
picks the sending or the shadow arm, and a passed gate makes it `on`.
Node publishes the complete `surfaces` map alongside `scorer` in controls.json
and hook-delivery/<project>.json under its writer lock. The environment override
`MEX_DELIVERY_SURFACES` is an all-surface state or a JSON object for fixtures.

Two derived hints live beside the record. `surface-pending/<session-agent hash>/`
contains empty active/retiring markers; presence only enables a SQLite check,
never authorizes a receipt. The same directory holds `observed`, the
append-only log of calls that delivered nothing, claimed by rename at the next
transaction. Retirement guards survive rollback/crash and are
removed non-recursively after commit. `surface-off/<project>/<surface>` is an
empty marker published only after a committed gate-off transition. Missing
markers cannot bypass the SQLite gate. No authoritative counter or state is
updated through JSON files. `mex-hook --surfaces` accepts project and checkout
on stdin and reads the same bounded projection as `mex what --surfaces`.

A delivery candidate may carry `SessionOnce` (one receipt per entry, session
and agent) and `SessionMax` (receipts per surface, session and agent); both
count shadow receipts and are checked under the write lock.

## Working set

Node writes, Go reads, all under `projects/<id>/working-set/`:

- `<checkout key>.json`: version 1, `head`, `branch`, `defaultBranch`, `made`
  (ISO), `seeds`, `hops`, `words`.
  At most 2 MiB; the hook rejects other versions.
- `<checkout key>.fixes`: "MXF1" then 16-byte little-endian records (FNV-1a 64
  of the checkout-relative path, fix count u32, last fix u32 Unix seconds),
  sorted by key. Written by the code-facts job from its history walk.

Requests are `working-set-requests/<project>~<checkout key>.json`
(`{"project","root"}`), with `working-set-pending` touched in the record
directory. The background loop turns each into a `working-set` job, one open
per project; the hook's background start also checks this marker.

## Delivery additions

Migration 0006 adds `epochs.last_failure`, initially empty. It contains only
the SHA-256 digest of the last observed failing command, including its project,
checkout and working folder. An exact rerun in that epoch establishes
`reproducing`, unless the epoch is `changing`. Observations ride on calls that
already open hooks.db; a tool miss still opens no database. New epochs clear
the digest. Commands and prompt text are never stored by this observation.

Delivery transactions disable connection-local WAL auto-checkpointing so
COMMIT does not perform a checkpoint inside the 250 ms writer deadline.
SQLite still checkpoints on last close. WAL mode, NORMAL sync, lock limits
and operation deadlines stay unchanged; errors still produce empty replies.

Node remains the sole `record.db` writer; Go remains the sole `hooks.db`
writer, including explicit CLI feedback. Node's hooks reader supports schema
6 and refuses future versions without migrating them.

Hooks migration 0003 rebuilds `followups` transactionally to extend its CHECK
set with `failure`, `delivered-later` and `nothing`, retaining the earlier
probe kinds and rows. Upgrade work is bounded at 100,000 rows. Observations
contain receipt identities and closed kinds, never raw prompts/code/commands.
Repeated observations for a receipt/kind are deduped under the writer lock.

Migration 0004 adds `deliveries.detail` and `delivery_conflicts`, keyed by
session, agent, epoch, project, checkout, winner and loser. Existing action
values stay fixed. Similarity and conflicts use `withheld` with a detail;
conflicts enter Review only when their winning entry is present. Companion
admission checks parent plus children atomically. The conflict table is the
bounded hook-written seam for later Review/Hub surfaces.

Migration 0005 adds epoch `intent` (`working`, `investigating`, `changing`,
`reproducing`) and `closed`; new epochs start investigating while migrated
epochs preserve working behavior. Receipt `title`, `kind` and `level` support
read-only explanations without loading entry bodies. `delivery_touches`
stores receipt ids only, for observed later scope touches. These foreign-key
children are pruned in bounded batches before parent receipts/epochs.

Delivered `followed`, `missed`, `opened` and `wrong` probes require the same
session, agent, epoch, project and checkout as their receipt. Explicit CLI
probes require a single active matching context, optionally constrained by
`MEX_SESSION_ID`; ambiguity records nothing. Estimated false sends are closed
deliveries with neither any followup nor a later scope touch. This is an
observation-limited estimate, never a deletion policy.

Daily `counters_go` keys reuse `agent:<agent>:knowledge.delivered` and the
four probe names. Only closed counts enter the existing telemetry rollup;
receipt ids, titles, paths and event text do not. Consent/opt-out behavior is
unchanged.

Files read without SQLite additionally include the existing controls mirrors'
optional scorer value (`delivery.scorer`), and the prompt-only statistics
cache alongside delivery entries. The scorer does not add a no-op file read.
The statistics cache binds its listing stamp and entry hashes to the light
snapshot and stores tf/df/length/field data without original title/body text.
It is disposable; stale or incompatible data is rebuilt through source reads.
Ordinary read-only `mex what` never creates or repairs either database.

Owner: the local record (`src/record/`, `native/record/`).

Everything MEX records about its own work belongs under the MEX home, or the
local database cache described below. CLI, Hub, session lines and reports read
these records. This page covers the two files, their schemas, the usage log,
the own-usage reader, the job model and the background process.

## Hooks schema 8 to 10

Hooks versions 8, 9 and 10 are additive. Node recognizes version 10 read-only;
Go remains the sole writer. An older reader that sees a newer file reports the
version and does not write.

Migration 0008 (search answers) gives `surface_windows` the columns `observed`
(calls seen after the answer), `followup` (a Read overlapped the answered
span), `harm` (a Read of other lines of the same file) and `complete` (the
window saw its full 3 calls). `surface_firings` gains `complete`. A span target
carries start and end lines and an optional digest of the originating tool
call; it holds range numbers and paths, never code text. A window that ends
before 3 observed calls is incomplete and is left out of the settled
denominators. `surface_gates` gains `minimum_avoided_delta` (.30),
`minimum_cost_sessions` (10) and `no_harm_rise` (1), which supplement the fixed
gate; the new `surface_cost_checks` (project, surface, session, agent,
`net_weighted_tokens`) holds the per-session qualification projected from the
task cost ledger. The live cost producer owns its writes; offline replay never
populates it, and without ten priced sessions a trial surface stays in
collecting.

Migration 0009 (budget lanes) adds `deliveries.lane` (default `legacy` for
earlier receipts; otherwise `critical`, `cards`, `prompt`, `brief` or
`ordinary`) and `lane_offers`, one row per canonical entry, checkout, lane and
epoch with the largest rendered `tokens` offered and `budget_held`, so a
repeated rejected offer cannot inflate demand. Budget shares are 20% critical,
40% cards, 15% prompt, 15% brief and 10% ordinary of the epoch budget;
admitted usage is shared across checkouts. A request made through the
controller always uses lanes; a low-level request from before it keeps the
pooled admission. Retention covers lane offers and cost projections. The
read-only surface report exposes lane contention per epoch and span outcomes.

Migration 0010 (false-send counts) adds `epochs.false_send_counted`, the
once-only claim for the daily counts. When an epoch closes, the hook adds two
`counters_go` rows per agent for the day, `agent:<agent>:knowledge.closed_deliveries`
and `agent:<agent>:knowledge.false_send_estimate`; the estimate is closed
deliveries (given or replaced, not corrections) with neither a followup nor a
later scope touch. Counts only; an offline replay writes none. The telemetry
report schema lists both names.

Files the hook reads without SQLite gain one derived hint: `anchor-armed/<session-agent hash>/<checkout-path hash>`,
which only avoids opening SQLite on an unrelated read. Receipts stay
authoritative, and a stale hint can only cost work. The prompt-arm and
anchor-touch moments, and the `prompt-anchor` and `search-span` surfaces, are
new names in `moment` and `surface`; both surfaces default to `trial`. The
light entry snapshot (`delivery-entries/<hash>.light.bin`) is version 2 and
now stores each entry's written `aliases` so a prompt can be matched without a
full parse.

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

Telemetry counter writers use a 1 ms busy timeout and separate 10 ms open and
write deadlines. When either budget expires, the hook appends its counts to
`<record directory>/counters-pending` (one `day<TAB>name<TAB>n` line per
counter, at most 64 KiB) instead of dropping them. The next hook renames that
file to its own claim, adds the counts to its write and removes it; if that
write misses too, everything goes back to the file. Only hook counter names
are read back. A process that dies between the claim and its write loses
those counts; nothing is counted twice. Each hook's counter increments form
one atomic SQLite statement. These short-lived writers
retain the WAL sidecar files for reuse across processes. A private `mode=ro`
attachment keeps a read-only pager alive while the writable main pager closes,
leaving committed counters in WAL instead of checkpointing every hook and
synchronizing its next WAL header. This avoids a second SQLite connection.
The pinned SQLite closes main before attachments; WAL-lifetime tests qualify
that order when upgrading the driver. The attachment holds no read transaction
and cannot write the database. The 1,000-page
automatic checkpoint and WAL/NORMAL policy remain active. Committed counters
survive process exit; a power failure can still lose unsynchronized counters.
The main open and attachment share the same 10 ms deadline. Counter-only
connections retain the 1 ms busy policy across session operations, avoiding a
redundant PRAGMA on each usage write. Ordinary session writers
retain their existing checkpoint and final-close cleanup.

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

Current versions: **record.db = 5; hooks.db = 2**. Record migration 5 adds
`aid_verdicts` and the append-only `decision_events` log. Record migration 2 adds
own-usage reader bookkeeping/windows; migration 3 adds jobs/background
ownership and control/install records; migration 4 adds model admissions and
call attribution. Earlier definitions and rows are preserved. Go's read-only
record reader recognizes version 4. Hooks migration 2 adds delivery accounting,
preserving version-1 rows; Node recognizes hooks version 2 without ever
writing or migrating it.

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
Go. The hook command lives in `native/cmd/mex-hook` in the same module.
The SQLite driver is `modernc.org/sqlite` **v1.62.0**,
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
| `model_batches` (migration 4) | Integer queue PK; admission/owner/project/job identity, automatic mode, state/times, reserved/charged reference units, estimated pricing profile and waiting reason; one running row per machine | Shared model admission owner; `model_calls.batch_id` links calls |
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
| `aid_verdicts` (migration 5) | PK (`project_id`,`entry_id`,`kind`,`text`); `kept`, `reason`, nullable `score`, `margin`, `top_entry`, `review`, `source` (hand/enrich/setup/import/filter), `corpus` digest, `decided_at` | Alias filter |
| `decision_events` (migration 5) | INTEGER PK; `project_id`, `entry_id`, `event` (accepted/withdrawn), `commit_sha`, nullable `landed_sha`, `matched_by` (sha/patch-id/subject-files/revert/missing), `branch`, `actor`, `at`; triggers refuse UPDATE and DELETE | Decision acceptance |
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

All headless setup agents pass through `src/setup/headless-population.ts` and
the shared `src/model-runner/process.ts` owner, also used by the one-shot text
API. Argument/model policy is described in [model-runner.md](model-runner.md).
The bounded observer preserves the existing activity/transcript/usage callbacks,
agent selection, permissions, success/failure handling and stdout. It records after
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

## Model admissions and automatic allowance

Node migration 4 adds `model_batches`: integer queue ID, agent/requested model,
automatic flag, queued/running/done/cancelled/interrupted state, owner/PID,
nullable project/job/batch attribution, created/admitted/finished times,
reserved/charged integer reference-price units, estimated flag, bounded pricing
JSON and an allowlisted waiting reason. A partial unique index permits one
running model batch for the machine. `model_calls.batch_id` is a nullable
foreign key; old calls stay untagged. No prompt or reply is saved in this ledger.

The admission owner in `src/model-runner/budget-queue.ts` commits before a child
starts. Automatic calls explicitly supply a bounded token estimate; process
foreground/background status does not determine whether spending is automatic.
Claims check spend, reservations, controls and visible plan windows in one write
transaction. No transaction spans a model run or queue wait. All supported MEX
headless invocations, including explicit setup, use this lane.

Start at 3% of the larger of seven UTC days and one quarter of 28 UTC days, with
a seven-reference-batch floor. The fixed reference batch is 4,000 input and
1,000 output tokens, valued at the largest shipped agent reference profile.
When no own usage is readable, the fallback is seven admitted automatic attempts
in seven UTC days. Failed/interrupted attempts count; unstarted cancellations
do not. Retries reserve again. Explicit commands are logged and uncapped.

Weights are reference-price estimates, never subscription bills. Own-usage logs
lack model labels; fixed per-agent reference weights and conservative subtraction
of MEX headless tokens value the baseline without changing source counters.
Read projections label this estimated and name the profile. Unknown requested
automatic model prices hold work; observed missing model labels remain unknown.
Price data, long-context/cache assumptions and limits are in model-budget.md.

Reported usage settles a reservation after pipe closure. Missing/estimated
accounting retains at least the reservation. A dead admitted owner leaves a
conservative charge, including linked usage when present; live owners are not
displaced on a timer. Reported actual overshoot is charged before another
admission. This is admission control, not a hard provider token/dollar quota.

Unexpired selected-agent windows at 75% or rejected hold automatic work.
Observations from logs and ephemeral model output use the same normalizer;
only bounded numeric/status/window data is kept. Missing room is unknown.
Eligible explicit commands precede automatic work; automatic work prefers
visible sooner resets, with FIFO ties. Cap/window holds do not block an eligible
explicit command or another provider. Queue waits are at most 30 seconds, with
256 pending admissions; automatic jobs yield rather than occupying the worker.

Job holds preserve checkpoint, batch number and failure count and requeue when
their condition clears. The job writer's home is carried through admission and
accounting. Hooks never join or wait on the queue. Automatic storage failure
holds work. If the record cannot even open for an explicit command, its existing
continue-with-warning accounting behavior remains; coordination is unavailable
for that degraded run. No automatic call uses that fallback.

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
| `epochs` | PK (`session_id`,`agent_id`,`epoch`); `started_at`, `tokens_sent` default 0, `reason` default startup, `budget` default 2000, `reserved_tokens` default 0, `compact_signals` default 0 | Session/compaction lifecycle |
| `deliveries` | PK `id`; `session_id`, `agent_id`, `epoch`, `ts`, `moment`, `entry_id`, `form` (full/one-line/pointer/card), `tokens`, `action` (given/withheld/replaced/held-back), `content_hash`, `block_id`, `project_id`, `checkout` | Delivery check-and-mark transaction |
| `aliases` | PK (`project_id`,`checkout`,`old_id`); `new_id`, different from old_id | Explicit merge identity; Go writes |
| `followups` | INTEGER PK `id`; `delivery_id`, `ts`, `kind` (followed/missed/opened/wrong/edit/command), nullable `detail` | Delivery feedback |
| `verdicts` | PK (`project_id`,`checkout`,`entry_id`); `verdict` (held/changed/broken/unknown), `inputs_hash`, `checked_at` | Check evaluator |
| `ledger` | PK (`session_id`,`agent_id`,`lever`), raw `tokens_removed`, `turns_carried`, `cost_tokens`, `refetches` and optional `saved_input_millitokens`, `cost_input_millitokens` | Lever accounting |
| `ledger_settlements` | PK `session_id`, `ended_at`, optional `price_profile` | Lever accounting |
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
The compaction check writes a `deliveries` control observation in the new
epoch with moment `compaction-check`. Its `detail` contains `kept`, `checked`,
and `estimated: true` and may flag `partial` evidence. The estimated kept-rate
is kept divided by checked when checked is positive. A missing or oversized
summary has checked equal to zero. The observation contains only counts and
flags. Unlabeled typed rows count only beyond the session's filter
acknowledgment. The last request stays eligible regardless of acknowledgment.
The 400-token estimated recovery budget reserves 150 tokens for MEX notes
when the checked items and notes can both be sent.

`mex compact` uses bounded host transcript tails to estimate the window from
three distinct qualifying sessions. It saves an accepted offer's byte snapshots
under `record.db.settings` in scope `compaction` before updating the host file.
Claude's window uses its canonical `modelSettings` name for dated and `[1m]`
variants. Codex's `model_post_turn_compact_threshold_percent` is an integer
percentage of the reported usable context window.

`mex compact off` and uninstall both use the snapshots to restore prior
settings. Uninstall reports manual compaction edits as conflicts and continues
removing hooks. It retains the recovery record when the user requests a purge
with an unresolved conflict. The `compaction-watch` file wakes the background
reviewer. The kept-rate rule pauses an accepted setting if two of its last three
complete checks since acceptance fall below 90%. Each check must cover at least
five items. A reread spike can also pause the setting. Ledger review uses
settled host compactions whose sessions began after acceptance in the
applicable scope and model. A negative priced net or ten such sessions at
break-even produces a report. Ledger rollback stays report-only while
avoided-call credit is pending.

The background worker checks qualification after session starts, compaction
events and session ends. It stages a hint for the next main session start or
typed prompt on that host. Codex hints are scoped to the qualifying checkout.
`notices_shown` claims the person-line offer once per host across sessions.
The topic nudge uses hashed prompt terms and the latest recorded request size
and also goes only to the person.

### Token lever ledger

Claude Code hooks record numeric control receipts in the active main epoch
for outline and shell-output replacements, subsequent successful reads of
outlined files, outline denials, and explicit `mex out` refetches. The Codex
wrapper records its before and after view when the command and session can
be identified. Sizes include the text MEX adds to the shortened view.
Hosts can further truncate those views before passing them to the model.

After an interactive `SessionEnd`, the background reads the complete host
transcript (up to 32 MiB) and the receipts for that checkout. It parses one
transcript at a time and releases the body before awaiting settlement. It counts
distinct model requests through the next context boundary or session end.
It carries each reduction for its own request count and charges the full
input and output of a request that consumes a refetch or denial. Multiple
refetches or denials consumed together share that request charge per lever.
Compaction uses the input reduction observed across the host boundary and
accounts separately for the summary call and the first confirmed reread of
each unchanged path from the previous context. A successful recorded edit
since the last read rules out a charge. The checkout file must also have
modification and change timestamps older than that read. Missing, redirected,
or later-modified files are skipped because their earlier state is uncertain.
The compactor's reported usage takes precedence when available. Otherwise
MEX estimates its cost from the sizes on each side.

View changes use UTF-8 bytes divided by four, rounded up per view. Carried
context uses the observed fresh-input, cache-write and cache-read mix.
A new tool result's first send uses the observed cache-write duration mix
or the fresh-input rate on uncached requests. With no split, Claude's first
send uses the five-minute write rate, Codex's first send uses fresh input,
and later sends use the cache-read rate. Compaction can use the observed
pre-boundary context mix for the first carry of its existing prefix. A
refetch charges the full consuming request, including output. When summary
usage is unavailable, the estimate values the before size as fresh input
and the after size as output.

The runtime and replay share PR #396's reference table in
`src/shared/delivery-prices.json` under profile `saved-session-reference-2026-11-16`.
The CLI bundles this table. Values are input-equivalent tokens at the common reference
of $1 per million fresh input tokens. Known Claude models use their per-class
rates. Codex and unknown models use the reference class weights of 1 for
fresh input, 1.25 and 2 for five-minute and one-hour cache writes, 0.1 for
cache reads, and 5 for output. Hook time is valued at the observed output
throughput and its output rate. The fallback is 50 output tokens per second
at the first request's rate. These are estimates of relative cost.

Go atomically replaces the finished session's terms in `hooks.db.ledger`
and records its `ended_at` and price profile in `ledger_settlements`.
A retry of the same end and profile reuses the settled terms.
`sessions.last_seen_at` is the hook activity clock. Each term covers
reductions with one carry length. The base lever row holds the costs and
refetch count, and further terms use `lever#turns`. The priced net sums
`saved_input_millitokens - cost_input_millitokens` in thousandths of an
input-equivalent token. Priced savings already cover every carried turn.
Raw counts remain available for comparison. Incomplete usage and rows
without the current price profile or complete priced values are excluded
from priced decisions.

The shared `LEDGER_MODE` switch defaults to `report-only`. When the latest
ten evaluated sessions for a tool lever net zero or less, the worker
publishes a separate notice for the current trial and leaves its gate
file untouched. A losing compaction setting gets its own report per
acceptance. The person sees each notice once. The enforcement path can
write `ledger-off.<lever>` or restore the accepted setting's prior bytes
when the switch is enabled. `mex on --lever <name>` starts a fresh trial
across checkouts for `outline`, `shell-trim` or `codex-wrapper`. Only sessions
started after the reset enter that trial. Previously outlined files retain
their edit guards within their context.

### Holdout study and session report

`mex report --ledger` shows the current checkout's local measurements. Add
`--json` for the same data as JSON. The plain `mex report` still shows advice
advisories. The ledger groups by host and model and shows one actual session
at the median observed spend per group (the lower of the two middle sessions
for even samples). Its host-compaction and MEX tool-lever nets are shown
separately. They are estimates and can overlap. The report uses the latest
256 measured sessions for this checkout and the current price profile.

The final-context figure estimates the MEX text sent through the main hook
since the last observed context reset and by the time of the last measured
model request. Go counts the marked, rendered context bytes as tokens after
successful output. The report leaves this figure unavailable when the start
receipt is missing or a reset happened after the last request. Host pruning
and summary text, separately loaded rule files, subagent context and tool
output are outside that estimate.

`mex report --holdout on` opts this installation into a local study.
Enrollment is off by default. Each fresh, hook-enabled, capture-enabled
Claude Code or Codex session gets a stable assignment at startup. A random
study seed and the session ID assign about 10% to the holdout. A holdout
suppresses automatic MEX hook delivery, tool rewriting and compaction
interventions. Local journaling and capture-filter work continue under the
existing capture settings in both arms. Explicit `mex note:` commands still
save the note and show the person a confirmation. MEX records the assignment,
transcript location and settlement metadata locally so it can measure the
session. Both arms use the host's current settings, native compaction and
already installed rules. Opting out with `mex report --holdout off` stops the
study immediately. Re-enabling
starts a separate study. Completed samples keep their original assignment.

The report compares complete transcripts that started and finished in the
same study without recording a different checkout. It waits for five sessions in
each arm with the same host and model. Assignment and measurement counts
make it visible when transcripts are incomplete, exceed the 32 MiB read cap
or belong to sessions still in progress. It shows the median observed spend
and request count for each arm and their interquartile ranges (the middle
50%) in text and JSON. It labels the estimates early and noisy until each
arm has about 20 sessions. It also shows the difference in median spend and a
signed estimate of avoided calls valued at the median holdout session's
observed per-request cost. That estimate describes part of the whole-session
difference and is never added to it. Observed spend includes model requests
with usage in the transcript. Sum-of-ledger costs can also include estimated
compactor calls, refetches and hook time. The reference weights express
input-equivalent tokens. The report omits subscription allowance because
account-level utilization cannot attribute a percentage to these sessions.
The worker reads the host transcript in memory and settles numeric
projections, the model and the study assignment. The study calculation and
report run without model calls.

Whole-session holdouts measure request counts across all MEX hooks together.
They provide no per-lever avoided-call credit or comparable solved-task
cost for the `search-span` trial. The `surface_cost_checks` projection still
requires isolated trials with completed, comparable tasks. Tool auto-off
and ledger-driven compaction rollback stay report-only while the per-lever
credit is pending.

Hooks migrations 0011 (ledger settlements), 0012 (pricing), and 0013
(study assignments and session metrics) follow the upstream migrations
for search answers, budget lanes, and false-send counts. Earlier settlements
without session metrics remain available to the per-lever ledger.

Indexes cover active sessions by project/time, deliveries by session/agent/epoch/
entry/time and by time, followups by delivery/time, journal by session/id, and
outputs by session/number. `moment`, `lever`, agent and job kinds remain open
text because their owning delivery/adapter/job contracts evolve independently.

## Crossing the line

### Delivery transaction (hooks migration 2)

`record.CheckAndMark` obtains `BEGIN IMMEDIATE` using the existing short-wait
retry policy and 200/250 ms writer bounds. It checks session ownership and
pause, throttles `last_seen_at` updates to 30 seconds, ensures the epoch,
resolves aliases, checks presence and admission against the locked budget,
inserts receipts and updates token totals before committing. A failed call
rolls everything back and returns no receipts. Render only after success.
Admission receives both the current epoch and the agent's session token total.
Reserved/exempt candidates bypass main-budget admission but remain counted.

Presence is keyed by session, agent id, epoch, project, checkout and canonical
entry id. The project/checkout fields prevent the same id in two repositories
from colliding. A receipt has a random id and a block id shared by the receipts
in one reply, and the reply's context block starts with `[mex <block_id>]`.
`content_hash` covers the entry file's hash and the text sent, so a resume can
tell an entry whose text changed. Existing receipts migrate with empty new
fields. A candidate marked `Correction` is written once per entry per epoch,
only when that entry was given in the epoch, in the reserved lane. A candidate
marked `Resend` is given again although the epoch has it (the transcript shows
a rewind dropped it). Withheld and held-back outcomes are written once per
entry per epoch. `Presence` reads what an epoch gave, with the blocks that
carried it, without the writer lock; `EpochGiven` and `EpochFiles` read an
epoch's deliveries and edited files for recovery, resume and subagent briefs.

`epoch_files` (PK session, agent id, epoch, project, checkout, path) holds the
files edited in an epoch that some entry's scope covers, at most 512 per epoch,
written by `NoteEdits`; pruning removes at most 256 rows per start.

Epoch reasons are startup, compact, clear, fork, subagent and rewind. Resume
keeps the epoch. Startup and repeated subagent registration are idempotent.
Compaction signals use bits (SessionStart=1, PostCompact=2, reserved coverage
confirmation=4): different signals confirm one transition, and seeing a signal
again starts the next cycle. Signals without model metadata retain the known
budget. Clear/fork represent explicit transitions; no payload event id exists
to distinguish their retransmission from a second requested transition.

Aliases are scoped to a project and checkout, survive hook processes, and are
resolved before dedupe. Cycles or chains over 64 links fail open. The entry
format has no successor field; callers must supply aliases from an explicit
merge operation rather than infer them from retirement text.

At startup/clear, inspect at most 64 sessions older than 30 days and retain
any with a recent file heartbeat (or uncertain heartbeat access). Delete at
most 256 followups, 256 receipts and 64 empty epochs per transaction.
No cascading deletion. Sessions and other owners'
records remain. There is no cap on entries remembered in an epoch.

### Control policy (foundation-04 slice two)

No database schema change. Node owns global settings `enabled` and
`capture.enabled` (scope `global`) and project `capture.enabled` settings;
Go owns `sessions.paused`. Node publishes bounded `controls.json` in MEX home
and `hook-capture/<project-id>.json` in the record directory. Go publishes
`hook-paused/<shortHash(agent + NUL + session-id)>` with the session transaction.
The hook reads these without opening Node's database. See
[agent-controls.md](agent-controls.md) for defaults, precedence, publication,
recovery and the version-one `consume_prompt` reply addition.

Session pause is preserved through same-ID resume/compaction; lifecycle writes
must not reset it. New session IDs start unpaused. Global off does not erase
per-checkout or session choices, and capture has independent project/global
choices. A Node writer can repair its own settings mirrors; readers never do.

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

### Delivery's own files (record directory)

| File | Holds |
| --- | --- |
| `delivery-entries/<key>.json` | Full parsed entries per checkout, reused by size and modification time |
| `delivery-entries/<key>.light.bin` | The light index (ids, kinds, scopes, triggers, command targets, one-line forms) with a stamp over the stores' listings |
| `delivery-transcripts/<hash>.bin` | Per Claude Code transcript: bytes read, the active branch's blocks, and parent links |
| `delivery-hints/<short hash of project id>.json` | Written by Node (`writeHintMirror`) after every hint change: `{"version":1,"agents":{"<agent>":[{"id","expires"}]}}` |

All are disposable caches except the hint mirror, which Node rewrites; a
missing or unreadable file falls back to the slow path or to "no hints".

## Files the hook reads without SQLite

Opening SQLite costs the hook shim milliseconds on every call, so the shim
reads small plain files that Node keeps beside the databases. The databases
stay the source of truth: whoever changes the rows rewrites the file, and a
missing or unreadable file means "MEX is off here", which is the safe answer.

| File | Written by | Read by | Shape |
| --- | --- | --- | --- |
| `<record directory>/hook-checkouts/<key>.json` | Node, `src/record/hook-checkouts.ts`, after any change to a `checkouts` row (`RecordWriter.writeHookCheckouts()`; registration calls it, `mex off`/`on` must too) and on the first open of a record that has none | the shim, `native/internal/hook/checkout.go` | `{"version":1,"project_id","root","state","off_until","provisional"}`, one per `checkouts` row; `key` is the 24-hex short hash of `root`, the real checkout path |
| `<record directory>/hook-notices/off-<key>` | the shim | the shim | created with exclusive-create when the "MEX is off here" notice is shown; `key` is the short hash of the repo root (nearest folder holding `.git`, else the folder) |
| `<record directory>/counters-pending` | the shim, when a counter write misses its deadline | the shim, on its next counter write | `day<TAB>name<TAB>n` lines of hook counters only; at most 64 KiB; claimed by rename (`counters-pending.<pid>.claim`) and removed once added |
| `<record directory>/compaction-pending/<key>/<epoch>.json` | the delivery controller on PostCompact | the delivery controller when the context resumes | One checked recovery block of up to 249 estimated tokens, scoped to the session, agent, checkout, and epoch. The claim is recorded in `notices_shown` and the file is removed after the claim. Pending blocks expire after ten minutes. |
| `<MEX home>/bin/launcher.json` | Node CLI, after every command (`src/hooks/shim/launcher.ts`), only when the home exists and the entry is a built `.js` | the shim | `{"version":1,"node","entry"}`: how to start `node <entry> __ensure-background` |
| `<MEX home>/heartbeats/<agent>/<session>` | the shim | `mex-hook --status` | one small JSON file per session; its modification time is the last hook call; pruned after 7 days at session start |
| `<record directory>/index-checkouts/<key>.json` | Node, file index | the shim | see the file index contract |
| `<record directory>/check-entries/<key>.json` | the check evaluator (the shim's free stage, `mex check`) | the check evaluator | a cache of parsed entry files by path, size and modification time (`docs/design/knowledge-checks.md`); `key` is the short hash of the checkout root; safe to delete |
| `<record directory>/check-entries/<key>.stage` | the shim, when the free stage hands its rest to a detached run | the shim | empty lock file: one detached `--check-stage` run per checkout; older than 40 s means its run died |
| `<record directory>/delivery-entries/<key>.json` | Go delivery snapshot loader | Go delivery | bounded cache of full parsed entries by path, size and modification time; key is the short hash of project id, newline and checkout; source metadata is checked on every load; safe to delete |

File heartbeats remain for calls that do not open SQLite. Lifecycle transactions
also update `sessions.last_seen_at`; `mex-hook --status` reads both sources and
counts a session once. The database status reader never creates or migrates a
file. It bounds recent-session reads to 10,000 and falls back to file sightings
on failure. See `delivery.md` for the measured heartbeat choice.

The checkout lookup follows `RecordWriter.checkout`: walk up from the folder of
the touched file (or the session's `cwd`), accept a registration found there,
and stop at an unregistered folder holding `.git`. A folder (non-Git) project
covers only its own folder unless it holds `.git`. The shim first tries the
path as given and resolves links only when that finds nothing, because
resolving links opens a file handle on Windows. `state` is `on`, `off`, or
`off until` with `off_until` an ISO time; past that time the checkout is on.

The record directory is MEX's home unless the home's `location` pointer names
the cache folder; the shim reads the pointer and skips network detection.

The heartbeat files stand in for `hooks.db` `sessions.last_seen_at` until the
first ticket that opens `hooks.db` on the hook path (delivery-01) moves them
there.

## Changes

- Hooks version 10 (delivery-02, second pass): migrations 0008 span windows and gate
  settings, 0009 budget lanes, 0010 once-only false-send count claims; two daily
  counters; one derived anchor hint file; light entry snapshot version 2.

- Version 3, foundation-03 additions (no schema change): plain files the hook
  reads without SQLite (hook checkout mirrors, the off-notice markers, the
  launcher file, heartbeat files), so the shim knows where MEX is on and can
  start waiting background work at session start.

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

### Output presentation state (hooks migration 0014)

Go owns `lever_state` in hooks.db, keyed by agent, session_id and subagent.
The state includes at most 1 MiB of each outlined read for the later read-risk
scan; its total JSON is capped at 4 MiB. The JSON state and the machine-wide `outline_guard` counters change in one
bounded immediate transaction. `compact_nudge_state` holds independent topic
memory, so the nudge keeps working while output levers are off. Startup prunes
at most 256 rows older than seven days per table. Node never writes these tables.
`mex on --lever outline` publishes the existing rearm timestamp; Go consumes it
under the same lock and resets the guard once. Old JSON state is not imported.
