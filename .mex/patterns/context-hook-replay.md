---
name: context-hook-replay
description: Changing hook selection or graph delivery using offline transcript replay and bounded read-only graph queries.
triggers:
  - "context hooks"
  - "hook replay"
grounds_to: []
last_updated: "2026-10-18"
---

# Context hook replay

## Context

Read `docs/design/context-hooks.md` before changing hook selection. Hook tool
paths must stay light; prompt-only ranking and semantic dependencies load lazily.

## Steps

1. Preserve knowledge selection and ordering; make graph delivery a separate,
   bounded composer that the runner and offline replay both call.
2. Copy evaluation databases before opening them. Never refresh or repair pilot
   caches during ordinary replay. Join tool uses with their results and distinguish
   line-number-only searches from multi-file `path:line` output.
3. Measure the files arm as a counterfactual as well as the existing hook arms.
   Retain observed semantic prompt gates when replaying without a model.
4. Count unopened targets by Read range, require a later use for useful notes,
   retain a neutral category, and disclose that navigation lead is not causal
   turns saved. Report every session and every unresolvable edit.
5. Tune simple evidence/cap rules. Test dedup and budget delivery together: a
   dropped graph note must not consume its session keys.

## Gotchas

- An indexed identifier can still name an unrelated property or receiver method.
  The verified callable tier is intentionally narrower than all exact names.
- Rank production paths before SQL LIMIT so test callbacks cannot hide callers.
- Grounding health compares stored body hashes to the task graph. Different
  scaffold/task source history can correctly yield changed labels before edits.
- Measure full warm runner latency separately from composer latency and cold
  process start. Avoid concurrent builds or typechecks during timing.

## Verify

Run the context suite, typecheck and build. Check graph ablation, event/session
caps, graph log counters, production-first callers and silence on Read. Re-run
replay after changing gates, parsers or caps; preserve its methodology and limits.

## Debug

Inspect the hook log's event, graph node ids, graph chars and full packet chars.
Check the parser's result shape before interpreting silence as a selection miss.
