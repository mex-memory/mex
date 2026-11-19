# Compatibility

## MEX 0.9.0-beta.1

This is a pre-release on npm's `next` tag. MEX 0.8.5 stays on `latest`.
The beta rebuilds setup, notes, checks, sharing and agent hooks. The rebuilt Hub
arrives in 0.9.0; a 0.9 checkout does not start the 0.8 Hub.

## Agents in 0.9 (planned after beta.1)

What MEX can do in each coding agent. Each agent gets its strongest channel;
where a cell says "next tool result", MEX's text waits for the agent's next tool
call because the agent offers no better moment. Rows marked *pending OSS-48*
state what that ticket specifies and are confirmed there.

Every hook profile answers in its agent's own format, exits 0, and sends the
agent's "do nothing" reply on any error, so a MEX failure never stops the agent.

| Agent | Brief and moments | After compaction | Edit check | Subagents | Control before the model | A line for the person |
| --- | --- | --- | --- | --- | --- | --- |
| Claude Code | Session start, prompt, after a batch of tools | SessionStart `compact` | Pre-tool deny, reason to the model | `agent_id`; a brief at SubagentStart | Prompt hook block | `systemMessage` |
| Codex | Session start, prompt, after a tool | SessionStart `compact` | `apply_patch` deny, reason to the model | SubagentStart brief | Prompt hook block | `systemMessage` |
| Cursor | Session start, after a tool (added to the tool result). No prompt moment | No post-compaction event: next tool result | `preToolUse` deny, `agent_message` to the model | Allow or deny only; no brief | `beforeSubmitPrompt` block | `user_message` on a block and before compaction |
| Antigravity | Session start and the first model call of each turn, as an ephemeral system step (never a user message) | No compaction events | `PreToolUse` deny with reason | None: no subagent ids | `PreInvocation` terminate | None: `errorMessage` would fail a `-p` run |
| Gemini CLI (API key, Vertex AI, Code Assist) | Session start, prompt (this turn only), after a tool | `PreCompress` shows a line; nothing reaches the model | `BeforeTool` deny with reason | No subagent event | `BeforeAgent` stops the turn | `systemMessage` |
| Copilot CLI *(pending OSS-48)* | Session start; after a tool, added to the tool result | No post event: next tool result | Pre-tool deny with reason; a crash also denies, so MEX registers it only after a self-test | `agentId` on events | None: hooks can't block a prompt | Progress lines |
| OpenCode *(pending OSS-48)* | Plugin events; no prompt hook | Compaction hook can add context | `tool.execute.before` throws | Child sessions | None | To check |
| Devin (CLI and Desktop) *(pending OSS-48)* | Session start, prompt, after a tool | Next tool result | Pre-tool block, reason to the model | To check | To check | None documented |
| Kiro *(pending OSS-48)* | Session start, prompt | PreCompact adds context | Pre-tool exit 2, reason to the model | To check | To check | Stop confirm dialog |

Stop proof checks (continue the turn with a reason the model reads) work on
Claude Code, Codex, Cursor (`followup_message`), Antigravity (`decision:
"continue"`) and Gemini CLI (`AfterAgent` deny retries with the reason).

Limits we accept: Antigravity sends no tool output, so successful commands
can't be learned there, and text after a tool waits for the next turn. Cursor's
`sessionStart` context is reported as unreliable. Gemini CLI context from
`BeforeAgent` lasts one turn; text after a tool stays in the history.

### Hooks files MEX writes

User-level files only; a tracked hook file is never edited. One install path
per agent.

| Agent | File | Turned off by |
| --- | --- | --- |
| Cursor | `~/.cursor/hooks.json` | An enterprise `hooks.json` (`/etc/cursor/`, `/Library/Application Support/Cursor/`, `C:\ProgramData\Cursor\`) |
| Antigravity | `~/.gemini/config/hooks.json` | `"enabled": false` on the hook; Settings > Customizations > Hooks |
| Gemini CLI | `~/.gemini/settings.json` | `hooksConfig.enabled: false`; an untrusted folder (folder trust); system settings |

Cursor also runs Claude Code's hooks. When Cursor has its own MEX hooks the
borrowed Claude hook stays silent; otherwise it answers in Cursor's format.

### Who loads which rule file

Unscoped rules go in `AGENTS.md`. Scoped rules go only in the scoped format of
an agent in use, never in both, because some agents read several files.

| Agent | Unscoped rules | Scoped rules |
| --- | --- | --- |
| Claude Code | `CLAUDE.md` (imports `AGENTS.md`) | `.claude/rules/*.md` with `paths:` |
| Codex | `AGENTS.md`, nested by folder | Nested `AGENTS.md` |
| Cursor | `AGENTS.md` | `.cursor/rules/*.mdc` with `globs:` |
| Antigravity | `AGENTS.md` | `.agents/rules/*.md` with a glob |
| Gemini CLI | `GEMINI.md` by folder (set `context.fileName` to read `AGENTS.md`) | Nested `GEMINI.md` |
| Copilot CLI *(OSS-48)* | `AGENTS.md`, also `CLAUDE.md` | `.github/instructions/*.instructions.md` with `applyTo` |
| OpenCode *(OSS-48)* | Root `AGENTS.md` (nested not loaded) | None |
| Devin *(OSS-48)* | `AGENTS.md` | Native glob rules |
| Kiro *(OSS-48)* | `AGENTS.md` | Always-on steering only (its CLI ignores `fileMatch`) |
| Cline | `AGENTS.md`, `.clinerules` | `.clinerules` |
| Amp | `AGENTS.md` | None |
| Aider | Rule files passed with `--read` | None |

### Agents MEX doesn't run in

- **Cline:** rule files (`AGENTS.md`, `.clinerules`). Its hooks run on macOS
  and Linux only, not Windows; MEX doesn't register them in 0.9.
- **Amp:** `AGENTS.md`. Plugins exist, but its threads live in the cloud, so
  MEX hooks are on demand, not in 0.9.
- **Aider:** rule files only. No hooks.
- **Devin Desktop** (Windsurf until 2 Jun 2026): native rule files; its hooks
  are covered with Devin by OSS-48.
- Cloud sessions and teammates without MEX get the committed rule files only.

### Models per agent

A cheap and a best model per agent, in `src/model-runner/models.ts`
(`AGENT_MODELS`). Only Claude Code and Codex run MEX's own background calls.

| Agent | Background run | Cheap | Best |
| --- | --- | --- | --- |
| Claude Code | `claude -p` | `haiku` | `opus` |
| Codex | `codex exec --ephemeral` | `gpt-6-luna` | `gpt-6.1-sol` |
| Cursor | `agent -p --model` | Account default (slugs from `agent models`) | Account default |
| Antigravity | `agy -p` (no model flag) | App default | App default |
| Gemini CLI | `gemini -p --model` | `flash` | `pro` |

### Sources

Read on 15 Nov 2026: [Cursor hooks](https://cursor.com/docs/agent/hooks),
[Cursor CLI parameters](https://cursor.com/docs/cli/reference/parameters),
[Antigravity hooks](https://antigravity.google/docs/hooks),
[Gemini CLI hooks](https://geminicli.com/docs/hooks/reference/). Claude Code
and Codex rows were checked in live sessions on 13 Nov 2026. Rows for Cursor,
Antigravity and Gemini CLI are from the docs only until the live smoke test
(release-03-T1) records a session in each.

## Runtime and operating systems

- Node 22.5 or later, with the built-in `node:sqlite` module.
- Windows, macOS and Linux.
- Native hook packages are selected for the platform. If the native binary is
  unavailable, installation reports the Node fallback.
- `mex status` reads installation state and runs the native binary's self-test.
  `mex doctor` adds a fix for each recorded problem.

### Tested agent versions

| Agent | Version used for beta.1 qualification |
| --- | --- |
| Claude Code | 2.1.326 (live sessions on Windows 11, 17 Nov 2026) |
| Codex | 0.165 (live sessions on Windows 11, 17 Nov 2026) |

Claude Code and Codex are the supported agents in beta.1. More agents are planned
for 0.9.0. In Codex, review and trust MEX's hooks once: `/hooks` in the CLI, or **Review hooks** beside the message box in the app. Until then Codex skips them.
A note saved with `mex note` reached a new session on both agents (6 of 6 on each), and a note the code had made false was held back on both. See `docs/design/0.9.0-release-plan.md`.

## Install and undo

```sh
npm i -g mex-agent@next
cd your-repo && mex
```

Hooks are installed in user settings. Bare `mex` does not add tracked files,
run repo commands or make a model call for the first screen. Learning from what you type is off until you turn it
on (`mex config set learning.statements on`); it then uses the installed agent's
smallest model on your plan, at most 3% of your usage. `mex capture off` stops capture here.

`mex off` stops MEX in this repo. `mex uninstall` restores the changes MEX
recorded and keeps notes. `mex uninstall --purge` also removes the notes.
Locally changed installation files are reported for review rather than overwritten.

## Notes, checks and sharing

Notes without recorded checks are unknown. A failed complete check holds a note
back. A changed supporting check can send a pointer to current code. Status
reads cached verdicts; `mex check` runs the checks.

`mex share` previews a new share branch. Follow the printed `--apply --expect`
command after review. Nothing is pushed without `--pr`. Teammates receive the
reviewed notes and agent rule files through git; databases remain local.

## Upgrading from 0.8

Run `mex upgrade` in the old repo for a preview. Apply only the exact revision
printed by that preview. Review its tracked branch before sharing.
Existing 0.8 pages remain readable with `mex hub` while `.mex/ROUTER.md` exists.
`mex doctor --legacy` runs the old diagnostic.

## Package and API scope

The CLI is the supported beta entry point. Package-root exports remain limited
to the APIs exported by `src/index.ts`; internal modules are not a stable API.
Do not share local databases or runtime files through git.

Next: run `mex status` after installation. Use `mex doctor` if a part is unknown.
