<div align="center">

<img src="mascot/mex-mascot.svg" alt="mex mascot" width="80">

```
  ███╗   ███╗███████╗██╗  ██╗
  ████╗ ████║██╔════╝╚██╗██╔╝
  ██╔████╔██║█████╗   ╚███╔╝
  ██║╚██╔╝██║██╔══╝   ██╔██╗
  ██║ ╚═╝ ██║███████╗██╔╝ ██╗
  ╚═╝     ╚═╝╚══════╝╚═╝  ╚═╝
```

**mex**

[![CI](https://github.com/theDakshJaitly/mex/actions/workflows/ci.yml/badge.svg)](https://github.com/theDakshJaitly/mex/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![npm version](https://img.shields.io/npm/v/mex-agent.svg)](https://www.npmjs.com/package/mex-agent)

</div>

---

AI agents forget everything between sessions. mex gives them permanent, navigable project memory.

Every session starts cold:

- The agent has **no idea** what it built yesterday
- It forgets the conventions you agreed on
- It doesn't know what broke last week

Developers compensate by stuffing everything into CLAUDE.md — but that floods the context window, burns tokens, and degrades attention. Meanwhile, the project changes and nobody updates the docs. The agent's understanding drifts from reality.

mex is a structured markdown scaffold with a CLI that keeps it honest. The scaffold gives agents persistent project knowledge through navigable files — architecture, conventions, decisions, patterns. The CLI detects when those files drift from the actual codebase, and targets AI to fix only what's broken. The scaffold grows automatically — after every task, the agent updates project state and creates patterns from real work.

Works with any stack — JavaScript, Python, Go, Rust, and more.

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=theDakshJaitly/mex&type=Timeline)](https://star-history.com/#theDakshJaitly/mex&Timeline)

## Install

The npm package is named `mex-agent` (`mex` was taken on npm). The CLI command is `mex`.

```bash
npx mex-agent setup
```

That's it. The setup command creates the `.mex/` scaffold, asks which AI tool you use, pre-scans your codebase, and generates a targeted prompt to populate everything. Takes about 5 minutes.

At the end of setup, you'll be asked to install mex globally. If you accept:

```bash
mex check        # drift score
mex sync         # fix drift
```

If you skip global install, everything still works via npx:

```bash
npx mex-agent check        # drift score
npx mex-agent sync         # fix drift
```

You can install globally later at any time:

```bash
npm install -g mex-agent
```

## Drift Detection

Eight checkers validate your scaffold against the real codebase. Zero tokens, zero AI.

| Checker | What it catches |
|---------|----------------|
| **path** | Referenced file paths that don't exist on disk |
| **edges** | YAML frontmatter edge targets pointing to missing files |
| **index-sync** | `patterns/INDEX.md` out of sync with actual pattern files |
| **staleness** | Scaffold files not updated in 30+ days or 50+ commits |
| **command** | `npm run X` / `make X` referencing scripts that don't exist |
| **dependency** | Claimed dependencies missing from `package.json` |
| **cross-file** | Same dependency with different versions across files |
| **script-coverage** | `package.json` scripts not mentioned in any scaffold file |

Scoring: starts at 100. Deducts -10 per error, -3 per warning, -1 per info.

<!-- TODO: Add screenshot of `mex check` terminal output here -->
![mex check output](screenshots/mex-check.jpg) 

## CLI

All commands run from your **project root**. If you didn't install globally, replace `mex` with `npx mex-agent`.

### Commands

| Command | What it does |
|---------|-------------|
| `mex` | Open the interactive terminal dashboard |
| `mex tui` | Open the interactive terminal dashboard explicitly |
| `mex setup` | First-time setup — create `.mex/` scaffold and populate with AI |
| `mex setup --mode agent-memory` | Create templates for persistent-agent / homelab memory workspaces |
| `mex setup --dry-run` | Preview what setup would do without making changes |
| `mex check` | Run drift checkers, output drift score and categorized issues |
| `mex check --quiet` | One-liner: `mex: drift score 92/100 (1 warning)` |
| `mex check --json` | Full report as JSON for programmatic use |
| `mex check --fix` | Check and jump straight to sync if errors found |
| `mex sync` | Detect drift → choose mode → AI fixes → verify → repeat |
| `mex sync --dry-run` | Preview targeted prompts without executing |
| `mex sync --warnings` | Include warning-only files in sync |
| `mex init` | Pre-scan codebase, build structured brief for AI |
| `mex init --json` | Raw scanner brief as JSON |
| `mex log <message>` | Append a note, decision, risk, or todo to `.mex/events/decisions.jsonl` |
| `mex timeline` | View recent event log entries |
| `mex heartbeat` | Run lightweight persistent-agent health checks once |
| `mex doctor` | Friendly scaffold health summary |
| `mex watch` | Install post-commit hook (silent on perfect score) |
| `mex watch --interval` | Run heartbeat repeatedly in the foreground |
| `mex watch --uninstall` | Remove the hook |
| `mex completion <shell>` | Print bash, zsh, or fish completions |
| `mex commands` | List all commands and scripts with descriptions |


![mex sync output](screenshots/mex-sync.jpg)

Running check after drift is fixed by sync

![mex check after](screenshots/mex-check1.jpg)

## Before / After

Real output from testing mex on Agrow, an AI-powered agricultural voice helpline (Python/Flask, Twilio, multi-provider pipeline).

**Scaffold before setup:**
```markdown
## Current Project State
<!-- What is working. What is not yet built. Known issues.
     Update this section whenever significant work is completed. -->
```

**Scaffold after setup:**
```markdown
## Current Project State

**Working:**
- Voice call pipeline (Twilio → STT → LLM → TTS → response)
- Multi-provider STT (ElevenLabs, Deepgram) with configurable selection
- RAG system with Supabase pgvector for agricultural knowledge retrieval
- Streaming pipeline with barge-in support

**Not yet built:**
- Admin dashboard for call monitoring
- Automated test suite
- Multi-turn conversation memory across calls

**Known issues:**
- Sarvam AI STT bypass active — routing to ElevenLabs as fallback
```

**Patterns directory after setup:**
```
patterns/
├── add-api-client.md       # Steps, gotchas, verify checklist for new service clients
├── add-language-support.md  # How to extend the 8-language voice pipeline
├── debug-pipeline.md        # Where to look when a call fails at each stage
└── add-rag-documents.md     # How to ingest new agricultural knowledge
```

## Real World Results

Independently tested by a community member on **OpenClaw** across 10 structured scenarios on a homelab setup (Ubuntu 24.04, Kubernetes, Docker, Ansible, Terraform, networking, monitoring). 10/10 tests passed. Drift score: 100/100.

**Token usage before vs after mex:**

| Scenario | Without mex | With mex | Saved |
|----------|------------|---------|-------|
| "How does K8s work?" | ~3,300 tokens | ~1,450 tokens | 56% |
| "Open UFW port" | ~3,300 tokens | ~1,050 tokens | 68% |
| "Explain Docker" | ~3,300 tokens | ~1,100 tokens | 67% |
| Multi-context query | ~3,300 tokens | ~1,650 tokens | 50% |

**~60% average token reduction per session.**

Context is no longer all-or-nothing — loaded on demand, only what's relevant.

## How It Works

```
Session starts
    ↓
Agent loads CLAUDE.md (auto-loaded, lives at project root)
    ↓
CLAUDE.md says "Read .mex/ROUTER.md before doing anything"
    ↓
ROUTER.md routing table → loads relevant context file for this task
    ↓
context file → points to pattern file if task-specific guidance exists
    ↓
Agent executes with full project context, minimal token cost
    ↓
After task: agent runs GROW
    ↓
New patterns, updated project state — scaffold grows from real work
```

CLAUDE.md stays small. The agent navigates to only what it needs. After meaningful work, it runs GROW: Ground what changed, Record current truth in the scaffold, Orient by creating or refining a pattern, and Write `last_updated` plus `mex log` entries when rationale matters.

## Agent Memory Mode

`mex setup --mode agent-memory` creates a scaffold for persistent agents whose "project" is an operational environment rather than a code repo. It adds a `HEARTBEAT.md` contract and templates that frame mex as structured, task-routed memory:

- `ROUTER.md` tracks current operational state and routes the agent to the right memory files.
- `context/` stores architecture, stack, conventions, setup, and decisions.
- `patterns/` stores recurring runbooks.
- `.mex/events/decisions.jsonl` stores append-only notes and rationale via `mex log`.

`mex heartbeat` is intentionally lighter than `mex check`: it reads `last_updated` frontmatter and memory cleanup metadata, prints `HEARTBEAT_OK` when clean, and reports only when the agent needs to review stale context or memory files. Use `mex watch --interval` to run heartbeat repeatedly in a persistent-agent workspace.

## Configuration

Optional settings live in `.mex/config.json`. Missing values fall back to defaults.

```json
{
  "staleness": {
    "warnDays": 30,
    "errorDays": 90,
    "warnCommits": 50,
    "errorCommits": 200
  },
  "heartbeat": {
    "staleDays": 7,
    "memoryCleanupDays": 7,
    "dailyMemoryRetentionDays": 14
  },
  "watch": {
    "intervalMinutes": 30
  }
}
```

## File Structure

```
your-project/
├── CLAUDE.md              ← auto-loaded by tool, points to .mex/
├── .mex/
│   ├── ROUTER.md          ← routing table, session bootstrap
│   ├── AGENTS.md          ← always-loaded anchor (~150 tokens)
│   ├── HEARTBEAT.md       ← agent-memory heartbeat contract (agent-memory mode)
│   ├── events/
│   │   └── decisions.jsonl   # append-only notes/decisions from mex log
│   ├── context/
│   │   ├── architecture.md   # how components connect
│   │   ├── stack.md           # technology choices and reasoning
│   │   ├── conventions.md     # naming, structure, patterns
│   │   ├── decisions.md       # append-only decision log
│   │   └── setup.md           # how to run locally
│   └── patterns/
│       ├── INDEX.md           # pattern registry
│       └── *.md               # task-specific guides with gotchas + verify checklists
└── src/
```

## Multi-Tool Compatibility

| Tool | Config file |
|------|------------|
| Claude Code | `CLAUDE.md` |
| Cursor | `.cursorrules` |
| Windsurf | `.windsurfrules` |
| GitHub Copilot | `.github/copilot-instructions.md` |
| OpenCode | `.opencode/opencode.json` |
| Codex (OpenAI) | `AGENTS.md` |

Most config files embed the same instructions directly. OpenCode is the exception — `.opencode/opencode.json` references `.mex/AGENTS.md` instead of embedding content. `mex setup` asks which tool you use and creates the appropriate config.

Neovim users have their own guide: see [docs/vim-neovim.md](docs/vim-neovim.md) for Claude Code, Avante.nvim, Copilot.vim, and generic-plugin setups.

## Contributing

Contributions welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for setup and guidelines.

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for release history.

## License

[MIT](LICENSE)
