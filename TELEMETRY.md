# Telemetry

MEX collects **pseudonymous, opt-out usage events** to understand feature use,
success rates, and whether installations return. CLI and Hub events share one
random installation UUID. When available, events also carry the project's
existing random scaffold UUID and its configured AI-tool names. An installation
is not a person: two computers have different IDs, and a shared installation
has one ID. Multiple installations using one scaffold can indicate shared
project use, but cannot establish a team or its size.

## What is collected

Every event has a name from a fixed catalog, an original UTC timestamp, a random
event UUID for deduplication, and a random installation UUID (`distinct_id` and
`installation_id`). Common properties are `schema_version: 2`, `source`
(`cli` or `hub`), MEX version, OS platform, and Node version. Person-profile
creation and GeoIP enrichment are explicitly disabled. All six events can also
include these optional properties:

| Property | Source and meaning |
| --- | --- |
| `scaffold_id` | The existing UUIDv4 in the project's `.mex/config.json`; telemetry never creates or repairs it. |
| `configured_ai_tools` | A sorted, unique list of configured tool names: `claude`, `codex`, `copilot`, `cursor`, `opencode`, and/or `windsurf`. This is the project's setup selection, not the agent currently invoking MEX. |

The metadata reader performs a bounded, read-only snapshot of the existing
project configuration. Ordinary CLI commands reuse one snapshot; `setup` and
`init` reread it at completion so newly saved configuration can appear in the
completion event. The Hub keeps its project's snapshot from the first enabled
event until restart. Missing, malformed, unreadable, or unsafe configuration
omits this metadata. Invalid scaffold IDs and unknown tool names are excluded.
An explicitly empty tool selection can appear as `[]`. MEX does not inspect
running processes or tool accounts to determine which agent is in use.

| Event | Additional fields | Purpose |
| --- | --- | --- |
| `cli.command_started` | Namespaced command, stage | Count eligible invocations, including those interrupted before completion |
| `cli.command_completed` | Command, stage, outcome, duration in ms | Feature use and success/failure rates |
| `hub.session_started` | None | Count successful Hub starts; not active engagement by itself |
| `hub.page_viewed` | Fixed page category | Understand navigation without sending URLs |
| `hub.action_completed` | Fixed action, stage, outcome, duration in ms; optional apply replay flag | Understand explicit actions and distinguish preview from apply |
| `hub.job_completed` | Fixed job kind, outcome, duration in ms | Understand graph/Wiki job results |

Commands use names such as `wiki.query` and `relay.draft.save`. Stages are
`preview`, `apply`, or `direct`; the program derives the stage without sending
argument values. Outcomes are `success`, `failure`, or `cancelled` (for Hub
jobs). Durations are capped at 24 hours. CLI completion means the command's
exit status; a successful preview is not a published artifact. For TUI and
interval-watch launchers, completion describes startup of the interface or
watcher, not the end of that later session.

Hub pages are categories such as `knowledge_detail`, never a knowledge ID or a
URL. Validated Hub actions and terminal job results are recorded on the local
server. Ordinary API reads, polling, SSE, typing, and repeated renders do not
produce usage events. Page events are capped at 60 per minute per Hub process.

CLI telemetry/configuration controls and explicitly pure discovery/read
surfaces stay silent: `capabilities`, `logging`, `timeline`, Team list/show/
contract/target reads, Spec reads, and `skills sync`. Hub bootstrap is counted
by the Hub event rather than a second CLI event. Explicit Team mutation
commands are eligible. Unknown commands and invalid options rejected before
an action starts produce no command event.

Inspect the current catalog, example payloads, queue limits, and existing local
queue metadata without creating an ID, writing a queue, or sending anything:

```bash
mex telemetry inspect
mex telemetry status
```

## What is excluded

MEX does not put names, email addresses, usernames, hostnames, Git identities,
repository names/remotes, file paths, code, knowledge/log content, search text,
raw arguments, receipt tokens, or Member/artifact IDs in events. The only
project identifier is the existing random scaffold UUID described above.
Unknown event properties and values are rejected, including when reading queued
events back from disk.

Random IDs allow repeat-use measurement; this is pseudonymous data, not a claim
of complete anonymity. A scaffold UUID can be linked to its project by anyone
who also has access to that project's configuration. One person using several
machines, a shared installation, or copied scaffolds retaining an ID can distort
estimates of shared use. Requests go to [PostHog Cloud](https://posthog.com), US
region (`https://us.i.posthog.com/batch/`). MEX does not add an IP address to the
payload. The receiving service can observe the request's IP and ordinary
transport metadata; disabling GeoIP is not a promise that transport metadata
never exists.

## Delivery and performance

Events enter a small local queue. Delivery runs opportunistically while a CLI
command works and periodically while the Hub is open. CLI cleanup gives network
delivery a 25 ms grace by default, then cancels outstanding delivery. There is no detached
sender, retry loop, or telemetry daemon. Hub batching uses an unreferenced
15-second timer; each request has a 2-second timeout. A request failure does not
change product output or exit status.

The queue retains at most 256 events, 256 KiB of event payload, in a database
bounded to 1 MiB. Events older than seven days are discarded on the next queue access and are never sent; without a daemon, an untouched
queue file may physically remain on disk longer. Batches contain at most 32
events.
A busy or unavailable queue drops telemetry instead of waiting on another
command. Queue and network work still have a small CPU/disk cost; latency is
measured with the actual CLI, including unreachable and hanging servers.

Delivery is best effort. A short command's final event can remain queued until
another eligible invocation or Hub session; a final invocation might never be
sent. Oldest events are evicted at the bounds. Retries retain the original event
time and UUID. Abrupt termination can leave a start without a completion;
absence of completion does not prove command failure. Do not interpret the
resulting counts as an exhaustive audit log. Local queue expiry does not set
the hosted analytics service's retention period.

## Opt out

Any one of these disables collection and sending:

```bash
mex telemetry disable
# Equivalent persisted preference:
mex config set telemetry off
# Or an environment override:
DO_NOT_TRACK=1 mex check
MEX_TELEMETRY=0 mex check
```

`mex telemetry enable` restores the stored preference and removes the local
opt-out marker; environment overrides still win. The marker prevents unrelated
concurrent preference writes from silently re-enabling telemetry. An unreadable,
malformed, or unsafe existing global preference file also keeps telemetry off; a missing file uses the default. Development
checkouts of MEX and `MEX_DEV` also disable telemetry.
Opt-out is checked before capture and delivery. Explicit disable cancels this
process's delivery and attempts to clear the existing bounded queue. A locked
or damaged queue can prevent cleanup, but the stored opt-out still prevents
sending on subsequent invocations. Already delivered events are not deleted
by a local opt-out.

Telemetry uses `~/.mex/telemetry-id` (a random UUID, mode `0600`),
`~/.mex/telemetry/outbox.db` (inside a directory created with mode `0700`), and
the global preference in `~/.mex/config.json`. Explicit disable also writes
`~/.mex/telemetry-disabled`, a small opt-out marker removed only by explicit
enable. A short-lived SQLite rollback journal may exist during writes. The
telemetry queue, installation identity, and preferences are local to the user;
telemetry writes nothing to the project's Git artifacts. The existing scaffold
UUID and tool selection are read from project configuration, which may already
be shared through Git. `MEX_HOME` relocates the global `.mex` directory.

## Voluntary feedback and contact

`mex feedback` opens the separate [hosted feedback form](https://tally.so/r/KYjv4k).
The Hub's **Request access** dialog and the optional setup contact step use
Web3Forms while keeping the user in the Hub. Terminal setup offers the same
optional contact submission. Submitting setup contact requires an email; name
is optional, and skipping never blocks setup.

Contact details go only to the form service, without an installation or
scaffold ID. They are not recorded in telemetry, project files, or the local
contact preference. The only saved contact state is a submitted/skipped marker
under `~/.mex/setup/` (or the relocated `MEX_HOME` directory), shared across
projects and Hub ports. A failed submission remains retryable. This preference
is independent of the telemetry opt-out.
