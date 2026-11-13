# Telemetry

MEX sends usage counts to help improve it. Telemetry is on by default, with a notice before any report is sent.

```sh
mex telemetry status
mex telemetry inspect
mex telemetry off
mex telemetry on
```

The older `disable` and `enable` names remain aliases. `mex config set telemetry off|on` changes the same preference.

## Your controls

`DO_NOT_TRACK=1` and `MEX_TELEMETRY=0` disable telemetry for the invocation. `MEX_OFFLINE=1` also disables update fetching. Environment switches take precedence over the stored setting. Existing opt-outs survive an upgrade. An independent opt-out marker prevents an unrelated, stale configuration writer from turning telemetry back on. Unreadable, malformed or unsafe existing preferences keep telemetry off.

The CLI shows this explanation once for the new reporting version, including after an upgrade from 0.8:

> MEX sends anonymous usage counts to help improve it: never code, file paths, prompts or repo names. Turn off any time: mex telemetry off (or DO_NOT_TRACK=1)

The installation ID is random and permits repeat-use measurement. This is pseudonymous data; the notice does not mean that successive reports are unlinkable.

Turning telemetry off aborts this process's active send and clears pending reports. Pre-opt-out counters, including Go-owned counts through that UTC day, cannot be reported after re-enabling. The off action is retained locally when a record already exists; it is not sent after opting out.

## What is counted

Hooks increment daily counters in Go-owned `hooks.db`. The CLI, jobs and Hub increment counters in Node-owned `record.db`. Hooks do no network work and never create an installation ID. Counter names and agent names come from fixed allowlists.

Current producers measure front-door commands, setup outcomes, Hub sessions and page views, completed or failed jobs, graph jobs, and hook sessions, calls, parsing failures and processing-time histograms. Delivery features can use the closed knowledge-delivery and feedback counters as they are built. An uninstrumented feature does not manufacture a zero or a success.

The background process combines counters for each completed UTC day into one `daily` report. The ranges are `0`, `1`, `2–5`, `6–20`, `21–100` and `100+` (values above 100). It retains per-agent breakdowns when available. Hook p95 is a range derived from handler-time histogram buckets; the separate timing gate measures the full process call, including startup and counter writing.

A process that remains running checks for due reports once a minute. If it exits before midnight, a later invocation or session/background-process start can report the completed day. MEX does not start a permanent reporting daemon.

## Event catalog

| Event | Trigger |
| --- | --- |
| `install.first_run` | First display of the new usage notice; retained as a lifetime local marker. |
| `setup.finished` | The first completed setup or initialization in a checkout. Repeat runs still add to local setup counters. |
| `daily` | Usage during a completed UTC day, at most one report per day. |
| `share.done` | A completed sharing operation, through the lifecycle reporting interface. |
| `on` | An explicit enable action. |
| `off` | The local disable record; never sent after opting out. |
| `uninstall` | The lifecycle reporting interface for uninstall. |
| `error` | A fixed error code, through the lifecycle interface; no exception text. |
| `ci.run` | One eligible automated CLI invocation, separately from personal usage. |

Sharing, uninstall and later product features own their call sites. Their event types being available does not claim those features have shipped. Internal legacy producer categories are converted into counters; per-command and per-page events from the old queue are never drained by v3.

## Privacy boundary

Reports exclude code, prompts, knowledge text, arguments, searches, file paths, repository names or remotes, raw error messages, account names, contact details and session IDs.

Allowed envelope fields are the fixed event name, event UUID, original timestamp, schema version, MEX version, operating system, source and a random installation ID for personal reports. The client requests no person profiles and no GeoIP. The ingestion service can observe ordinary transport metadata.

Payloads permit only approved count ranges, known agent names, fixed command/outcome/error categories, and a shared-project UUID where applicable. Only an explicitly shared registered project with a share-created random ID may supply that UUID. Unshared scaffolds and repository-derived hashes do not supply it. Telemetry reads never create a project ID or mark a project as shared.

CI sends one `ci.run` event with a fixed CI identity. It never creates or attaches a personal installation ID. The CLI prints the CI usage notice before the send. CI, people and totals must be analyzed separately.

## Local state and delivery

`mex telemetry inspect` is read-only: it shows the recent sent reports, pending lifecycle reports, controls and limits. It does not create an ID, initialize or repair storage, capture an event, or send.

Counters and report records use the existing local databases. Preferences, the durable opt-out marker and the random installation UUID remain under `~/.mex`, or the configured MEX home. Nothing is written into tracked project files.

Pending reports are limited to 128 records of at most 16 KiB each and expire after seven days. The latest 100 acknowledged reports are retained for inspection. Counters and daily deduplication markers have a seven-day reporting window; first-install and first-setup markers remain local for the installation's lifetime. Setup markers use a local checkout hash that is never a report property. Reports are validated again before sending. Unknown fields, raw numbers or malformed records never leave the machine.

The existing background process handles personal delivery. A bounded lease coordinates foreground and background job runners. A failed request retains the same event UUID and timestamp for retry; the server can deduplicate that UUID after a lost acknowledgement. Each request is capped at two seconds, each batch at eight reports. No automatic network retry loop keeps the background process alive.

The old v2 outbox is no longer a sending source. Explicit opt-out also attempts to purge it.

Development checkouts and `MEX_DEV` disable collection and sending. Tests isolate the MEX home and use a silent sink or an explicit loopback-only transport seam.

## Update notices

Bare interactive `mex` checks for an update at most once per UTC day, with a 1.5-second deadline and a bounded response. This check sends no telemetry identity. It does not run in recognized agent sessions, background runs or CI. `MEX_OFFLINE=1` stops it.

## Contact details

Optional contact forms are separate from telemetry. Their name and email fields are not attached to installation or project IDs, included in usage reports, or recorded in tracked project files.
