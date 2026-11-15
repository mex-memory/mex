# Knowledge judge: job and queue

OSS-47, first slice. The judge resolves entries whose free checks say changed
or broken, and opportunistically rechecks held entries with complete checks
whose input bytes changed. This slice stores judgments and candidate rewrites
locally. Applying rewrites, Review routing, rule-change evidence, corrections
for delivered advice, and the `sync` command change follow separately.

## Scheduling and ownership

After its free check stage, the hook atomically replaces one version-1 request
per checkout in `<record directory>/judge-pending/<checkout hash>.json`.
The request contains project and checkout identity, the originating host,
nearby paths, a generation, and a not-before time. Session start and Stop make
work eligible immediately; edits debounce for 30 seconds. These are hints,
not authority: Node checks the registered checkout and off switches again.
No session text goes into requests. Go confines request writes through
`os.Root`, refuses a redirected request directory, and never writes Node tables.

The background process consumes at most 32 requests per pass, rotating its
cursor so paused checkouts do not starve later requests. It registers the
`judge` kind with the existing project job runner. The existing one-job-per-
project rule also serializes worktrees. Requests behind an unfinished job
remain pending. Hooks start Node detached and never wait for a model.

Within a job, unresolved entries come first, ordered by path proximity to
recent work and then stable entry ID. Held complete entries follow only after
unresolved work. A model batch contains at most five entries sharing a source
file. Hints retain their separate disposable lifecycle; unknown entries and
retired or ambiguous duplicate IDs are not certified by the judge.

Every model call uses the shared text-only runner with role `cheap`, purpose
`judge`, and an automatic allowance reservation. Model names, the machine-wide
queue, usage accounting, cap and window policies stay with that runner. A cap
hold leaves the job waiting at the same batch without counting a failure.
Existing delivery verdicts continue to govern pointers and withholding.

## Evidence and results

The native evaluator runs asynchronously before each batch so Node's lease
heartbeat continues. It supplies current verdicts and check observations.
Each model request includes the claims, original checks, current observations,
current source and whole-file changes, including changes outside an anchor's
symbol. The judge searches at most 32 file-history commits for the exact
SHA-256 baseline recorded by a check. A missing baseline is explicit; it is
never replaced by an invented diff.

One source file is limited to 64 KiB, a batch to 16 files and a 256 KiB prompt,
and history collection has a 30-second deadline. Entries retain the existing
10,000-entry / 8 MiB scan bounds. Oversized groups split; an entry without
complete safe evidence finishes as a gap without a model call. Possible
secrets are not sent. These limits are implementation bounds, not measured
quality or token-saving claims.

The model returns exactly one structured result per entry: `still-true`,
`rewritten`, or `cannot-tell`. A rewrite contains text, a one-line claim and
new check targets. The native evaluator records the proposed checks against
today's code; model-supplied hashes or observations are never accepted.
Unrecordable checks leave the answer `cannot-tell`.

Results are labelled `checked by model`. The existing `judgements` table
holds the outcome keyed by project, entry and exact evidence hash. A bounded
`settings` value under the project scope, key
`judge.<checkout hash>.<entry id>`, holds the latest structured result and
optional rewrite. It includes checkout, branch, HEAD, entry-byte hash and all
supplied source hashes, including new check dependencies. No schema migration
or public package export is added.

Before saving, the job proves the entry, all source bytes, branch, HEAD and
consent still match. Publication checks runner ownership under the local
record transaction. An in-flight change discards the answer. A branch or HEAD
change between batches ends the old job with a gap; a subsequent hook request
can start a job for the new position.

Judgments and their structured payload commit together before the generic job
checkpoint. A killed runner can replay that batch without another call when
the entry and all judgment inputs still match. Partial model output is never
stored. Neither entry files nor `hooks.db` verdicts are changed by this slice.

## Verification

`src/judge/__tests__` covers queue order, five-entry batching, whole-file
context, real shared-cap admission, replay, malformed replies, native check
recording and in-flight changes to source, entries, branch and consent.
The native integration test builds the real evaluator and uses a fake model;
it proves a broken verdict produces a local rewrite with freshly recorded
checks while both source and entry bytes stay unchanged.

Go hook tests cover host identity, start/edit/idle timing, bounded atomic
request replacement, wake-up ordering and redirected-directory refusal.
Existing job and background-process tests retain restart and lease coverage.
No real model or live agent session is needed for these checks. Model quality
and the paid end-to-end evaluation remain OSS-68.
