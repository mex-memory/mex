# mex v0.3

This release turns mex from a drift-aware scaffold CLI into a small operational memory layer for agents.

The original goal of mex is still the same: keep agent context useful, navigable, and honest without dumping an entire project into the prompt. v0.3 keeps the stable v0.2 scaffold architecture, then adds the pieces that make mex work better for persistent agents, homelabs, OpenClaw-style operational workspaces, and long-running project memory.

npm package: `promexeus@0.3.5`

## Highlights

- **Agent memory mode** for persistent agents and operational workspaces.
- **Heartbeat checks** for scheduled agent health review.
- **Event log and timeline** for decisions, risks, todos, and notes.
- **Interactive TUI dashboard** included in the release.
- **Better check/doctor output** for humans and scripts.
- **Tunable config** for staleness, heartbeat, and watch intervals.
- **Shell completions** for bash, zsh, and fish.

## Agent Memory Layer

v0.3 adds a first-class agent-memory setup mode:

```bash
npx promexeus setup --mode agent-memory
```

This is for projects where the "codebase" is not necessarily the main thing being remembered. Examples:

- a persistent local agent
- a homelab or server environment
- OpenClaw-style operational workspaces
- Kubernetes/Docker/Ansible/Terraform runbooks
- long-running personal or team automation contexts

Agent-memory mode creates templates that treat mex as structured memory:

- `AGENTS.md` gives the agent a compact operating contract.
- `ROUTER.md` routes tasks to the right memory files.
- `HEARTBEAT.md` defines scheduled health checks.
- `context/` stores durable current-state memory.
- `patterns/` stores repeatable runbooks.
- `.mex/events/decisions.jsonl` stores append-only decisions and notes.

The GROW loop was updated for this use case:

- **Ground** what changed.
- **Record** the current truth in scaffold files.
- **Orient** by adding or refining patterns.
- **Write** `last_updated` and log rationale with `mex log` when it matters.

## Heartbeat and Scheduled Checks

New command:

```bash
mex heartbeat
```

Heartbeat is intentionally lighter than `mex check`. It is meant for persistent-agent setups where an agent may be woken up on a schedule and asked, "Is anything stale or due for review?"

It checks:

- optional `last_updated` frontmatter in scaffold files
- stale context files
- memory cleanup due dates
- old daily memory files in agent-memory workspaces

Clean output:

```bash
HEARTBEAT_OK
```

JSON output:

```bash
mex heartbeat --json
```

Scheduled foreground loop:

```bash
mex watch --interval
mex watch --interval 15
```

This runs heartbeat repeatedly instead of installing a post-commit hook. The existing `mex watch` hook behavior still works.

## Event Log and Timeline

v0.3 adds a tiny append-only event layer:

```bash
mex log "rotated API keys after provider incident"
mex log --type decision "keep OpenClaw ingress behind Cloudflare tunnel"
mex log --type risk --file .mex/context/setup.md "backup restore path is not tested yet"
```

Events are stored at:

```text
.mex/events/decisions.jsonl
```

Read them back with:

```bash
mex timeline
mex timeline --limit 20
mex timeline --json
```

This gives agents a lightweight way to preserve rationale without changing the scaffold schema or requiring a full event-sourcing architecture.

## TUI Dashboard

Bare `mex` now opens an interactive terminal dashboard:

```bash
mex
mex tui
```

The TUI shows:

- current scaffold path
- drift score
- error/warning counts
- files checked
- heartbeat status
- stale file count
- recent event activity
- latest timeline signal

Available actions:

- refresh dashboard
- run check summary
- run heartbeat
- run doctor summary
- view timeline
- log event
- exit

This is additive. All existing CLI commands still work the same and remain script-friendly.

## Better Health and Check Output

`mex check` now has clearer grouped output and script support:

```bash
mex check
mex check --quiet
mex check --json
```

Issues are easier to scan by severity, and remediation hints are clearer.

New doctor command:

```bash
mex doctor
```

`doctor` gives a friendly health summary across drift, heartbeat, config, and events.

## Tunable Config

Optional settings live in `.mex/config.json`.

Example:

```json
{
  "staleness": {
    "warnDays": 30,
    "errorDays": 90,
    "warnCommits": 50,
    "errorCommits": 200
  },
  "watch": {
    "intervalMinutes": 30
  },
  "heartbeat": {
    "staleDays": 7,
    "memoryCleanupDays": 7,
    "dailyMemoryRetentionDays": 14
  }
}
```

Missing values use defaults, so existing scaffolds do not need a migration.

## Shell Completions

Generate completions with:

```bash
mex completion bash
mex completion zsh
mex completion fish
```

## OpenClaw / Persistent Agent Use Case

The release is heavily informed by OpenClaw-style usage: an agent operating over a homelab-like environment with Kubernetes, Docker, Ansible, Terraform, networking, monitoring, and long-lived operational state.

For that workflow, mex v0.3 is useful because it separates three kinds of memory:

- **State memory:** current truth in `ROUTER.md` and `context/`.
- **Procedural memory:** repeatable runbooks in `patterns/`.
- **Event memory:** decisions, risks, and notes in `.mex/events/decisions.jsonl`.

A persistent agent can now:

1. Start by reading `ROUTER.md`.
2. Load only the memory files relevant to the task.
3. Run the right playbook from `patterns/`.
4. Log decisions with `mex log`.
5. Run `mex heartbeat` on a schedule to catch stale memory.

This expands mex beyond code repositories while keeping the original scaffold model intact.

## Compatibility

No scaffold migration is required.

v0.3 deliberately avoids the shelved routing/schema architecture work. Existing v0.2 scaffolds continue to work, and new features are additive:

- `last_updated` is optional.
- `.mex/config.json` is optional.
- `.mex/events/` is created when events are logged.
- TUI is additive and does not replace CLI commands.

## Not Included

The following remain intentionally deferred:

- context routing command
- full schema migration with ids/requires fields
- federation / hierarchical scaffolds
- bidirectional state-event references
- dynamic domain nodes via Tree-sitter

Those need a bigger architecture story and are not part of this stable v0.3 release.

## Upgrade

Install or update:

```bash
npm install -g promexeus@latest
```

Or use directly:

```bash
npx promexeus@latest setup
```

For an existing project, no scaffold reset is needed. Update the package, then run:

```bash
mex doctor
mex check
```

For an agent-memory workspace:

```bash
npx promexeus@latest setup --mode agent-memory
mex heartbeat
```

