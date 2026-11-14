# Automatic model allowance and machine queue

MEX's headless model runner reserves automatic spending before a model starts.
The local record owns the queue and reference-price ledger across repositories,
foreground jobs and background workers. Explicit user commands join the same
lane and remain uncapped. Hooks never wait on this queue.

## Callers and storage

`runModel` accepts `automatic: { estimate }`, with the four token classes. An
automatic caller must use a known reference-price model and an enabled project
or machine job. This flag records intent; running an automatic job from a
foreground worker does not exempt it. Existing setup calls remain explicit.
Later learning/filter job kinds must use this API; no such task is added here.

Migration 4 adds Node-owned `model_batches` and nullable `model_calls.batch_id`.
The ledger contains queue/owner IDs, requested model, mode, project/job/batch
attribution, timestamps, reservation/charge units, pricing metadata and state.
It contains no prompt, reply, credential or raw diagnostic. Observed model
labels remain independent of the requested model, including `unknown` when the
provider omits its label. The hooks schema remains version 1; Go recognizes
record version 4 without writing it. Older Node writers refuse the newer file.

The shared process owner acquires admission, launches one child, drains pipes,
records usage, reconciles and releases the lane. A database unique index allows
one running admission. Job context carries the writer's home through accounting
so a custom background record cannot accidentally use another CLI's home.

## Admission policy

The starting parameters are 3%, seven reference batches and 75% utilization.
Before each automatic batch:

1. Value the last seven UTC days of own usage and one quarter of 28 UTC days;
   use the larger value. Source logs are refreshed only by explicit maintenance,
   never by this read. Subtract recorded MEX headless token classes conservatively
   to avoid old saved MEX sessions funding more MEX work; clamp each class at zero.
2. Take 3% of that base, with a floor of seven fixed reference batches. One
   reference batch is a starting parameter of 4,000 input and 1,000 output tokens,
   valued at the largest shipped agent reference profile. It is not measured
   model consumption. An individual request cannot enlarge that floor.
3. Check settled automatic charges, outstanding reservations and the proposed
   estimate in the same write transaction that admits the call. If no own usage
   is readable, use seven admitted automatic attempts in seven UTC days instead.
   Failed and interrupted admissions consume attempts; unstarted entries do not.
4. Hold at a visible, unexpired selected-agent window of 75% or above, or a
   rejected window. Missing room is unknown. A reset or newer observation can
   clear the hold. Ephemeral model output and own-usage logs share the same
   numeric/status normalizer; the latest bounded observations are saved before
   releasing a model admission.

These are between-batch admission checks. The provider may report more usage
than the estimate within a batch. That overshoot is recorded before the next
admission; this is not a hard provider token quota or a subscription bill.
User-run commands remain logged regardless of remaining automatic allowance.

## Reference valuation

`budget-prices.ts` keeps replaceable weights, checked on 2026-11-14. Integer
units are nanodollars per token; $1 per million tokens is 1,000 units per token.
These are standard list-price references, with longer cache writes used
conservatively because aggregate token reports omit cache duration.

| Model/reference | Input | Cache write | Cache read | Output |
| --- | ---: | ---: | ---: | ---: |
| Claude Opus 5.5 | 4,000 | 8,000 | 200 | 20,000 |
| Claude Haiku 5.5, up to 100k input | 100 | 200 | 10 | 500 |
| GPT-6.1 Sol, up to 272k input | 2,000 | 5,000 | 100 | 10,000 |
| GPT-6 Luna, up to 272k input | 100 | 250 | 10 | 500 |

Haiku above its threshold uses 500/1,000/50/2,500. Codex models above their
threshold double input/cache weights and multiply output by 1.5. Aggregate
multi-turn counters may conservatively select the larger context tier.
[Claude pricing](https://platform.claude.com/docs/en/about-claude/pricing),
[OpenAI pricing](https://developers.openai.com/api/docs/pricing).

Own usage lacks model labels. Its fixed per-agent reference is Opus or Sol,
using the shorter cache-write reference. The baseline is therefore an estimate,
even when its raw token counters are reported. `modelBudgetSnapshot` labels
the valuation estimated and names its price profile. It does not claim an
exact allowance percentage across unknown models, account plans or modifiers.
Unknown requested automatic model prices hold work; unknown observed labels
use the requested profile, and unrecognized observed models use the largest
shipped reference. Raw usage rows are never rewritten to make prices appear known.

## Queue, failures and recovery

Eligible explicit callers have priority; automatic callers prefer a visible
sooner reset, then queue order. A held automatic caller cannot obstruct an
eligible explicit command or another provider. The queue permits at most 256
pending admissions. Explicit waits are cancellable and at most 30 seconds;
automatic jobs yield promptly and use the existing waiting state. No transaction
is held during a wait or model execution. Non-model jobs remain available.

Holds preserve job checkpoint, batch number and failure count. Pause/cancel
requests retain precedence. Waiting jobs recheck their condition without
starting a model or consuming a reservation. Reconciliation records actual
reported usage; estimates and accounting failures retain at least the reservation.
A killed admitted owner leaves a conservative charge, including linked reports
if present. Retrying reserves again. An unstarted dead owner's row is retired
without charge. Live owners are not displaced by a stale timer. A reused live
PID conservatively delays recovery until that process exits; an unfamiliar
owner string alone is not evidence that a model has stopped.
Uninstall may remove hooks/runtime while work finishes, but purge retains the
record while a live queued or admitted model caller still owns it.

Automatic storage failures hold work. An explicit command retains the existing
continue-with-warning behavior if the record cannot even open; that degraded
run cannot coordinate through an unavailable record. Neither this fallback
nor a foreground worker exempts automatic spending.

Deterministic tests use real concurrent Node workers and fake agents to check
serialization, last-reservation races, crash/retry charges, explicit bypass,
usage-window propagation, migration preservation and job recovery. They establish
admission behavior, not real model prices, plan auth or live session retention.
Live/paid acceptance remains separate.
