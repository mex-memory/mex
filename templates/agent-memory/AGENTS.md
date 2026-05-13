---
name: agents
description: Always-loaded operating contract for a persistent AI agent workspace.
last_updated: [YYYY-MM-DD]
---

# [Agent / Workspace Name]

## What This Is
<!-- One sentence. What environment or agent does this scaffold describe? -->

## Non-Negotiables
<!-- 3-5 hard safety/operational rules the agent must never violate. -->

## Commands
<!-- Exact commands for health checks, service status, restart/recovery, and mex maintenance. -->

## GROW
After meaningful work:
- Ground: what changed in reality?
- Record: update `ROUTER.md` and relevant `context/` files
- Orient: create/update a `patterns/` runbook if this can recur
- Write: bump `last_updated` and run `mex log` when rationale matters

## Heartbeat
When invoked for a heartbeat, read `HEARTBEAT.md`. If all checks pass, respond with exactly `HEARTBEAT_OK`.

## Navigation
At the start of every normal session, read `ROUTER.md` before doing anything else.
