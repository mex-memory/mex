---
name: agent-arm-isolation
description: Keep headless agent comparisons independent, history-bounded and resumable on a small machine.
triggers:
  - agent-arm harness
  - Codex evaluation
grounds_to: []
last_updated: "2026-10-28"
---

# Agent-arm isolation

## Context

Read `evaluate/arm/README.md` and the selected suite before changing the harness.
Agent fixtures and contract tests live in `evaluate/arm/test/`. Preserve existing
Claude invocations and regression expectations when adding a host adapter.

## Steps

1. Record the existing harness test baseline before editing.
2. Keep suite/model/effort/sandbox and scaffold/CLI inputs pinned across arms.
3. Prepare repositories from the base's reachable objects only. Copy scaffold
   blobs without importing its commit. Restore hidden files from the private
   subject after the measured session exits.
4. Give Codex a fresh home containing only an auth copy and explicit configuration.
   Archive its rollout, then delete the credential copy in a finally block.
5. Record durable rows before advancing the graph chain. Publish the next link
   and checkpoint before deleting previous links. Resume removes orphaned
   workspaces, temporary directories and copied homes before running anything.
6. Guard heavy steps with available-memory/disk floors. Sample in a separate
   process so synchronous maintenance and grading cannot stop the sampler.

## Gotchas

- Removing refs does not remove future Git objects. Check unreachable commits,
  reflogs, alternates and remotes as well as `rev-list --all`.
- A feature-list/help probe is offline evidence for flag names, not evidence
  that the actual model or sandbox behaves correctly.
- Hook recipe selection must be checked from the log; an environment setting
  alone does not prove that the hook ran the intended recipe.
- Windows CIM can be denied. The sampler's native Toolhelp adapter avoids WMI;
  processes that exit between enumeration and RSS reads must be distinguished
  from live processes whose RSS cannot be read.
- Raw graph-table equality includes metadata and storage layout. Keep the
  exact comparison separate from the evaluator's normalized semantic hash.

## Verify

- Run `node --test evaluate/arm/test/*.test.mjs` with only fake agents.
- Exercise invalid terminal output, wrong recipe, history probes, interrupted
  state, resume without relaunching valid rows, and dependency-safe cleanup.
- Use a small cloned subject for a dry run, print RAM/disk and sampled RSS,
  and retain rows/artifacts after deleting workspaces, caches and credential homes.
- Run typecheck and `git diff --check`. Never start a model for fixture validation.

## Debug

Read row violations, the stamped stream, hook log, graph-result JSON and resource
CSV. A missing terminal usage event or incomplete test interval stays unavailable
or invalid; do not fabricate zero usage or time.
