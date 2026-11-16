# Judge model evaluation (OSS-68)

Question: what are the end-to-end false rejection and stale-miss rates when
the model writes the checks too?

This is a separate, manually approved paid experiment. The default command
only prepares a plan, costs $0 and never launches a model. Neither CI nor
`npm run gates` runs this experiment. Deterministic tests use fake replies
with the real evaluator, queue, judge and delivery controller; their results
say nothing about model quality.

## Fixed sample and scoring

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
judge job then runs at C1–C5, with normal admission against an isolated
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

## Accepted measurement checkpoint

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
