---
name: router
description: Session bootstrap and navigation hub for a persistent AI agent workspace.
edges:
  - target: context/architecture.md
    condition: when working on services, infrastructure, automations, or system shape
  - target: context/stack.md
    condition: when checking tools, models, runtimes, versions, or hardware
  - target: context/conventions.md
    condition: when operating on the system or applying safety rules
  - target: context/decisions.md
    condition: when asking why something is configured a certain way
  - target: context/setup.md
    condition: when debugging, restarting, recovering, or inspecting services
  - target: HEARTBEAT.md
    condition: when handling a scheduled heartbeat
last_updated: [YYYY-MM-DD]
---

# Session Bootstrap

Read `AGENTS.md` first if it is not already loaded. Then read this file.

## Current Operational State
<!-- Active systems, known issues, current projects, and anything the agent must know before acting. -->

## Routing Table

| Task type | Load |
|-----------|------|
| System architecture or service topology | `context/architecture.md` |
| Models, tools, hardware, versions, storage | `context/stack.md` |
| Operational rules, naming, safety habits | `context/conventions.md` |
| Why a decision was made | `context/decisions.md` |
| Run, inspect, restart, recover | `context/setup.md` |
| Scheduled heartbeat | `HEARTBEAT.md` |
| Recurring task | `patterns/INDEX.md` |

## Behavioural Contract

1. **CONTEXT** — Load only the files relevant to the task.
2. **ACT** — Do the requested work using the current operational state.
3. **VERIFY** — Check the real system state before claiming success.
4. **DEBUG** — If reality disagrees with the scaffold, trust reality and repair the scaffold.
5. **GROW** — Ground, Record, Orient, Write:
   - Ground: name what changed in reality.
   - Record: update current truth in `ROUTER.md` or `context/`.
   - Orient: create/update a `patterns/` runbook for recurring work.
   - Write: bump `last_updated` and run `mex log` for decisions, risks, todos, or useful notes.
