<div align="center">

<img src="mascot/mex-mascot.svg" alt="mex mascot" width="80">

<br>

<img src="mascot/mex-ascii.svg" alt="MEX ASCII logo" width="520">

**A living wiki for your codebase, maintained by your AI coding agents.**

**English** | [简体中文](README.zh-CN.md) | [Español](README.es.md) | [Português (Brasil)](README.pt-BR.md)

[![npm version](https://img.shields.io/npm/v/mex-agent.svg)](https://www.npmjs.com/package/mex-agent)
[![npm downloads](https://img.shields.io/npm/dm/mex-agent.svg)](https://www.npmjs.com/package/mex-agent)
[![GitHub stars](https://img.shields.io/badge/stars-1.2K%2B-111111)](https://github.com/mex-memory/mex/stargazers)
[![Website](https://img.shields.io/badge/website-mexmemory.com-4f7cff)](https://mexmemory.com)
[![Discord](https://img.shields.io/badge/Discord-Join-5865F2?logo=discord&logoColor=white)](https://discord.gg/FEdNsQ4Qt4)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![CI](https://github.com/mex-memory/mex/actions/workflows/ci.yml/badge.svg)](https://github.com/mex-memory/mex/actions/workflows/ci.yml)
[![Node.js >=22.5](https://img.shields.io/badge/node-%3E%3D22.5-339933)](package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178c6)](package.json)
[![Agent memory](https://img.shields.io/badge/agent%20memory-compatible-6f8cff)](#agent-memory-mode)
[![MCP](https://img.shields.io/badge/MCP-compatible-6f8cff)](#mcp-server)

</div>

---

mex maps your code, turns what agents learn into structured Markdown, and keeps that knowledge connected to the implementation it describes.

Every coding session starts with relevant architectural context instead of another full-repository scan.

> **New in v0.7.2:** source-backed one-call graph retrieval with compiler-resolved TypeScript flows, deterministic evidence, and hard output budgets.

💬 **Join the mex community on Discord** — discuss ideas, get help, share feedback, and contribute to the project.

[Join the Discord →](https://discord.gg/FEdNsQ4Qt4)

```bash
npx mex-agent setup
```

<p align="center">
  <img src="screenshots/mex-DashNew.jpg" alt="mex operational memory dashboard" width="640">
</p>

## Your codebase knows more than its documentation

Architecture, conventions, edge cases, and past decisions are scattered across source code, pull requests, chat histories, and individual contributors.

AI coding agents rediscover that knowledge every session. A giant instruction file helps at first, but eventually floods the context window, becomes stale, and drifts away from the implementation.

mex creates a living, repo-local wiki that grows as agents work:

- agents document what they learn in readable Markdown
- a deterministic code graph connects that knowledge to exact symbols
- task-aware routing loads only the context needed for the current job
- drift checks identify knowledge affected by code changes
- completed work adds decisions, patterns, and current project state back into the wiki

The code remains the source of truth. The wiki becomes its maintained explanation.

| Ordinary project documentation | The mex living wiki |
|---|---|
| Written once and gradually forgotten | Grows from real coding work |
| Disconnected from the implementation | Claims can point to exact code symbols |
| Loaded as one giant instruction file | Context is routed by task |
| Refactors silently invalidate docs | Changed, moved, and missing symbols are detected |
| Every agent rediscovers the architecture | Agents inherit previous discoveries and decisions |
| Knowledge disappears between sessions | Decisions and reusable patterns persist in the repository |

## How it works

### 1. Map the codebase

mex builds a deterministic local code graph using Tree-sitter and SQLite. It indexes symbols and relationships across TypeScript, TSX, JavaScript, JSX, Python, and Rust, including framework-aware Express route-to-handler relationships.

```bash
mex graph
```

### 2. Build the wiki

During setup, your coding agent uses the graph to understand the project and populate a structured Markdown wiki:

```text
.mex/
├── AGENTS.md
├── ROUTER.md
├── context/
│   ├── architecture.md
│   ├── stack.md
│   ├── setup.md
│   ├── decisions.md
│   └── conventions.md
├── patterns/
│   ├── INDEX.md
│   └── ...
└── events/
    └── decisions.jsonl
```

These remain ordinary Markdown files: readable, reviewable, version-controlled, and editable by humans or agents.

### 3. Route the right context

Agents begin with a small anchor file instead of loading the entire wiki. The anchor points to `ROUTER.md`, which selects the architecture notes, decisions, conventions, and task patterns relevant to the current job.

```text
Agent task
    ↓
Small always-loaded anchor
    ↓
ROUTER.md
    ↓
Relevant wiki pages
    ↓
Compact code-graph neighborhood
    ↓
Targeted source expansion
```

![mex context routing flow](docs/diagrams/context-routing.svg)

Editable source: [docs/diagrams/context-routing.excalidraw](docs/diagrams/context-routing.excalidraw)

### 4. Keep it current

After meaningful work, the agent updates project state, records decisions, and captures reusable patterns. mex checks that the wiki still agrees with the repository:

```bash
mex check
mex sync
```

`mex check` validates paths, commands, dependencies, links, indexes, staleness, tool configuration, and grounded code symbols without spending AI tokens. When repairs are needed, `mex sync` gives the agent targeted context instead of asking it to rediscover the whole project.

![mex drift detection and sync loop](docs/diagrams/drift-sync.svg)

Editable source: [docs/diagrams/drift-sync.excalidraw](docs/diagrams/drift-sync.excalidraw)

## Grounded in the code

Wiki pages can connect important claims to exact graph nodes. A behavioral claim can be grounded through frontmatter:

```yaml
---
grounds_to:
  - node: "function:a3f8...c21"
    fingerprint: "mh:64:9f2a..."
---
```

Load-bearing symbol references can also be navigable inline:

```markdown
Authentication is enforced by
[`requireSession()`](mex://function:a3f8...c21).
```

When that function changes, moves, or disappears, mex can identify the affected knowledge. Confident renames and moves are durably rebound during sync; ambiguous changes are surfaced for the agent to resolve.

This lets agents read broadly to understand a behavior while grounding only the few symbols that actually support what they write.

## Compact retrieval for coding agents

The graph is also a compact agent-retrieval layer:

```bash
mex graph scope "trace the authentication flow"
```

Instead of returning a repository-sized source dump, mex prioritizes the declarations and real execution flows most likely to answer the task under a hard estimated-token budget. The default response is source-backed and uses deterministic `meta`, `source`, `flow`, and `summary` JSONL records.

Returned source is already read. When the summary is `ok`, an agent can answer directly even if lower-priority optional context was truncated. Exact expansion remains available when a declaration is missing or the summary recommends a follow-up:

```bash
mex graph get <node-id>
```

Structural queries and impact analysis are available directly:

```bash
mex graph query where-defined authenticate
mex graph query who-calls requireSession
mex graph query what-calls createServer
mex impact requireSession
```

Agent-facing graph commands use deterministic JSONL envelopes so tools can reliably distinguish metadata, results, and summaries.

## Results

A 24-session pilot compared the 0.7.2 candidate with files-only search across 12 Hono and MEX tasks:

| Measurement | Result |
|---|---:|
| Blind-correct answers | **7/12 candidate vs 6/12 files** |
| New-token change | **-54.5%** |
| Processed-token change | **-72.5%** |
| Estimated-cost change | **-56.6%** |
| Mean-latency change | **-22.9%** |
| Required source spans returned | **22/23 (95.7%)** |
| Required Hono flows returned | **6/6 (100%)** |

Each task ran once per arm with Claude Sonnet. These are descriptive small-N results against a files-only baseline, not a released-`main` comparison or a universal token-savings claim. See the [benchmark report](evaluate/RESULTS.md) for methodology and limitations.

See the [benchmark results](evaluate/RESULTS.md) and [evaluation harness](evaluate/README.md) for the methodology, raw results, caveats, and reproduction commands.

## Quick start

mex requires Node.js 22.5 or newer. The npm package is named `mex-agent` because `mex` was already taken; the CLI command is still `mex`.

```bash
npx mex-agent setup
```

Setup inspects the repository, builds the local code graph, creates the Markdown wiki, asks your coding agent to populate it from graph evidence, installs the right project anchor, and validates the result.

After setup:

```bash
mex check                    # Check wiki health and code grounding
mex sync                     # Repair drift with targeted agent prompts
mex graph scope "<task>"     # Retrieve compact task context
```

If you skipped global installation, use `npx mex-agent` in place of `mex`. Install globally at any time with:

```bash
npm install -g mex-agent
```

### Windows

The recommended `npx mex-agent setup` flow runs in Command Prompt, PowerShell, or WSL and does not require bash.

If you use the legacy `setup.sh` flow, run install, build, and CLI commands in the same environment. Do not build in WSL and then run the CLI from a native Windows terminal. See [issue #10](https://github.com/mex-memory/mex/issues/10) for context.

## Core commands

All commands run from the project root. Replace `mex` with `npx mex-agent` if it is not installed globally.

| Command | What it does |
|---|---|
| `mex` / `mex tui` | Open the interactive terminal dashboard |
| `mex setup` | Create and populate the living wiki |
| `mex check` | Check wiki health and calculate a drift score |
| `mex sync` | Repair stale or inconsistent knowledge |
| `mex graph` | Build or refresh the local code graph |
| `mex graph scope <task>` | Retrieve compact, task-relevant context |
| `mex graph get <node-id...>` | Expand exact symbols from a retrieval result |
| `mex graph query <relation> <symbol>` | Query structural code relationships |
| `mex graph ground` | Connect an existing pre-0.7 wiki to the graph |
| `mex impact <symbol\|file>` | Find code and wiki content affected by a change |
| `mex log <message>` | Record a decision, note, risk, or todo |
| `mex timeline` | Read recent project events |
| `mex heartbeat` | Run persistent-agent health checks |
| `mex completion <shell>` | Print shell completions |
| `mex commands` | List every command and script |

## Existing mex projects

Projects created before mex 0.7 can add graph grounding without regenerating or rewriting their existing documentation:

```bash
mex graph
mex graph ground
```

The migration agent preserves existing prose while adding tight `grounds_to` entries and navigable `mex://` references. It is safe to rerun.

Existing installations remain compatible. If no graph exists, the filesystem and lexical checkers continue to run. If SQLite or an individual grammar cannot load, graph checks are skipped with a warning while the rest of the CLI remains available.

See [Code graph support](docs/code-graph-support.md) for the tested language and relationship matrix, graceful-degradation behavior, and current limitations.

## Supported tools

`mex setup` installs the appropriate project anchor for your coding agent:

| Tool | Project anchor |
|---|---|
| Claude Code | `CLAUDE.md` |
| Codex | `AGENTS.md` |
| Cursor | `.cursorrules` |
| Windsurf | `.windsurfrules` |
| GitHub Copilot | `.github/copilot-instructions.md` |
| OpenCode | `.opencode/opencode.json` |

Neovim users can follow [the Neovim integration guide](docs/vim-neovim.md) for Claude Code, Avante.nvim, Copilot.vim, and generic plugin setups.

## MCP server

`packages/mex-mcp` exposes the existing wiki and event-log functionality as Model Context Protocol tools while importing the same implementation as the CLI.

The MCP package is not published yet. For local development, build it with:

```bash
npm run build --workspace mex-mcp
```

The primary v0.7.2 release remains the `mex-agent` CLI.

## Agent memory mode

The primary mex experience is the living codebase wiki. The same routing and maintenance model can also support persistent agents whose project is an operational environment:

```bash
mex setup --mode agent-memory
```

Agent-memory mode adds a `HEARTBEAT.md` contract and cleanup conventions for homelabs, infrastructure workspaces, and long-running operational agents.

In an independent community test on OpenClaw, mex passed 10/10 structured homelab scenarios and reduced loaded context by approximately 60% on average. These results describe agent-memory mode and are separate from the code-graph benchmark above.

## Philosophy

- **Markdown is the durable interface.** Humans and agents can both read and edit it.
- **Code is the source of truth.** Important claims stay connected to implementation.
- **Context should be routed, not dumped.** Agents load what the task requires.
- **Knowledge should grow from real work.** Useful patterns emerge from completed tasks.
- **Maintenance should be continuous.** Documentation evolves with the repository.
- **Retrieval should be deterministic.** Mechanical work should not consume AI tokens.

## Telemetry

mex collects anonymous, opt-out usage data—command name, version, and OS—to understand how the tool is used. It never collects paths, arguments, file contents, IP addresses, or personal data.

Audit the exact payload with `mex telemetry inspect`. Opt out with `DO_NOT_TRACK=1`, `MEX_TELEMETRY=0`, or `mex config set telemetry off`. See [TELEMETRY.md](TELEMETRY.md) for full details.

## Ecosystem

mex is provider-neutral. Integration guides, sponsored examples, and community recipes should be useful on their own, clearly labeled, and live in documentation rather than silently changing the default experience.

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and guidelines.

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for release history.

## License

[MIT](LICENSE)
