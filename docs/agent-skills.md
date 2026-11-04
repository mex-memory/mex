# Agent skills by tool

MEX ships three official skills: `mex-inbox`, `mex-relay`, and `mex-statechart`.
They have the same commands and approval rules in every tool, because every tool
installs the same packaged files. Cursor, GitHub Copilot, OpenCode, and Windsurf
need a MEX release newer than 0.8.5.

| Tool | `--tool` | Skills directory | Instruction file | How you invoke a skill |
| --- | --- | --- | --- | --- |
| Claude Code | `claude` | `.claude/skills/` | `CLAUDE.md` | `/mex-inbox` |
| Codex | `codex` | `.agents/skills/` | `AGENTS.md` | `$mex-inbox` |
| Cursor | `cursor` | `.agents/skills/` | `.cursorrules` | `/mex-inbox` |
| GitHub Copilot | `copilot` | `.agents/skills/` | `.github/copilot-instructions.md` | `/mex-inbox` |
| OpenCode | `opencode` | `.agents/skills/` | `AGENTS.md` | Ask by name: "use the mex-inbox skill" |
| Windsurf | `windsurf` | `.agents/skills/` | `.windsurfrules` | `/mex-inbox` |

In every tool, a clear request such as "hand this work to the team" can also
activate the matching skill. Activating a skill never approves a canonical write.

`.agents/skills/` holds one copy, shared by every tool except Claude Code. Selecting
several of them installs it once, and `mex skills sync` keeps it up to date.

## Install

Every tool needs the `mex` CLI and a MEX project. `mex setup` installs the skills
for the tools you select. To add one tool to an existing project, preview the
sync, apply it, then start a new agent session:

### Cursor

```bash
mex skills sync --dry-run --tool cursor
```

```bash
mex skills sync --tool cursor
```

### GitHub Copilot

```bash
mex skills sync --dry-run --tool copilot
```

```bash
mex skills sync --tool copilot
```

Project skills work in Copilot CLI and in agent mode in VS Code. Other Copilot
surfaces vary by version.

### OpenCode

```bash
mex skills sync --dry-run --tool opencode
```

```bash
mex skills sync --tool opencode
```

OpenCode shares `AGENTS.md` with Codex, so the managed block there writes skills
as `$mex-inbox`. OpenCode has no `$` syntax; it finds the skill by name.

### Windsurf

```bash
mex skills sync --dry-run --tool windsurf
```

```bash
mex skills sync --tool windsurf
```

Windsurf's documentation now redirects to Devin Desktop, which reads
`.agents/skills/` and `.windsurfrules`. If an older Windsurf build does not list
the skills, copy `.agents/skills/mex-*` to `.windsurf/skills/` by hand and report
the version in an issue. MEX does not manage that location.

### After installing

Commit the instruction file and `.agents/skills/mex-*` if teammates should receive
them. MEX never commits or pushes on its own during a sync.

## Smoke checklist

Run these in a disposable MEX project after `mex skills sync --tool <tool>`. The
first check applies to every tool:

- [ ] `.agents/skills/` contains `mex-inbox`, `mex-relay`, and `mex-statechart`,
      and the instruction file contains `<!-- mex-agent:skills:start -->`.
- [ ] A second `mex skills sync --tool <tool>` reports no changes.

Then start a new session in the tool and check the following.

### Cursor

- [ ] Typing `/` in Agent chat lists `mex-inbox`, `mex-relay`, and `mex-statechart`.
- [ ] `/mex-inbox capture that we use tabs` previews a local draft and reports that
      it stays in this checkout.
- [ ] "What does `.cursorrules` tell you to read first?" names `.mex/AGENTS.md`.

### GitHub Copilot

- [ ] Copilot CLI: `/skills list` shows all three skills. VS Code: typing `/` in
      agent mode lists them.
- [ ] `Use the /mex-relay skill to prepare a handoff` saves a local draft and states
      that nothing was delivered.
- [ ] The session's references include `.github/copilot-instructions.md`.

### OpenCode

- [ ] "Which skills can you load?" lists all three skills.
- [ ] "Use the mex-inbox skill to capture that we use tabs" loads it through the
      skill tool and previews a local draft.
- [ ] "What does `AGENTS.md` tell you to read first?" names `.mex/AGENTS.md`.

### Windsurf

- [ ] `/mex-inbox` is offered in Cascade.
- [ ] `/mex-relay prepare a handoff` saves a local draft and states that nothing was
      delivered.
- [ ] "What does `.windsurfrules` tell you to read first?" names `.mex/AGENTS.md`.

## What is still Claude Code or Codex only

- **Claude Code plugin:** `.claude-plugin/marketplace.json` lists Inbox and Relay for
  Claude Code only.
- **Codex display metadata:** each skill's `agents/openai.yaml` is installed
  everywhere, and only Codex reads it.
- **Inline statechart images:** only Claude Code's desktop app is verified to show
  the rendered PNG inline, and only Codex CLI is verified to render fenced Mermaid.
  Other tools get the text view and the file paths.
- **Setup steps that run `mex` commands:** a single-session population run and the
  finalize repair turn still use only Claude Code or Codex. The other tools can
  still populate subsystem units or use `mex setup next`.

## Sources

Checked on 2026-11-04. Tool behavior can change between versions, so the smoke
checklist is the final word.

- [Cursor: Agent Skills](https://cursor.com/docs/context/skills)
- [GitHub Copilot: About agent skills](https://docs.github.com/en/copilot/concepts/agents/about-agent-skills)
- [VS Code: Agent skills](https://code.visualstudio.com/docs/copilot/customization/agent-skills)
- [OpenCode: Skills](https://opencode.ai/docs/skills/)
- [Devin Desktop (formerly Windsurf): Skills](https://docs.devin.ai/desktop/cascade/skills)
