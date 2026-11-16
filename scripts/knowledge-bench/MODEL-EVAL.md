# Judge model evaluation (OSS-68)

Question: what are the end-to-end false rejection and stale-miss rates when
the model writes the checks too?

This is a separate, manually approved paid experiment. The default command
only prepares a plan, costs $0 and never launches a model. Neither CI nor
`npm run gates` runs this experiment. Deterministic tests use fake replies
with the real evaluator, queue, judge and delivery controller; their results
say nothing about model quality.

The current model CLI uses the separately versioned reviewed-v2 protocol and
measurement at the end of this document. Earlier tables preserve legacy v1
inputs and labels; they are not measurements of the clarified v2 claims.

## Legacy v1 sample and scoring

Use the existing public Hono corpus, pinned to digest
`6d693e9985c432356f6f0f1bf5319bc87559bece082cbb40314ce6637c69b687`.
There are 46 hand-written claims and six source checkpoints. The model sees
only the seed claim and its full C0 source file, never the old check targets,
truth functions or labels. It proposes 1–4 checks per claim; Go records their
observations. No hand-written check is substituted after a bad reply.
Before recording, the writer registers only the model-proposed literal
patterns and refreshes their counts in the real index. Structural patterns
are not advertised because the recorder cannot mint them. Proposed targets
and failed-generation IDs remain in the private report for diagnosis.
Exact-file pattern checks retain the source hash and supply the source/diff
to the judge; a stale indexed count cannot mint a new baseline.

The production secret guard blocks the public basic-auth example (`b03`).
That case remains in every denominator as privacy-withheld; its source is
not sent. The other 45 claims form 20 check-writing calls. The unchanged
ordinary judge job then runs at C1–C5, with normal admission against an isolated
record containing synthetic allowance. Each checkpoint refreshes the file
index, evaluates checks, runs the queued judge, publishes the native verdict
cache and asks the native delivery probe about every original claim.
Team corrections go to Review; the experiment does not apply them to the
seed entries, so later checkpoints continue testing the same original facts.

Pass rule: a completed measurement must report all 46 cases at all six
checkpoints, per-call and total input/cache/output tokens, generation/privacy
failures, uncertainty, true entries kept and stale entries caught. Transport,
usage, approval or work-bound failures leave a partial report marked
`complete: false`. A completed report can contain judge failures and poor
scores: `complete` does not mean that a quality threshold passed.

- **True kept:** the original full claim is delivered and not rewritten.
  `true_not_kept / true_total` is the operational false rejection rate; it
  includes pointers, misses and uncertainty, rather than silently dropping them.
- **Stale caught:** the original full claim is not delivered, and a broken
  deterministic verdict or accepted model rewrite proves the old claim was
  rejected. Unknown withholding alone is not a catch.
  `stale_not_caught / stale_total` is the operational miss rate; stale full
  delivery is also reported separately.
- Generation failures and privacy withholding remain in the denominators.
  Zero-sized rates are `null`. Rows include the native verdict, final model
  judgment and delivery form for diagnosis. This measures rejection of the
  original claim; it does not independently establish the semantic correctness
  of every replacement sentence.

The six true/stale denominators are 46/0, 43/3, 41/5, 37/9, 32/14 and 31/15.
Report results beside the historical **41/42 true kept and 16/16 stale caught**,
explicitly as different samples. Do not infer an improvement from those
different denominators or add checkpoints as if they were independent claims.

## Accepted legacy measurement checkpoint

The accepted measurement ran on `a1c5dbb8cc73e1fa914b172ea01687551ae43337`.
The subsequent delivery-expiry fix is committed in
`2eefa7f9c56977478e02fdbe94b207f0e5f698d8` and was verified without another
model run. Raw reports, proposals and account details remain private.

| Checkpoint | True kept | Stale caught | Stale original full text |
| --- | --- | --- | --- |
| C0 | 45/46 | 0/0 | 0 |
| C1 | 42/43 | 3/3 | 0 |
| C2 | 40/41 | 3/5 | 0 |
| C3 | 36/37 | 7/9 | 0 |
| C4 | 29/32 | 12/14 | 0 |
| C5 | 28/31 | 12/15 | 0 |

All four former C5 pointer cases (`b05`, `b06`, `b08`, `b09`) deliver full
original text. All 45 privacy-eligible claims record model-written checks,
with zero generation failures or repair calls. The privacy block remains
counted. C5 true losses are two cannot-tell pointers (`v04`, `b13`) and
privacy-withheld `b03`; stale misses are cannot-tell pointers for `k08`,
`b01` and `b04`. A cannot-tell outcome can also represent a rejected rewrite
or check-recording failure; these reports do not distinguish those causes.

The chart labels used in the experiment describe successive runs of the
same corpus, with cumulative changes and newly generated model replies:

| Label | Candidate | C5 true kept | C5 stale caught | Generation failures | Calls | Reported tokens |
| --- | --- | --- | --- | --- | --- | --- |
| Initial | `8fd41d74` | 12/31 | 10/15 | 22 | 49 | 731,518 |
| Patterns | `2cec7f83` | 20/31 | 13/15 | 6 | 76 | 1,092,321 |
| Delivery | `201ac957` | 26/31 | 14/15 | 0 | 127 | 1,830,225 |
| Roles | `a1c5dbb8` | 28/31 | 12/15 | 0 | 94 | 1,312,395 |

These are single attempts, not isolated feature-effect measurements.
Positive stale detection fell from 13/15 in Patterns to 12/15 in Roles;
withholding an uncertain claim is not relabelled as a positive catch.
Every completed run served zero stale original full texts. This does not
independently validate the semantics of every proposed replacement sentence.

The accepted run reports 188 uncached input, 1,224,153 cache-write, 21,489
cache-read and 66,565 output tokens, with reference API-equivalent valuation
$0.306181469. Four completed runs total 346 calls, 4,966,459 tokens and
$1.142882785 valuation. A separately retained, aborted structured-output
attempt on `a029ed9b` made one call before any checkpoint: 16,621 reported
tokens with no observed model identity and a conservative $0.0100738
reservation rather than measured valuation. Across all attempts there are
347 calls and 4,983,080 reported tokens. Known valuation plus reservation is
about $1.153, within the authorized $5 allowance; these are not invoices.

Code checkpoint `2eefa7f9` passes typechecks/build, Go vet/all tests and a
full native-enabled suite of 6,891 tests in 465 files, with 16 tests and two
files skipped, in one 275.24-second macOS run. All 15 CI jobs pass in
[the exact-head CI run](https://github.com/mex-memory/mex/actions/runs/43772624270).
Separate clean-commit gates pass all 283 knowledge checks and both
200-sample timing checks. The overall release profile remains blocked by
five existing unbuilt benchmark adapters; no threshold changed.

## Quote and limits

The prepared run pins `claude-haiku-5-5`. The verified reference price is
$0.10 per million uncached input tokens and $0.50 per million output tokens;
the conservative estimate charges all input at the $0.20 one-hour cache-write
rate and adds 10% routing headroom. See the
[provider pricing](https://platform.claude.com/docs/en/about-claude/pricing).
Prompts over 100k input tokens have different prices; the ledger accounts
for that tier if reported usage reaches it and stops after an estimate overrun.

The counted maximum is **153 model invocations**: 20 initial writers, at
most 20 repair calls, and up to 113 judge calls, including split batches and
two failed retries per checkpoint. Each prompt is capped at 90,000 UTF-8 bytes and each reply at
4,096 output tokens. Allowing another 8,192 system/CLI tokens per call gives
a **$3.66 estimated conservative API-equivalent total**. Request a **$5
allowance** before execution. Actual billing depends on the engineer's
provider/account; this is an estimate, not a guaranteed invoice cap.

The fingerprint binds candidate commit, claim text, truth labels, source
hashes, batches, output schemas, model, price table and limits. The runner reserves before
each call, retains a private cost ledger, stops after unknown/estimated usage
or transport failure, and never silently switches models. The one-shot CLI
uses safe mode, no tools, no persistent session, one turn, zero transport
retries, the same-model fallback, a 4,096-token output limit and a $0.05
estimated per-call budget. The
[CLI budget](https://code.claude.com/docs/en/cli-reference) can overshoot and
does not equal billing enforcement. The provider
[output/retry environment variables](https://code.claude.com/docs/en/env-vars)
are additional bounds. An unexpected extra call is refused by the ledger.

Writers receive exact JSON/schema instructions and the actual indexed
symbol names. Replies are strictly validated locally. After native recording, each same-file batch gets at most one
repair call for rejected claims, with bounded validation errors. Initial
failures stay in `generation_diagnostics`; successful repairs are listed in
`generation_repaired`. A transport, usage or budget failure stops the run.
No hand-written fallback checks or truth labels enter either prompt.
For these facts, source/symbol fingerprints and literal counts must be
supporting: refactoring does not disprove behavior. Only directly stated
key/value observations may be complete. Invalid roles are sent back to the
model for repair rather than silently downgraded. Writer, repair and judge
call ceilings are enforced separately; unused repair slots cannot fund
additional judge calls.

A fresh still-true result can restore a changed supporting check to held.
Go verifies the sealed native evaluation, journal row, entry, checkout and
every source file before caching that result, and delivery labels it
“checked by model.” A changed input, withdrawn result, partial scan or
expired deadline cannot preserve an unverified model hold. Complete broken
checks, unreadable evidence and CI team-only evaluation cannot be promoted.
Delivery also revalidates the proof and today's native input identity before
using a cached model hold, even without an intervening scan. Exact-scope
pattern cache identities include source for older empty-floor checks too.
An accepted fresh model hold is excluded from spare checks, preventing a
second paid confirmation. Altered attestations are not treated as completed
work when the queue resumes.

## Prepare and execute

Prerequisites: a clean committed candidate, Node 22.5+, dependencies, Git,
Go, a full public subject clone and an installed/authenticated Claude CLI
with access to the pinned model. Build the CLI and native evaluator from
the same candidate before the experiment; do not build during its run.

```sh
npm ci
npm run build
go -C native build -trimpath -o /private/tmp/mex-oss68-hook ./cmd/mex-hook
git clone --no-checkout https://github.com/honojs/hono.git /private/tmp/mex-oss68-subject

# Free: inspect the plan and record its approval_hash before authorizing cost.
node scripts/knowledge-bench/model-eval.mjs \
  --subject /private/tmp/mex-oss68-subject \
  --out /private/tmp/mex-oss68-plan.json
```

After the engineer approves the exact fingerprint and $5 allowance, the
engineer starts the paid command, replacing `APPROVED_HASH`:

```sh
node scripts/knowledge-bench/model-eval.mjs \
  --subject /private/tmp/mex-oss68-subject \
  --run --approve-plan APPROVED_HASH \
  --binary /private/tmp/mex-oss68-hook \
  --work /private/tmp/mex-oss68-paid-run
```

Both output paths must be new. A source/code/plan change requires a new
quote and fingerprint. CI and the test-mode/off switches reject paid mode.
The wrapper bundles the repository helpers into ignored `dist/oss68-evaluation.js`
without cleaning other build output; it uses the model runner's transport
seam only to add the experiment's CLI caps, retaining normal process ownership
and accounting. The report records OS, Node and native-binary hash as well
as the candidate and corpus identities.

`--work` contains `report.json`, an isolated user record, and a registered
subject worktree retained for inspection. Model usage is never seeded into
or read from the engineer's actual MEX record. Inspect partial results before
retrying; no automatic paid restart or cleanup occurs. Do not commit/upload
these private run files. Do not force-remove the worktree.

Free verification:

```sh
node node_modules/typescript/bin/tsc -p scripts/knowledge-bench/tsconfig.model.json
MEX_TEST_PREBUILT=1 MEX_TEST_REAL_HOOK_BINARY=1 npm test -- test/knowledge-model-eval.test.ts
```


## Isolated recall follow-up

The accepted checkpoint above stays unchanged. The follow-up records
`judge_diagnostics` for each raw answer and any later validation, repair or
publication rejection. A final `cannot-tell` can therefore be distinguished
from an initial model abstention or an unrecordable rewrite.

When a rewrite's targets cannot be recorded, the ordinary judge may make
one additional cheap-model call for that batch's rejected entries only.
It holds the proposed text fixed and asks for recordable targets with the
real, bounded native errors and currently indexed symbol names. It repeats
ownership, consent, idle and evidence checks before admission and all source
and evaluator proofs before publication. The evaluator still mints every
observation. A denied, malformed or rejected repair stays unresolved; there
is no semantic retry loop. These calls use purpose `judge.check-repair` and
share the existing aggregate judge-call and cost bounds.

For TS/JS symbol checks, evidence may include up to four local files imported
and called inside the checked symbols, one hop only. Each file has the same
64 KiB, containment and secret checks; all supplied helper hashes participate
in freshness and result expiry. Missing or ambiguous imports are not
invented. Additional helper files have no historical baseline unless they
were already original check inputs. Evidence is split or withheld when a
bound is exceeded, never silently truncated.

Use `--checks-from /private/path/to/accepted/report.json` in both the free
plan command and paid command to freeze the preceding model's seed targets.
The report must be complete, have no generation failures, match the pinned
model/corpus/claims/truth/checkpoints/privacy policy, and contain exactly
one valid proposal for every non-withheld claim. Its candidate, source plan
and exact proposed-target fingerprint are bound into the new quote. Earlier
judgements and truth labels are never put in a model prompt.

This mode is labeled `fixed-model-check-replay`: it makes zero seed-writing
or seed-repair calls, records the frozen targets afresh at C0 through Go,
and runs the ordinary judge/repair/delivery chain at every checkpoint. A
seed target that no longer records aborts the replay. All 46 cases remain
in their original denominators. This reduces seed-generation variation;
a single replay still does not establish a statistically reliable gain.


The first fixed-check replay at `1e53edc5` completed with these results:

| Checkpoint | True kept | Stale caught | Stale original full text |
| --- | --- | --- | --- |
| C0 | 45/46 | 0/0 | 0 |
| C1 | 40/43 | 3/3 | 0 |
| C2 | 39/41 | 5/5 | 0 |
| C3 | 34/37 | 9/9 | 0 |
| C4 | 28/32 | 14/14 | 0 |
| C5 | 27/31 | 14/15 | 0 |

All 45 frozen seed proposals record; generation failures remain zero. C5
b01/b04 are now accepted rewrites; k08 is an explicit model abstention.
Diagnostics distinguish b04's initially rejected pattern from its accepted
check repair. The true-not-kept cases are v04 (abstention), b13 (rewrite of
a truth-labelled claim; see the oracle defect below), privacy-withheld b03, and b09 (safe evidence unavailable).
This misses the prospective true-kept floor of 28/31 and is retained as a
negative result, despite the higher stale-detection count.

There were 78 calls: 74 judge and four check-target repairs, no seed writers.
Usage is 156 uncached input + 1,113,749 cache-write + 99,600 cache-read +
64,534 output = 1,278,039 reported tokens. Reference valuation is
$0.281631240. Both figures exclude the historical seed-generation calls,
which remain accounted for in the preceding run. All five complete runs
therefore total 424 calls / 6,244,498 tokens / $1.424514025 reference
valuation. Including the separately retained partial attempt gives 425
calls / 6,261,119 reported tokens and known valuation plus its reservation
of $1.434587825. These are not invoices or subscription surcharges.

The replay exposed a resolver defect: probing an extensionless import's
directory as a file, or probing index children beneath an explicit JS file,
rejected otherwise safe evidence. Directory-index and explicit-JS
regressions reproduce the problem without model calls. The fix probes only
plausible source files, keeps all containment/secret/ambiguity checks, checks
the evidence deadline during resolution, and reports evidence withholding
separately from a model answer. The first measurement remains attributed to
`1e53edc5`; testing a corrected candidate is a new experiment, never a
replacement of that report.


The corrected resolver replay at `dfe5ee93` is retained separately:

| Checkpoint | True-labelled originals kept | Stale-labelled claims caught | Stale-labelled original full text |
| --- | --- | --- | --- |
| C0 | 45/46 | 0/0 | 0 |
| C1 | 42/43 | 3/3 | 0 |
| C2 | 40/41 | 5/5 | 0 |
| C3 | 35/37 | 9/9 | 0 |
| C4 | 28/32 | 14/14 | 0 |
| C5 | 26/31 | 15/15 | 0 |

C5 reaches 15/15 stale-labelled catches, including k08/b01/b04, but drops
to 26/31 true-labelled originals kept, below the accepted 28/31 and the
prospective floor. b09 is now confirmed still-true and delivered full.
The five originals not kept are privacy-withheld b03 and rewrites of
v04/b06/b10/b13. No evidence was skipped. The normal queue recovered from
one invalid primary reply (four entry diagnostics); all five checkpoint
jobs finish with gaps. No provider/usage failure or hidden retry is omitted.
All five bounded check-target repairs record successfully.

The two new true-labelled losses relative to the accepted C5 result are
b06 and b10. The model invokes an existing-ETag exception and a custom
onError response respectively; it also rewrites v04 after reasoning about
the 304 response's headers. These need a review of claim scope, default
behavior and collaborator behavior. A recorded check is not independent
proof that a replacement sentence is semantically correct. The follow-up
stays experimental: the accepted checkpoint remains intact, and the
retention regression prevents treating this as an overall quality win.
There is no further unchanged-code sampling.

Exact usage: 166 uncached input + 1,188,256 cache-write + 75,323 cache-read + 66,835 output = 1,330,580 reported tokens, across 83 calls (78 judge + five check-target repairs). No seed-generation calls occur in this replay. Reference valuation: $0.299022383. All six complete runs total **507 calls / 7,575,078 tokens / $1.723536408**. Including the retained partial attempt gives **508 calls / 7,591,699 reported tokens** and known valuation plus its reservation of **$1.733610208**, within the existing $5 allowance. These remain reference amounts, not invoices or additional subscription charges.


### Known truth-label defect: b13

The b13 claim says cookie names are checked against validCookieNameRegEx
while parsing. Its detector in claims.mjs tests only whether that name
appears anywhere in cookie.ts. A read-only audit of all six pinned source
snapshots finds parse() using the strict regex through C3, then using
relaxedCookieNameRegEx at C4/C5. The old regex remains in _serialize(), so
the detector incorrectly retains a true label. The model's parser rewrite
agrees with the source; the frozen score still counts it as true-not-kept.
The accepted run withheld b13 at C4/C5 rather than serving its old original.

Every comparison above preserves the original corpus, truth hash and
31/15 C5 denominators. No truth label is changed to improve a score. These
are frozen-label measurements with a known oracle defect, not a fully
audited semantic gold set. A separately versioned truth correction and
offline rescore of retained delivery reports should be reviewed before
using these figures as final error rates; that correction need not spend
more model calls. OSS-68 remains open for that review and integration.

Final source validation at dfe5ee93: root/workspace/script typechecks and
build pass; the full native-enabled suite passes 6,915 tests across 465
files, with 16 tests/two files skipped (264.82s, one local macOS run). Go vet
and all Go package tests pass; no Go source changed in this follow-up.
Clean-commit beta.2 gates pass all 283 knowledge checks and both 200-sample
timing checks. Overall gates exit 1 for the five existing unbuilt adapters
(graph quality, call graph, replay, overlay and upgrade); no threshold is
weakened and no release readiness is claimed.

### Review fixes after the measured revisions

Review found reproducible gaps in generated check roles, helper selection and
fixed-replay input ownership. Automatic source/symbol/pattern rewrites now
reject `complete` roles before recording and use the same one-attempt check
repair to request supporting checks. Original entries and manually authored
checks keep their existing contract; no role is silently downgraded.

Helper discovery uses optional exact source offsets from the existing JS/TS
parser, so a neighbouring function or call on the same physical line cannot
pull an unrelated helper into the prompt. Same-name local bindings cause an
import to be omitted conservatively; this is not a full lexical or module
resolver. Candidate ambiguity is decided from contained file metadata before
reading contents. An oversized, unselected candidate therefore cannot consume
the source budget. Selected files still require the same containment, size,
secret and final freshness checks. Offsets are checkout-local parser metadata
and are never written into the file-index record or its native schema.

Fixed proposals are validated at both report loading and plan construction,
including direct callers: exact eligible IDs, supplied-file scope, role
policy, privacy exclusions and typed provenance hashes. The run takes its
own JSON snapshot before any asynchronous callback, so index preparation
cannot change the targets that the approved fingerprint names. A report's
`complete` flag must be the boolean true, rather than a truthy string. An
all-withheld corpus may retain an empty proposal set without writer calls.

These fixes have deterministic fake-call and real-evaluator regression
coverage. The earlier live scores remain attributed to their original
revisions; no new live model calls, changed truth labels or restored-retention
claim accompany this review. The experimental retention and b13 label/scope
review remain open, and the pull request stays a draft.

## Reviewed benchmark protocol (v2)

The model CLI now defaults to `reviewed-v2`, dataset
`b8199a29a86bf9b6b89f31852f232a0b25bf7179cc0b8644ea412330c83294cd`.
The legacy corpus and all earlier tables above remain historical v1 inputs.
The existing deterministic release gate retains its separately pinned v1
protocol; its pass is not a reviewed-v2 model-quality result.

The source review in `reviewed-v2.json` makes ten claim scopes explicit:
configured npm scripts/engine range, the exact method list and MIME mapping
strings, weak ETag generation, default body-limit behavior with a declared
length, and compression with a known Content-Length. These are input changes,
not improvements in model behavior. The unchanged cookie-parser claim is stale
at C4/C5: `parse()` uses the relaxed regex; the strict regex survives in the
serializer. C5 therefore has **30 true and 16 stale** claims, not 31 and 15.
C4 has 31 true and 15 stale; earlier denominators are unchanged.

The independent free audit bundles each pinned source snapshot and exercises
middleware with defaults and explicit controls. It verifies all 276 labels
using actual behavior for behavioral cases and separate plain JSON/declaration
reads for configuration. It does not invoke the native checker or a model.
For example, the six headers really survive a conditional 304 at every
checkpoint; changing a response object alone does not prove header loss.
Unknown-length body limits differ in early versions, and small responses
without Content-Length are compressed. Those controls are retained separately.
MIME helper output may append charset even when the raw mapping does not.

```sh
node scripts/knowledge-bench/audit-behavior.mjs \
  --subject /path/to/full-subject-clone --out /path/to/new-private-audit
node scripts/knowledge-bench/model-eval.mjs \
  --subject /path/to/full-subject-clone --rescore /path/to/old-report.json \
  --out /path/to/new-label-audit.json
```

Rescoring is free and writes a new `legacy-label-audit`. It validates complete
case/checkpoint coverage, original scores, truth, privacy/generation flags and
source-plan fingerprint. Only the two cookie labels change; the ten reworded
claims are marked as requiring fresh measurement. Never present this derived
artifact as a v2 model run. The first report's older schema has per-case
failure flags but no top-level list; the audit explicitly derives the seed
list and requires consistency at all checkpoints. Raw reports are untouched.

For a controlled transition, `--checks-from` validates the accepted v1 report,
reuses its 35 unchanged eligible proposals verbatim, and regenerates checks
for only the ten changed claim inputs. Their six writer batches permit at
most six rejected-claim seed repairs; the existing shared judge/target-repair
bound remains 113. No answer-key targets, labels or source assertions enter
model prompts. Invalid frozen targets abort rather than silently regenerate.
Privacy-withheld b03 remains in every denominator. A fresh replay against
v2 results can freeze all 45 eligible proposals again.

Before the v2 measurement, the prospective review target is C5 >=28/30 true
kept, >=15/16 stale caught, no stale original full delivery and zero generation
failures. All 46 cases at all six commits, exact token counts and residual
uncertainty must be reported regardless of that target. Completion and quality
are distinct. The default plan binds this target along with the reviewed
inputs, source/candidate hashes, reused targets, regenerated IDs and cost bounds.
This is one disclosed measurement, not repeated sampling to select a score.

## Reviewed-v2 measurement and review decision

One owner-authorized run on committed candidate
`41dd76b4c23a7446e5938f1b5878e21afa95334a` met the prospective review target.
Its prepared fingerprint was
`3b11333c010ed428958183853bbb7da99204d53a4440261427dde477e0d0efa3`.
The runtime audit independently agreed with all 276 reviewed labels, and a
separate case/ledger verification reproduced every score, the 35 unchanged
proposals and exact usage totals. All historical raw report hashes remain
unchanged. Raw model reports, replies and account details remain private.

| Checkpoint | True kept | Stale caught | Stale original full text |
| --- | --- | --- | --- |
| C0 | 45/46 | 0/0 | 0 |
| C1 | 42/43 | 3/3 | 0 |
| C2 | 40/41 | 5/5 | 0 |
| C3 | 36/37 | 9/9 | 0 |
| C4 | 29/31 | 15/15 | 0 |
| C5 | **28/30** | **16/16** | **0** |

All 45 privacy-eligible proposals record successfully, with zero generation
failures or seed repairs. The six fresh writer calls regenerated only the ten
changed claims. There were 77 ordinary judge calls and one successful bounded
check-target repair for b13 at C4: **84 calls total**. All five jobs finished
with gaps; that state retains observed uncertainty rather than claiming every
entry received a conclusive model answer. No transport, usage or primary reply
failure occurred. C5 has no stale misses. Its two true-not-kept cases are
privacy-withheld b03 and the v04 cannot-tell pointer. The independent runtime
audit confirms v04 still holds; this remains a limitation in obtaining enough
collaborator evidence to confirm header propagation, not a stale claim.

C5 operational false rejection is 2/30 (6.67%), including privacy and uncertainty;
stale miss is 0/16. This is one run on hand-written, source-reviewed claims,
not a confidence guarantee, independent sampling or a causal improvement claim
over the older differently worded inputs. Recording a rewrite's targets still
does not independently prove every replacement sentence. No more sampling is
needed to complete this review; the remaining v04 abstention is disclosed.

The run reports **168 input + 1,294,348 cache-write + 0 cache-read + 57,983
output = 1,352,499 tokens**, with no estimated/unmeasured calls. Reference
API-equivalent valuation including the quote's headroom is **$0.316665690**,
below its $2.99 conservative quote. The quote plus earlier known valuation and
partial-call reserve was $4.723610208, below the existing $5 allowance. Seven
complete runs plus the retained partial attempt now total **592 calls /
8,944,198 reported tokens / $2.050275898 known valuation plus reservation**.
These are reference calculations, not invoices or extra subscription charges.

Free label-only audits of old wording yield the following C5 counts. These
are deliberately separate from the reviewed-v2 measurement above; the ten
clarified inputs were not retroactively tested.

| Historical source | Label-corrected true kept | Label-corrected stale caught |
| --- | --- | --- |
| Initial 8fd41d74 | 12/30 | 10/16 |
| Patterns 2cec7f83 | 20/30 | 13/16 |
| Delivery 201ac957 | 26/30 | 15/16 |
| Roles a1c5dbb8 | 28/30 | 12/16 |
| First replay 1e53edc5 | 27/30 | 15/16 |
| Resolver replay dfe5ee93 | 26/30 | 16/16 |

Validation: root/workspace/script typechecks and build pass; Go vet and all Go
package tests pass. Focused review tests pass (87 tests), including strict
transition validation, missing/duplicate cases, original-score/plan tampering,
old-schema failure preservation, and regeneration of changed inputs only. The
full native-enabled suite passes **6,933 tests / 466 files**, with 16 tests /
two files skipped, in 278.86s in one local macOS run. Product code in the
measured candidate is unchanged by this results-only documentation commit.
Benchmark scope/label review is complete. PR integration and the separately
pinned release adapters remain outside this measurement; no merge or release
readiness is implied.
