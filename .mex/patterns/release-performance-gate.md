---
name: release-performance-gate
description: Repeatable workflow for changing, calibrating, and enforcing MEX release resource budgets.
triggers:
  - "release benchmark"
  - "performance budget"
  - "bundle budget"
  - "idle polling"
edges:
  - target: "patterns/secure-local-project-hub.md"
    condition: "when the regression involves Hub routes, browser sessions, or jobs"
  - target: "patterns/safe-graph-snapshot-evolution.md"
    condition: "when changing Graph maintenance or corpus inspection"
last_updated: 2026-10-29
mex:
  id: mx_01M1M0CJNG4SW0WCJF3NB547HE
  type: pattern
  status: promoted
  revision: 8
  title: release-performance-gate
  grounds_to:
    - node: function:5f86a557c717597b411a71a82c000ded
      fingerprint: mh:64:7b226d696e68617368223a5b3130393535323434312c34373433303532352c3336343837333436342c3631353236333232362c393330313935362c3137333839303837342c323731343330352c333431343230302c36323433343431332c39353539333934352c33323035353232362c33383837383237302c3137393430393331372c34323033363635302c3130323430373533322c35393637383033382c3133363635363236332c3236333536343338312c34313738383139392c33333834333937392c36393231353436312c36343833373736382c363838333432392c3133363132393437332c32393838353035362c3139323439303837352c38393131383238382c37363437393430382c34373630313239322c35323135393631352c38393939343337352c3136393638323937382c39383335383936382c363938343133322c34313937383934302c3330323736363434312c3135313134313035372c38373437363636392c39343531313235342c3132343039363830312c32373930303134312c3136303232313339342c38353331343835332c353236313539322c3136353039343031302c3230313834343134322c3134303038393531322c31303435383337382c3134323233303531392c3134323935373036382c32363437373636362c31353336373636302c33333333333239362c34303939383134372c37343137363336342c35343635393733302c3339373537373039312c34383834353436352c39313539343633302c32323931323839392c35363337323839332c32363835383637372c33383337343331332c3239313633363735345d2c226e65696768626f7273223a5b2266756e6374696f6e3a3233343463323162663939663464346561323330356233363736393964366564222c2266756e6374696f6e3a6233633535346335363163373263633162363039366630353936396261396263222c2266756e6374696f6e3a6264623065393939613731363632376637626562383966376461393739366335225d2c22746f6b656e436f756e74223a33397d
      bodyHash: abeeccea72abec59513800d99c2769f8fd8317ef8b2fb7c06cd9af09c9883333
  relations:
    - type: related_to
      target: mx_01M1M0CJQ2BSV71G1C7TXZD9RH
      note: when the regression involves Hub routes, browser sessions, or jobs
    - type: related_to
      target: mx_01M1M0CJP81C590FCKTSN5HA3Q
      note: when changing Graph maintenance or corpus inspection
---

# Release Performance Gate

## Context

The release benchmark is a product contract, not a laptop speed test. Runtime,
RSS, CPU, and heap budgets are characterized and enforced only on the pinned
Ubuntu 24.04/Node 22 runner. Production asset bytes are deterministic and may
be checked anywhere. Node 24 remains compatibility coverage, not a second
calibration environment.

## Steps

1. Keep the small, medium, and large fixture profiles deterministic: fixed
   contents, IDs, Git identity, timestamps, and file counts. Indexes are built
   only by explicit fixture setup.
2. Run ten timing samples and five idle/memory samples. Preserve separate
   small, medium, and large candidates for every read, route, and maintenance
   operation. Bound child output, HTTP bodies, request inventories, diagnostics,
   and the JSON report itself.
3. Account every registered route from the Vite manifest's static closures,
   including detail, honest unavailable-state, and wildcard routes. Check the
   shell and Home closures independently so Home cannot pull another workbench
   through a transitive import. Count all emitted fonts as initial assets.
4. Prove a production browser remains exact-origin and quiet during an idle
   window. Snapshot canonical files, Git state, and Graph/Wiki SQLite families
   before and after ordinary reads.
5. Use the first healthy pinned report as characterization. The two-pass gate
   enters through
   [`enforceWithConfirmation()`](mex://function:5f86a557c717597b411a71a82c000ded).
   Freeze runtime,
   time, RSS, and heap limits at `ceil(p95 * 1.15)` and built asset limits at
   `ceil(bytes * 1.05)`. During CI enforcement, collect a potentially material
   confirmation in a separately allocated pinned hosted job at the exact same
   repository HEAD; two child processes on one VM are not independent evidence.
6. Commit the budget file, its versioned schema/golden, and the retained runner
   identity together. Never copy wall-clock numbers from a local machine.
7. When a new deterministic team fixture adds canonical and checkout-local
   records, preserve every unrelated corpus total. Reuse an existing Activity
   slot when the new artifact requires an event, and record the new topology as
   additive optional report fields so historical reports remain valid.
8. Calibrate only the explicitly owned metric leaves. Diff the candidate budget
   file against its exact base and fail the review if any unrelated number,
   schema contract, or calibration formula changes.

## Gotchas

- Workbench readiness must identify the graph itself. The statechart canvas is
  the named `States and transitions` group inside the `State diagram` region;
  its zoom/fit controls also contain SVGs. A generic SVG locator can therefore
  fail before measurements start. Exercise the actual readiness helper in the
  production browser test, including nested/parallel diagrams.
- Vitest sets `NODE_ENV=test`. Any test that invokes a production build can
  silently bundle React's development runtime unless the build wrapper sets the
  production condition before importing Vite.
- A route can be dynamically split from the application entry and still be
  statically imported by Home. Inspect Home's complete static closure.
- A lightweight API read can also pull a workbench through a dynamic validator
  import, beyond the static Home closure checks. Keep shared contact contracts
  independent of setup, and test the actual production request inventory.
  Likewise, a constants-only import from a schema barrel can duplicate all its
  eager Zod construction into an independently built entry; use a leaf module.
  Account shared on-demand completion contracts in the setup asset measurement.
- Tailwind scans comments inside declared source directories. A prose word can
  accidentally emit an unused utility. Compare deterministic CSS before
  changing a shared limit; keep explanatory comments free of accidental classes.
- Wiki graph projection can repeat work even inside one immutable snapshot:
  parent discovery and edge projection need the same first relation pages. Reuse
  those bounded pages only within the request, and read claim bodies only when
  grounding resolution consumes them. Preserve the final Wiki/Graph freshness
  proofs, parent promotion, pagination, ordering, and truncation checks.
- Removing a timer is insufficient if client collections, query pages, terminal
  job IDs, or observer subscriptions can grow forever. Bound both storage and
  pagination.
- Cross-tab job discovery must be event-driven. Do not restore continuous
  polling to repair cache invalidation.
- Corpus byte caps bound admitted input, not process RAM. Compiler dependencies,
  AST/checker state, graph materialization and native storage can amplify that
  input; measure peak working set separately from post-cleanup retained memory.
  A low heap cap can abort extraction rather than make it memory-efficient.
- Synthetic fixture size is not repository scale. The current 48-file largest
  fixture missed a real 708-file fingerprint write dominated by SQLite nested
  savepoint bookkeeping. Separate fingerprint computation from persistence,
  inspect native stacks, and verify both output equality and failure rollback.
  See the [2026-09-09 investigation](../../docs/design/code-graph-resource-investigation.md).
- A maintenance child must be included in aggregate CPU/RSS measurements.
  Measure real HTTP/cancel responsiveness and parent-owned temporary cleanup;
  fatal heap exhaustion bypasses JavaScript `finally` blocks. Process isolation
  alone is not a reduction in total work or peak memory.
  The release sampler now sums Hub and observed descendants. RSS can count
  shared pages twice; sampled CPU can miss short-lived children and final exit
  work. The separate graph characterization exercises overlapping projects,
  installed declarations, inferred JavaScript and actual executable edits;
  it does not recalibrate the frozen release gate.
- Observe maintenance completion through the same bounded event subscription as
  the Hub UI. Aggressive status polling opens extra SQLite readers once process
  isolation makes the Hub responsive, adding observer work to the operation.
  Keep POST-to-terminal elapsed time and child CPU/RSS included, retain the
  absolute deadline, and record the observation method in report provenance.
- Back-to-back confirmation processes on one hosted VM share CPU steal,
  throttling, and I/O contention. Keep the raw reports as artifacts, pass only
  a bounded retry decision between jobs, and make missing or same-allocation
  confirmation evidence fail operationally.
- An unavailable-route placeholder can already have a frozen asset or heap
  budget. Replacing it with a real lazy workbench should initially fail only
  that route's owned leaves; do not reinterpret the placeholder budget as a
  calibration result.
- A schema-valid pinned measurement report can fail enforcement because a new
  route's owned budget leaves are missing. Verify its exact raw-report hash,
  runner, commit, schema, and samples before using it to calibrate only those
  leaves with the frozen formula; an operationally invalid report is not
  calibration evidence. A hard `budget_missing` failure suppresses runtime
  confirmation, so other first-pass crossings remain unconfirmed. Run ordinary
  enforcement again after calibration instead of widening existing budgets or
  treating the completed measurement as a green gate. PR #180's Settings-only
  correction is recorded in `docs/design/settings-heap-calibration.json`.
- Process isolation can deliberately trade small-job latency for responsiveness
  and shorter compiler-memory lifetime. Confirm the regression on independent
  pinned runners, distinguish peak aggregate RSS from surviving-parent RSS, and
  record explicit acceptance of the product tradeoff before recalibration.
  Use the first healthy report and existing formula for only the accepted,
  confirmed timing leaves; restore their old values in the frozen-budget hash
  projection so every unrelated limit stays protected. A local same-code
  comparison explains the cost but never supplies release calibration numbers.
  PR #180 retains both runner attempts in
  `docs/design/graph-maintenance-timing-calibration.json`.

## Verify

- [ ] Production build emits no Vite large-chunk warning or React development sentinel
- [ ] Initial and Home closures exclude unrelated workbenches and setup code
- [ ] Asset-only budget check passes outside the pinned runner
- [ ] Production Playwright/axe and the idle exact-origin/nonmutation proof pass
- [ ] Pinned report has exactly ten timing and five idle/memory samples per metric
- [ ] Final budget file is non-provisional and matches the report candidates
- [ ] Node 22 and Node 24 compatibility jobs remain green
- [ ] Packed-install, declaration-leak, Graph/Wiki conformance, and protocol/ranking gates pass

## Debug

If asset hashes change unexpectedly, inspect the built chunks for React
development sentinels before recalibrating. If runtime enforcement is noisy,
confirm the exact OS/architecture/Node patch, fixture digest, repository HEAD,
and distinct hosted-job allocations; do not widen a budget until the retained
raw samples show a real regression or stable shift.

## Update Scaffold

The 2026-10-19 revision records request-local Wiki graph projection reuse and
ungrounded-body avoidance. The 2026-09-13 revision added dynamic validator and
constants-barrel boundaries, and accidental Tailwind utility generation, from
PR #197. Earlier calibration
versus enforcement and accepted graph-isolation timing guidance remain. Existing
grounding fingerprints and `bodyHash` baselines are retained unchanged.

- [ ] Update `.mex/ROUTER.md` when the benchmark surface or pinned runner changes
- [ ] Update `docs/design/release-performance-baseline.md` with the retained calibration
- [ ] Extend this pattern when a new resource class or bundler trap is discovered
