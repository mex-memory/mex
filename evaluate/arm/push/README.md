# Push-delivery layer (prototype)

The files a `push` arm's scaffold adds on top of the full MEX scaffold, kept here for reference.
The scaffold commit in the subject clone carries the same files.

- `.claude/hooks/mex-push.mjs` delivers knowledge through Claude Code hooks:
  - `index`: the runner builds `.mex/local/push-index.json` before the session.
  - `prompt`: entries matching the task are shown at the start.
  - `read`: entries linked to a source file are shown when the agent opens it.
  - `edit`: entries describing code are shown when the agent changes it.
  - `stop`: entries whose code drifted are re-recorded with `mex wiki reground --apply`. If the agent never saw them, the hook first blocks once and asks it to review them.
- `.claude/settings.json` registers the hooks.
- `CLAUDE.md` replaces the MEX block with four short lines.
- `.mex/AGENTS.md` and `.mex/ROUTER.md` (edited in the scaffold commit only) drop the instruction to write fingerprints by hand.

Every hook appends what it delivered to `MEX_PUSH_LOG`. The runner points that at `artifacts/<runId>.push.jsonl` and summarises it in the row's `push` field.
