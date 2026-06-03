<div align="center">

<img src="mascot/mex-mascot.svg" alt="mex mascot" width="80">

<br>

<img src="mascot/mex-ascii.svg" alt="MEX ASCII logo" width="520">

**Persistent project memory for AI coding agents.**

[![npm version](https://img.shields.io/npm/v/mex-agent.svg)](https://www.npmjs.com/package/mex-agent)
[![npm downloads](https://img.shields.io/npm/dm/mex-agent.svg)](https://www.npmjs.com/package/mex-agent)
[![GitHub stars](https://img.shields.io/badge/stars-700%2B-111111)](https://github.com/theDakshJaitly/mex/stargazers)
[![Website](https://img.shields.io/badge/website-launchx.page%2Fmex-4f7cff)](https://launchx.page/mex)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![CI](https://github.com/theDakshJaitly/mex/actions/workflows/ci.yml/badge.svg)](https://github.com/theDakshJaitly/mex/actions/workflows/ci.yml)
[![Node.js >=20](https://img.shields.io/badge/node-%3E%3D20-339933)](package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178c6)](package.json)
[![Agent memory](https://img.shields.io/badge/agent%20memory-compatible-6f8cff)](README.md)

</div>

---

AI agents forget everything between sessions. mex gives them permanent, navigable project memory so every session starts with the right context instead of a cold prompt dump.

```bash
npx mex-agent setup
```

<p align="center">
  <img src="screenshots/mex-DashNew.jpg" alt="mex operational memory dashboard" width="640">
</p>

## Why mex?

Most agent memory setups become one giant instruction file. That works for a while, then it floods the context window, burns tokens, and drifts away from the real codebase.

| Without mex | With mex |
|-------------|----------|
| Giant `CLAUDE.md` / rules files | Small anchor file plus routed context |
| Agents forget decisions and conventions | Decisions, patterns, and project state persist |
| Docs silently drift from code | `mex check` catches stale or broken scaffold claims |
| Every session starts cold | Agents load only the files relevant to the task |
| Repeated work stays tribal | New patterns grow from real tasks |

## What It Does

mex creates a structured markdown scaffold for agent memory:

- `AGENTS.md` / `CLAUDE.md` — tiny tool-loaded anchor
- `ROUTER.md` — routing table for task-specific context
- `context/` — architecture, stack, setup, decisions, conventions
- `patterns/` — reusable task guides with gotchas and verification steps
- `.mex/events/decisions.jsonl` — append-only notes through `mex log`

The CLI keeps that scaffold honest. It checks paths, commands, dependencies, pattern indexes, staleness, and script coverage without spending AI tokens. When drift appears, `mex sync` builds targeted prompts so the agent fixes only the stale pieces.

## Quick Start

The npm package is named `mex-agent` because `mex` was already taken. The CLI command is still `mex`.

```bash
npx mex-agent setup
```

Setup creates the `.mex/` scaffold, asks which AI tool you use, pre-scans your codebase, and generates a targeted prompt to populate the memory files. It takes about five minutes.

At the end of setup, you can install mex globally:

```bash
mex check        # drift score
mex sync         # fix drift
```

If you skip global install, use npx:

```bash
npx mex-agent check
npx mex-agent sync
```

Install globally later at any time:

```bash
npm install -g mex-agent
```

## How It Works

![mex context routing flow](docs/diagrams/context-routing.svg)

The agent starts with a tiny auto-loaded file. That file points to `ROUTER.md`, and the router loads only the context needed for the current task. After meaningful work, the GROW step updates project state, decisions, and task patterns so the scaffold becomes more useful over time.

Editable source: [docs/diagrams/context-routing.excalidraw](docs/diagrams/context-routing.excalidraw)

## Drift Detection

Ten checkers validate your scaffold against the real codebase. Zero tokens, zero AI.

| Checker | What it catches |
|---------|----------------|
| **path** | Referenced file paths that do not exist on disk |
| **edges** | YAML frontmatter edge targets pointing to missing files |
| **index-sync** | `patterns/INDEX.md` out of sync with actual pattern files |
| **staleness** | Scaffold files not updated in 30+ days or 50+ commits |
| **command** | `npm run X` / `make X` references scripts that do not exist |
| **dependency** | Claimed dependencies missing from `package.json` |
| **cross-file** | Same dependency with different versions across files |
| **script-coverage** | `package.json` scripts not mentioned in any scaffold file |
| **tool-config-sync** | Installed AI tool config files (e.g. `CLAUDE.md`, `.cursorrules`) out of sync with each other |
| **todo-fixme** | Unresolved `TODO` / `FIXME` markers left in scaffold markdown |

Scoring starts at 100. mex deducts 10 per error, 3 per warning, and 1 per info.

![mex drift detection and sync loop](docs/diagrams/drift-sync.svg)

Editable source: [docs/diagrams/drift-sync.excalidraw](docs/diagrams/drift-sync.excalidraw)

## Commands

All commands run from your project root. If you did not install globally, replace `mex` with `npx mex-agent`.

| Command | What it does |
|---------|-------------|
| `mex` | Open the interactive terminal dashboard |
| `mex tui` | Open the interactive terminal dashboard explicitly |
| `mex setup` | First-time setup: create `.mex/` scaffold and populate with AI |
| `mex setup --mode agent-memory` | Create templates for persistent-agent / homelab memory workspaces |
| `mex setup --dry-run` | Preview what setup would do without making changes |
| `mex check` | Run drift checkers and output a scored report |
| `mex check --quiet` | One-liner: `mex: drift score 92/100 (1 warning)` |
| `mex check --json` | Full report as JSON |
| `mex check --fix` | Check and jump straight to sync if errors are found |
| `mex sync` | Detect drift, choose mode, let AI fix, verify, repeat |
| `mex sync --dry-run` | Preview targeted prompts without executing |
| `mex sync --warnings` | Include warning-only files in sync |
| `mex init` | Pre-scan codebase and build a structured brief for AI |
| `mex init --json` | Raw scanner brief as JSON |
| `mex log <message>` | Append a note, decision, risk, or todo |
| `mex timeline` | View recent event log entries |
| `mex heartbeat` | Run lightweight persistent-agent health checks once |
| `mex doctor` | Friendly scaffold health summary |
| `mex watch` | Install post-commit hook |
| `mex watch --interval` | Run heartbeat repeatedly in the foreground |
| `mex watch --uninstall` | Remove the hook |
| `mex completion <shell>` | Print shell completions |
| `mex commands` | List commands and scripts with descriptions |

## Supported Tools

`mex setup` asks which tool you use and creates the right config file.

| Tool | Config file |
|------|-------------|
| Claude Code | `CLAUDE.md` |
| Cursor | `.cursorrules` |
| Windsurf | `.windsurfrules` |
| GitHub Copilot | `.github/copilot-instructions.md` |
| OpenCode | `.opencode/opencode.json` |
| Codex | `AGENTS.md` |

Neovim users can use [docs/vim-neovim.md](docs/vim-neovim.md) for Claude Code, Avante.nvim, Copilot.vim, and generic plugin setups.

## Before / After

Real output from testing mex on Agrow, an AI-powered agricultural voice helpline.

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
- Voice call pipeline (Twilio -> STT -> LLM -> TTS -> response)
- Multi-provider STT with configurable selection
- RAG system with Supabase pgvector
- Streaming pipeline with barge-in support

**Not yet built:**
- Admin dashboard for call monitoring
- Automated test suite
- Multi-turn conversation memory across calls

**Known issues:**
- Sarvam AI STT bypass active; ElevenLabs fallback in use
```

**Patterns directory after setup:**

```text
patterns/
├── add-api-client.md
├── add-language-support.md
├── debug-pipeline.md
└── add-rag-documents.md
```

## Real World Results

Independently tested by a community member on **OpenClaw** across 10 structured homelab scenarios covering Ubuntu 24.04, Kubernetes, Docker, Ansible, Terraform, networking, and monitoring. 10/10 tests passed. Drift score: 100/100.

| Scenario | Without mex | With mex | Saved |
|----------|-------------|----------|-------|
| "How does K8s work?" | ~3,300 tokens | ~1,450 tokens | 56% |
| "Open UFW port" | ~3,300 tokens | ~1,050 tokens | 68% |
| "Explain Docker" | ~3,300 tokens | ~1,100 tokens | 67% |
| Multi-context query | ~3,300 tokens | ~1,650 tokens | 50% |

**~60% average token reduction per session.**

## Agent Memory Mode

`mex setup --mode agent-memory` creates a scaffold for persistent agents whose "project" is an operational environment rather than a code repo. It adds a `HEARTBEAT.md` contract and templates that frame mex as structured, task-routed memory:

- `ROUTER.md` tracks current operational state and routes the agent to the right memory files.
- `context/` stores architecture, stack, conventions, setup, and decisions.
- `patterns/` stores recurring runbooks.
- `.mex/events/decisions.jsonl` stores append-only notes and rationale through `mex log`.

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

## Ecosystem

mex is provider-neutral. Integration guides, sponsored examples, and community recipes should be useful on their own, clearly labeled, and live in docs rather than silently changing the default experience.

## Contributing

Contributions welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup and guidelines.

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for release history.

## License

[MIT](LICENSE)
