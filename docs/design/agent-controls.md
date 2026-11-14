# Agent controls

The foundation-04 controls use the existing Node-owned `record.db` and
Go-owned `hooks.db`. There is no schema migration or third database.

## Commands and precedence

| Scope | Off | Undo | Effect |
| --- | --- | --- | --- |
| Current agent session | Type exactly `mex pause` in the agent chat | Type exactly `mex resume` | Holds MEX delivery, capture and hook-triggered index/background work for that session |
| Registered checkout | `mex off`, optionally `--for 2h` | `mex on`, or expiry | Holds that checkout's hook work; does not alter shared rule files |
| Everywhere | `mex off --all` | `mex on --all` | Holds hook work and automatic background batches |
| Current terminal | `MEX_OFF=1` | Unset the variable | Native/Node hooks exit before reading stdin or resolving storage; no automatic background start |
| Capture in this project | `mex capture off` | `mex capture on` | Holds capture without disabling delivery or index maintenance |
| Capture everywhere | `mex capture off --all` | `mex capture on --all` | Overrides project capture-on choices |

Repo and global commands accept `--json` and report the saved choice. An on or
resume action changes only its own scope. A broader off remains in effect;
the confirmation says so. Existing shared rule files can still be loaded by
the agent independently. MEX never changes another hook's settings.

Durations are positive numbers followed by `m`, `h` or `d` (for example `30m`,
`2h`, `0.5d`). A malformed duration is rejected before opening storage.
Timed off uses an absolute UTC deadline; expiry is evaluated on reads and
does not need a running timer or background process. Global off has an explicit
undo and does not accept `--for`.

Automatic project jobs require an on registered checkout (including an expired
timed off). Another on clone/worktree permits shared project work. Global off holds
machine jobs as well. A batch already in flight finishes and checkpoints;
the next automatic batch is held. Explicit `mex jobs run` remains available.
Capture-off does not disable usage accounting or automatic jobs.

## Consuming a session control

Hook contract version 1 adds optional `Reply.consume_prompt` (default false)
and `KindSupport.ConsumePrompt`. Only prompt events support it. Both current
profiles render it as exit-zero JSON:

```json
{"decision":"block","reason":"MEX is paused for this session. Type `mex resume` to resume."}
```

The reason is a confirmation for the person. No model context is attached.
Tool/stop deny semantics are unchanged. Longer requests, quoted commands,
case variants and subagent prompts are passed through. The handler requires
a nonempty session ID and a successful durable state/mirror write before
consuming a prompt. Failure allows the agent to continue normally.

Both current agent payloads omit typed/pasted provenance. The adapters mark
prompts typed, so an exact pasted control is indistinguishable from an exact
typed control. JSON fixtures and separate-process tests prove MEX's behavior;
interactive interception remains part of OSS-61, not a claim from these tests.
References: [Codex hooks](https://learn.chatgpt.com/docs/hooks#userpromptsubmit)
and [Claude Code hooks](https://code.claude.com/docs/en/hooks#userpromptsubmit-decision-control).

## Storage and mirrors

Node settings use scope `global`, keys `enabled` and `capture.enabled`, with
literal `true`/`false` values. Project capture uses the registered project ID
as scope and `capture.enabled`. Checkout off uses the existing
`checkouts.state/off_until` fields and hook checkout mirror.

| File | Writer | Shape |
| --- | --- | --- |
| `<MEX home>/controls.json` | Node, from settings | `{"version":1,"off":false,"capture":true}` |
| `<record directory>/hook-capture/<project-id>.json` | Node, from project capture setting | `{"version":1,"enabled":false}` |
| `<record directory>/hook-paused/<key>` | Go, with `sessions.paused` | Empty marker while paused; key is the 24-hex short hash of `agent + NUL + session_id` |

New global/capture mirrors are bounded to 4 KiB, replaced atomically, and reject
redirected paths and linked/nonregular leaves. Hook reads are bounded too.
Absent optional mirrors preserve the existing on/capture-on defaults; invalid
global controls disable MEX work, and invalid capture controls disable capture.
Only capture consumers read project capture mirrors, keeping those reads off
ordinary tool hooks. The current diagnostic payload recorder obeys the capture
gate; later journal capture must use the same gate. No journal producer is
added by this slice.

The Node writer lock covers checkout reads and mirror publication, including
ordinary registration, so stale registration snapshots cannot undo an off
command. Explicit commands report publication errors. Node writer opens repair
settings mirrors from committed rows; read-only opens never repair.

Session control writes serialize in one Go transaction. The pause marker is
published before commit; publication/commit failure restores the previous
marker where possible and rolls back the database. A process crash in that
small interval can conservatively leave a session paused until `mex resume`.
The marker survives hook processes and same-ID session resumes/compaction.
A different session ID starts unpaused. Existing sessions retain their agent
ownership, checkout and start timestamp. Ordinary tool hooks read the marker
instead of opening SQLite for session policy.

The inherited Node fallback remains empty-response only: it has no Go-owned
session writer or delivery engine. Native package publication/wiring remains
release work. These controls neither start a model nor spend plan allowance.
