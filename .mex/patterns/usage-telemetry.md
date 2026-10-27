---
name: usage-telemetry
description: Extend CLI and Hub usage measurement without leaking product data or delaying command exit.
triggers:
  - telemetry
  - command outcomes
  - retention analytics
edges:
  - target: context/conventions.md
    condition: Before changing a capture, delivery, or persistence boundary
  - target: patterns/release-performance-gate.md
    condition: When evaluating a material command or Hub resource regression
last_updated: 2026-10-19
---

# Usage telemetry

## Context

Read `TELEMETRY.md`, `docs/design/telemetry-v2.md`, and the closed catalog in
`src/telemetry/schema.ts`. The shared random installation ID is approved for
CLI/Hub repeat-use measurement. The user also approved the existing scaffold
UUID for shared-project estimates and the project's configured AI-tool names.
Neither installation counts nor shared scaffold IDs establish team size.
Contact details belong to the separate voluntary hosted form, with no
installation or scaffold ID appended.

## Steps

1. State the product question and denominator. Separate attempts, successful
   completion, previews, applied changes, replay, and background job completion.
2. Add only fixed names and bounded approved properties to the central catalog.
   Project context permits an existing UUIDv4 and a sorted, unique selection of
   at most six known AI-tool names. Never spread config, request bodies,
   arguments, error objects, URLs, or other IDs.
3. Capture from registered CLI command ancestry or a validated Hub server action.
   Derive page categories locally. Pure discovery/read contracts, Hub polling,
   SSE and idle timers must not manufacture engagement events.
4. Preserve opt-out checks before capture and send. Keep inspection non-mutating.
   Revalidate persisted data before transport; wrong schema/unsafe paths fail quiet.
5. Preserve bounded delivery and cleanup. Test sockets/DNS and actual process
   close, not only a Promise timeout around a fake sender. Do not introduce a
   detached sender, unbounded queue, blocking lock, or retry loop.

## Gotchas

- `process.exit()` skips cleanup. Preserve action exit codes using normal return;
  complete once in postAction or the main error/finally path, never both.
- Atomic rename alone does not prevent a stale feedback/notice writer from
  replacing an opt-out preference. Preserve the dedicated opt-out marker,
  which only explicit enable removes.
- A started event without completion can mean abrupt termination or delivery
  loss. It does not prove product failure. Original timestamps/UUIDs survive retry.
- A CLI command may finish before its final event can be sent. Later eligible use
  drains the bounded queue. Seven-day expiry is enforced on subsequent access;
  without a daemon, an untouched disk file may physically remain longer.
- A request timeout alone is insufficient if unresolved DNS or referenced sockets
  keep Node alive. Run the built CLI against a real hanging loopback endpoint.
- For a cancellation test, await the actual loopback request/query before
  timing the flush. Fixed setup sleeps can put first-use transport initialization
  inside the cancellation interval. Preserve the production grace and elapsed
  limit, and assert real cancellation, stopped queries and retained queue data.
- A best-effort flush grace does not promise successful loopback delivery.
  Positive transport tests await the actual outbox acknowledgement before
  flushing; lifecycle-only batching tests stub the transport acknowledgement.
  Keep real socket/DNS cancellation tests and production deadlines unchanged.
- Fixtures should inject a silent sink. Tests that enable telemetry must isolate
  `MEX_HOME`, redirect only to loopback, and deny all other egress.
- Read project metadata through the bounded, non-mutating telemetry reader;
  never mint a scaffold ID to fill an event. Ordinary CLI operations reuse one
  snapshot; setup/init can reread at completion after saving configuration.
  Hub metadata stays fixed from its first enabled event until restart.
- Match each command's actual project selection. Graph maintenance/status use
  their exact root with local `--root` before parent `--root`; they must not
  borrow an ancestor scaffold. Hub capture uses its bound project root exactly.
  Ordinary commands retain their nearest-Git-root discovery behavior.
- `configured_ai_tools` describes project setup, not the invoking agent.
  Allow multiple selected tools without process/account probing. Missing or
  malformed configuration omits context; unknown tool names never enter events.
- Count distinct installations per scaffold over a stated window, such as 28
  completed UTC days, and label two or more as a shared-project estimate.
  One person's several machines and copied scaffold IDs can inflate it;
  shared installations can hide it. Anyone with project config access can
  associate its UUID with that project.

## Verify

Run focused catalog/privacy/outbox/opt-out/CLI/Hub tests, then typecheck and the
appropriate integrated tests/build. Use `benchmark:telemetry:test` for harness
safety and `benchmark:telemetry` with a preserved baseline for paired latency.
Do not run other builds/tests during timing. Keep raw measurements and report
local timing separately from pinned CI gates.

## Debug

Use `mex telemetry inspect` without creating state. Check opt-out precedence,
queue availability, catalog rejection, request cancellation and expired claims.
Do not fix missing events by capturing arguments/content or relaxing bounds.

## Update scaffold

Update the catalog documentation, metric definitions and `.mex/ROUTER.md` when
coverage or guarantees change. Preserve existing grounding evidence; telemetry
work does not authorize graph refresh or baseline acceptance.
