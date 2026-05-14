---
name: heartbeat
description: Lightweight checks for scheduled persistent-agent heartbeat events.
last_updated: [YYYY-MM-DD]
---

# Heartbeat

Run these checks when the agent receives a heartbeat event.

## Checks

1. Run `mex heartbeat`.
2. If it prints `HEARTBEAT_OK`, respond with exactly `HEARTBEAT_OK`.
3. If it reports stale scaffold files, tell the user which files need review and suggest `mex sync`.
4. If memory cleanup is due, review `memory/YYYY-MM-DD.md` files, promote durable insights to `MEMORY.md`, and update `memory/.last-cleanup.json`.
5. Do not perform unrelated work during heartbeat.

## Defaults

- Context staleness threshold: 7 days unless `.mex/config.json` overrides `heartbeat.staleDays`.
- Memory cleanup threshold: 7 days unless `.mex/config.json` overrides `heartbeat.memoryCleanupDays`.
- Daily memory retention: 14 days unless `.mex/config.json` overrides `heartbeat.dailyMemoryRetentionDays`.
