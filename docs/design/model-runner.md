# MEX's model runner

Foundation-04 supplies one process owner and accounting boundary for MEX's
non-interactive model calls. The [automatic allowance and machine queue](model-budget.md)
add durable admissions through record migration 4. No scheduled model task,
package-root export or interactive-agent behavior change is added; live plan
acceptance remains OSS-61.

## Entry points

`src/model-runner/index.ts` exposes the internal `runModel` API: agent, prompt,
project root, an accounting purpose, model role/setup, optional cancellation
and timeout. It returns the final text, selected model and observed usage.
Automatic work supplies `automatic: { estimate }` to reserve allowance;
explicit user commands omit it and remain uncapped while joining the same lane.
Prompts go through stdin, with a 1 MiB limit, rather than command arguments or
new prompt files. Text tasks disable Claude's tools and use Codex's read-only
sandbox. Results have a 1 MiB limit and an 8 MiB total JSON stream limit;
invalid/incomplete/oversized results fail rather than returning partial text.

Existing setup keeps its owned private prompt, agent discovery, tool approvals,
Cursor permission lease and UI error/progress behavior. Its headless adapter
calls `model-runner/process.ts`, the same process owner used by `runModel`.
Existing activity/transcript imports re-export the shared decoders, preserving
their callers and default bounds. Other retained setup agents still use their
existing command policies; this slice adds model choices for Claude and Codex.

## Model table

Names live only in `src/model-runner/models.ts`, not in process or task logic.

| Agent | Cheap | Best |
| --- | --- | --- |
| Claude Code | `haiku` | `opus` |
| Codex | `gpt-6-luna` | `gpt-6.1-sol` |

`mixed` selects cheap for a cheap-role task and best for a best-role task.
`best-only` selects best for both. Missing cheap selects best. The default role
is best, including setup writing. Both strategies and replacement tables are
options for internal consumers; no new user-facing model-settings screen is
added here. There is no automatic provider/model retry or silent fallback after
a failed invocation. A table entry must be a model identifier, never a flag.

The Claude aliases track the vendor's installed model mapping. The Codex best
entry follows the build plan's replication model; Luna supplies its cheap role.
Availability on a particular account is checked by the agent itself when a real
run is explicitly authorized. These choices were not quality-tested by calling
models during this slice.

## Per-run lean configuration

Both command builders and the process owner force `MEX_BACKGROUND=1`. This makes
MEX hooks inert even where policy still invokes one. No permanent settings are
changed, and interactive sessions keep their existing arguments/environment.

Claude uses `-p`, `--safe-mode`, `--no-session-persistence`, an explicit model
and a short system prompt. Safe mode retains normal authentication and
permissions while omitting user custom context, hooks, skills and auto memory.
It avoids the API-only authentication of `--bare`. Setup retains its existing
approved command tools; text-only calls disable tools.
[Claude CLI reference](https://code.claude.com/docs/en/cli-reference).

Codex uses `exec --json --ephemeral`, disables ordinary
hooks, suppresses project instruction loading, and disables
memory input/generation for the invocation. Auth still uses the normal Codex
home. User/provider/permission configuration remains loaded; targeted per-run
overrides suppress extra context rather than discarding that configuration.
User-configured MCP integrations remain available; an empty table override is
not treated as a supported way to disable them. The sandbox constrains local
writes and does not disable integration tools.
Text calls are read-only; setup retains workspace-write and its non-Git
option. The runner neither bypasses approval/sandbox policy nor disables managed
requirements. [Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode),
[configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).

These are documented CLI requests, not proof that every client/account version
honors them. The real plan/authentication, no-saved-session and hook behavior
checks remain the separately authorized live acceptance work.

## Lifetime and accounting

The shared owner drains stdout/stderr, owns cancellation and the child process
tree, cleans remaining helpers, and records usage after pipe closure. Setup
keeps its existing bounded inactivity behavior. One-shot text calls additionally
have a wall-clock deadline: five minutes by default, capped at fifteen minutes.
A stream that keeps producing activity cannot extend that deadline. Errors
contain fixed categories/messages, not prompts, provider text, paths or secrets.

Accounting remains `record/usage.ts`: reported token classes, terminal totals,
per-model reports and marked estimates retain their existing meaning. The
requested model is returned separately as `selectedModel`; a model omitted
by the CLI remains `unknown` in observed usage and the database. A selected
product default is never presented as a reported model. There is one accounting
pass, including failed/cancelled attempts, without recording prompt/result text.

Setup retains its existing decoder limits. One-shot calls opt into bounded
larger JSON lines so a valid 1 MiB response and its reported usage are accepted.
The own-usage log reader's limits are unchanged.

The test-suite guard `MEX_SETUP_BACKGROUND_AGENTS=0` also prevents `runModel`
from starting a real CLI; tests inject Node fake-agent transports. Deterministic
tests cover both strategies, command/env policy, stdin, large/invalid results,
deadline/cancellation, cleanup, private errors and exact accounting. No model
call is needed for these tests.
