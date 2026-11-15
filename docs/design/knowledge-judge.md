# Knowledge judge: jobs and fix routing

OSS-47, slices 1 and 2. The judge resolves entries whose free checks say changed
or broken, and opportunistically rechecks held entries with complete checks
whose input bytes changed. It stores judgments locally and routes validated
rewrites according to who changed the code. Rule-change evidence, corrections
for delivered advice, and the `sync` command change follow separately.

## Scheduling and ownership

After its free check stage, the hook atomically replaces one version-1 request
per checkout in `<record directory>/judge-pending/<checkout hash>.json`.
The request contains project and checkout identity, the originating host and
session, nearby paths, a generation, and a not-before time. A free stage with
unresolved or spare work requests judging at session start; edits debounce for
30 seconds. Stop releases an existing request from that session and preserves
its nearby paths. Empty and unchanged checkouts do not create jobs. These are hints,
not authority: Node checks the registered checkout and off switches again.
No session text goes into requests. Go confines request writes through
`os.Root`, refuses a redirected request directory, and never writes Node tables.

The background process consumes at most 32 requests per pass, rotating its
cursor so paused checkouts do not starve later requests. It registers the
`judge` kind with the existing project job runner. The existing one-job-per-
project rule also serializes worktrees. Requests behind an unfinished job
remain pending. The job commits before its request is consumed. An atomic
claim preserves concurrent replacements, and interrupted claims recover on
later bounded passes. Both dispatch and claim recovery rotate their cursors.
Hooks start Node detached and never wait for a model.

Within a job, unresolved entries come first, ordered by path proximity to
recent work and then stable entry ID. Held complete entries follow only after
unresolved work. A model batch contains at most five entries sharing a source
file. Hints retain their separate disposable lifecycle; unknown entries and
retired or ambiguous duplicate IDs are not certified by the judge.

Every model call uses the shared text-only runner with role `cheap`, purpose
`judge`, and an automatic allowance reservation. Model names, the machine-wide
queue, usage accounting, cap and window policies stay with that runner. A cap
hold leaves the job waiting at the same batch without counting a failure.
An edit holds an already queued job too; it cannot bypass the idle deadline
by starting from an older request. A first-batch budget wait retains the
original checkout position in its checkpoint.
Existing delivery verdicts continue to govern pointers and withholding.

## Evidence and results

The native evaluator runs asynchronously before each batch so Node's lease
heartbeat continues. It supplies current verdicts and check observations.
Each item names the exact entry-byte hash, and each evaluation names its
actual target-file reads. The judge checks those against its evidence before
spending on a model. Missing provenance stays unresolved; a racing evaluation
runs again. Recent path hints are scoped to the requesting session.
Each model request includes the claims, original checks, current observations,
current source and whole-file changes, including changes outside an anchor's
symbol. The judge searches at most 32 file-history commits for the exact
SHA-256 baseline recorded by a check. A missing baseline is explicit; it is
never replaced by an invented diff.

One source file is limited to 64 KiB, a batch to 16 files and a 256 KiB prompt,
and history collection has a 30-second deadline. Entries retain the existing
10,000-entry / 8 MiB scan bounds. Oversized groups split; an entry without
complete safe evidence finishes as a gap without a model call. Possible
secrets are checked in raw strings and structured values before JSON escaping.
These limits are implementation bounds, not measured
quality or token-saving claims.

The model returns exactly one structured result per entry: `still-true`,
`rewritten`, or `cannot-tell`. A rewrite contains text, a one-line claim and
new check targets. The native evaluator records the proposed checks against
today's code; model-supplied hashes or observations are never accepted.
Unrecordable checks leave the answer `cannot-tell`.
An answer cannot certify a fact whose complete checks prove it broken; that
disagreement also remains `cannot-tell`. Locally retired entries are skipped.

Results are labelled `checked by model`. The existing `judgements` table
holds the outcome keyed by project, entry and exact evidence hash. A bounded
`settings` value under the project scope, key
`judge.<checkout hash>.<entry id>`, holds the latest structured result and
optional rewrite. It includes checkout, branch, HEAD, entry-byte hash, a
fingerprint of evaluator observations, and all supplied source hashes,
including new check dependencies. No schema migration
or public package export is added.

Before saving, the job proves the entry, all source bytes, branch, HEAD and
consent still match. The evaluator also runs after a model reply so a changed
index-backed observation discards the answer even if explicit file hashes
did not change. Cached answers bind those observations too. Publication checks
runner ownership under the local record transaction. An in-flight change
discards the answer. A branch or HEAD
change between batches ends the old job with a gap; a subsequent hook request
can start a job for the new position.

Judgments and their structured payload commit together before the generic job
checkpoint. A killed runner can replay that batch without another call when
the entry and all judgment inputs still match. Partial model output is never
stored. Node never writes `hooks.db` verdicts.

## Where fixes land

Every fix first checks for an existing local or fetched `mex/fix-<entry id>`
branch. A matching branch, or unavailable refs, sends the candidate to Review;
the background job never creates, checks out, stages or commits a branch.
Personal rewrites otherwise update the local note store atomically. Team
rewrites caused by pulled changes, uncertain results, or ambiguous ownership
become Review rows. The row's ID also identifies its immutable proposal in
project settings, so a later judgment cannot replace its evidence. The Review
card and branch creation belong to the surface workflow.

For an automatic team update, an explicit tool edit must prove the whole
change from the note's recorded file baseline to today's bytes. The hook pairs
pre/post edit events, computes the expected result from the tool input, and
retains only before/after hashes. Reads and shell commands do not establish
ownership. Every evaluator input needs a unique authored baseline and, when
changed, a matching edit proof. Unowned extra dependencies go to Review.
Chained edits preserve the original baseline. Failed, unpaired,
ambiguous, oversized or concurrent edits lose the proof; a Git move clears it.
Proofs bind the main session, host, checkout, branch and HEAD. Git metadata is
read directly, including linked-worktree and packed-ref layouts; the hook
never executes a Git command. One proof file per checkout is limited to
128 files / 64 KiB, with source files limited to 64 KiB.

An owned team rewrite first queues its exact diff for the originating session's
person-visible hook channel. It waits until Go has written the complete reply
and recorded a `notices_shown` receipt. It then rechecks branch, HEAD, original
entry, all source hashes, evaluator observations, ownership, retirement,
consent and runner ownership before applying through the existing team writer.
A visible follow-up says which file changed and that it belongs in the same PR.
Final publication runs under a Git-owned, verify-only prepared transaction
holding HEAD and its referent. The branch, inputs, ownership and consent are
checked again under those locks. The transaction always aborts, disables
reference hooks, and changes neither refs nor the index. Git releases its locks
on stdin EOF if the Node worker dies. Busy or unsupported Git transactions keep
the fix in Review. These are background commands; hooks still read metadata
directly. Session pauses are honored at queue admission, before and after a
model call, and before applying a fix, using both Go's row and pause mirror.
Other sessions and branches cannot display or acknowledge that preview. If the
originating session never reaches another visible hook, a five-minute wait
limit moves its team fix to Review; ambiguous provenance also goes there. This
is an implementation limit, not a measured session-length assumption. A commit before the proof is
consumed also takes the conservative Review path because HEAD changed.

Routing intents commit with judgments in `settings`, before the job checkpoint.
Each batch holds at most five intents of at most 256 KiB each. Exact after-bytes
make a crash after file publication replay safely. Old cached judgments route
without another model call. Notices use a bounded list of at most 16 IDs per
session, with exact primary-key reads rather than a hook-side queue scan.
Deleted notice IDs are removed from hints, and required previews take priority
over old status lines so a full hint list cannot silently block publication.
No database migration, dependency or public package export is added.

## Verification

`src/judge/__tests__` covers queue order, five-entry batching, whole-file
context, real shared-cap admission, replay, malformed replies, native check
recording and in-flight changes to source, entries, branch and consent.
The native integration tests build the real hook/evaluator and use fake models.
They cover both a local candidate and the full paired-edit, visible-preview,
receipt and same-working-tree update path, with one model call. Routing tests
cover pulled personal/team changes, existing local and fetched fix branches,
changed previews, cancellation, retirement, replay and unrelated branches.

Go hook tests cover host identity, start/edit/idle timing, bounded atomic
request replacement, wake-up ordering, edit provenance, preview isolation,
failed stdout writes and redirected-directory refusal.
Real process tests stop the request consumer before enqueue, after enqueue
and during consumption, then prove recovery leaves exactly one durable job.
Existing job and background-process tests retain restart and lease coverage.
No real model or live agent session is needed for these checks. Model quality
and the paid end-to-end evaluation remain OSS-68.
