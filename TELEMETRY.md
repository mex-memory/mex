# Telemetry

mex collects **anonymous, opt-out** usage data so the maintainer can see how the
tool is actually used — which commands matter, roughly how many people use it,
and whether a project is used by a team. That's the entire purpose. There is no
advertising, no profiling, and no way to tie any data back to a person.

If you'd rather send nothing, see [How to opt out](#how-to-opt-out) — it's one
command or one environment variable.

## What is collected

Every time you run a `mex` command, **one** event is sent containing **exactly**
these fields and nothing else:

| Field | Example | What it is |
|-------|---------|------------|
| `machine_id` | `3f2a…` (random UUID) | A random ID generated once per machine. Not your username, hostname, or anything derived from you. |
| `scaffold_id` | `9b1c…` (random UUID) | A random ID for the mex scaffold (project). Only present when you run inside a scaffold. Lets us tell "one team on one project" apart from "one person on many machines." |
| `command` | `check` | The command **name only** — e.g. `check`, `sync`, `log`. |
| `mex_version` | `0.5.1` | The installed mex version. |
| `os` | `darwin` | The platform string (`darwin` / `linux` / `win32`). |
| `node_version` | `v22.17.1` | The Node.js version. |

You can see the literal payload that would be sent, at any time, without sending
anything:

```bash
mex telemetry inspect
```

## What is NEVER collected

- **No personal data** — no name, email, username, hostname, or git identity.
- **No IP address or location** — geolocation is explicitly disabled.
- **No command arguments, flags, or paths.**
- **No file names or file contents.**
- **No repository name or git remote URL.**

`machine_id` and `scaffold_id` are random UUIDs. They are **not** derived from
your path, repo, email, or anything identifying — they are just random numbers
that let counts be de-duplicated.

## Where the data goes

[PostHog](https://posthog.com) Cloud, **US region** (`https://us.i.posthog.com`).
The ingestion key embedded in mex is write-only — it can send events but cannot
read any data back.

## When telemetry does NOT run

Telemetry is automatically disabled — no event sent, no ID file created — when:

- any opt-out below is active, **or**
- mex is run from a clone of the mex repository itself (so the maintainer's own
  development never pollutes the data).

A telemetry failure (offline, firewall, ad-blocker) never blocks, slows, or
changes the exit code of any command. It is fire-and-forget and fully ignored on
error.

## How to opt out

Any **one** of these turns telemetry off completely. When off, no event is ever
sent and the machine-id file is never created.

| Method | Scope |
|--------|-------|
| `DO_NOT_TRACK=1` | The industry-standard env var. Honored everywhere. |
| `MEX_TELEMETRY=0` | mex-specific env var. |
| `mex config set telemetry off` | Persisted in `~/.mex/config.json` (per-machine). Re-enable with `mex config set telemetry on`. |

Check the current state and the active opt-out reason any time:

```bash
mex telemetry status
```

## Files mex writes for telemetry

- `~/.mex/telemetry-id` — your random `machine_id` (mode `0600`). Created only
  when telemetry is enabled. Delete it any time; a new one is generated on the
  next enabled run.
- `~/.mex/config.json` — your global preferences, including the telemetry
  opt-out flag.

These are separate from a project's `.mex/config.json`, which holds the
project's `scaffold_id`.

## A note on PostHog metadata

The PostHog client library attaches two of its own fields to each event —
`$lib` (`posthog-node`) and `$lib_version`. These describe the sending library,
not you, and contain no personal or usage data.
