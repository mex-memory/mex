# Agent profiles: Copilot CLI, OpenCode, Devin, Kiro CLI

Profiles for four more agents on the hook contract. Each agent gets
one install path, through its strongest channel, and none of them can be
broken by MEX: the shim always exits 0 with that agent's empty reply.

Shapes come from each agent's docs, checked 15 Nov 2026. None of the four was
installed on the build machine, so every fixture is hand-written and the live
test records real payloads. Anything that test can't confirm
stays off.

The code lives in `native/internal/adapter/{copilot,opencode,devin,kiro}`.
Profiles render from `adapter.Narrow`, so a reply part the agent can't carry
is dropped and named, never sent.

## Summary

| | Copilot CLI | OpenCode | Devin | Kiro CLI |
|---|---|---|---|---|
| Install path | `~/.copilot/hooks.json` (`COPILOT_HOME`), **only after a self-test** | Plugin `~/.config/opencode/plugin/mex.js` (`XDG_CONFIG_HOME`) | Claude Code's hooks in `~/.claude/settings.json`, which Devin runs | None: rule files only |
| Failure behaviour | **A hook that crashes or can't start denies the tool call** | Plugin swallows every error | Continues | Continues |
| Reply format | JSON (`permissionDecision`, `modifiedResult`, `additionalContext`) | MEX's own JSON to its plugin (`deny`, `append`, `output`, `context`) | Claude's JSON (`hookSpecificOutput`) | Plain stdout text |
| Session start | `sessionStart`: context | `session.created`: capture only | `SessionStart`: context | `agentSpawn`: context |
| Prompt | `userPromptSubmitted`: capture only; can't block | No prompt hook | `UserPromptSubmit`: context | `userPromptSubmit`: context |
| Capture (post-tool) | `postToolUse`, `postToolUseFailure` | `tool.execute.after` | `PostToolUse` | `postToolUse` |
| Delivery with a tool result | Context appended to the tool result (`modifiedResult`) | Appended to the tool output | System context | Not available |
| Edit check (pre-tool deny) | `preToolUse` deny with reason | `tool.execute.before` throws the reason | `PreToolUse` deny with reason | **Not available**: Kiro blocks only on exit 2 |
| Stop check | `agentStop` block with reason | **Not available**: `session.idle` can't continue a turn | `Stop` block with reason | **Not available** (same reason) |
| After compaction | No post-compaction event: recovery comes with the next tool result | `experimental.session.compacting` adds MEX's ids to the compaction prompt | `PostCompaction` (after only): next tool result | Nothing |
| Subagents | `subagentStart`; `agentId` on events | Child sessions (`parentID`) | Not documented | Not documented |
| Person lines | None from config hooks | None (a toast is possible later) | None documented | None documented |
| Rule-file format | AGENTS.md; path-scoped `.github/instructions/*.instructions.md` with `applyTo` | Root AGENTS.md | AGENTS.md / native globs (to check) | Always-on steering only |
| Policy switch MEX reads | `~/.copilot/config.json`: `disableAllHooks` | — | Claude's switches | — |

## Copilot CLI: the self-test gate

Copilot denies the tool call when a hook crashes, times out or can't start.
So `mex install` runs the exact command it would register before it writes
`~/.copilot/hooks.json`:

- native shim: `mex-hook --self-test` must report ok;
- Node fallback: `node` from `PATH` must start the fallback and answer `{}`.

When the test fails, MEX writes no Copilot hooks, removes any MEX Copilot
hooks from an earlier install (other hooks stay), and says so. `mex doctor`
reruns the test on every run and says how to switch the hooks off when it
fails. Doctor itself changes nothing. A daily retest without the person
running doctor needs a background schedule, which isn't built yet.

Each handler carries both `bash` and `powershell`, and `timeoutSec` of 10 (5
for `sessionEnd`). The demo moment, a recipe arriving with a tool result, goes
through `postToolUse` `modifiedResult`.

## OpenCode: the plugin

OpenCode has no command hooks. MEX writes one plugin that starts the same
`mex-hook` command the other agents run, as `mex-hook opencode <hook>`, with a
JSON payload built from the hook's arguments. The plugin never throws except
on a deliberate deny reply, which is how an OpenCode plugin blocks a tool.
Uninstall deletes the file while it still holds what MEX wrote.

## Devin

Devin's hooks take Claude Code's shape and Devin also runs `~/.claude` hooks,
so MEX doesn't register Devin separately: that would run MEX twice. The
`devin` profile parses and renders through the Claude profile, narrowed to
what Devin documents. Today a Devin payload has no signal that tells it apart
from Claude's, so it is answered as Claude Code, in a format Devin accepts.
The live test looks for a field to detect it by. `PostCompaction` is mapped
to `post_compact`.

## Kiro CLI

Kiro CLI hooks live in a custom agent's configuration, not in a user-level
file, and the default agent has none. MEX doesn't create or edit agents, so
Kiro is reached through rule files only, and `mex doctor` says so. The
profile is ready for an agent configuration that names
`mex-hook kiro <event>`. Its context goes to stdout as text, and "do nothing"
is no output. Kiro blocks a tool only when the hook exits 2. The shim never
exits non-zero, so the edit check and the Stop check aren't available on Kiro.

## Agents installed later

`mex doctor` lists Claude Code, Codex, Copilot CLI, OpenCode, Devin and Kiro
CLI when they are on `PATH`. An agent without MEX reads
"found · add MEX: `mex install`". Cursor, Antigravity and Gemini are added by
a later change.

## Left for the live test

- Record one smoke session per agent with `MEX_HOOK_RECORD`. Check that the
  hook is called, that text reaches the model, and that the agent keeps
  working when MEX fails (no binary, `MEX_OFF=1`, a broken payload).
- Copilot: whether `~/.copilot/hooks.json` is read as a user-level hook file,
  the `sessionId`, `agentId` and `transcriptPath` fields, `postToolUseFailure`'s
  payload, and that `modifiedResult` reaches the model.
- OpenCode: the global plugin folder name (`plugin` vs `plugins`), the
  `metadata.exit` field, and child-session ids.
- Devin: tool names, a detection signal, and whether the hooks also run from
  Devin's own settings.
- Kiro: `session_id`, the `tool_response` shape.
