<div align="center">

<h1 id="mex">
  <img src="docs/diagrams/readme/banner.svg" alt="MEX" width="1200">
</h1>

**Shared project memory for engineers and their coding agents.**

MEX keeps your team's architecture, decisions, requirements, and handoffs alongside the code. Engineers and their agents can build on shared context, review proposed changes, and carry work between sessions and teammates—with Git as the sharing layer.

**English** | [简体中文](README.zh-CN.md) | [Español](README.es.md) | [Português (Brasil)](README.pt-BR.md)

[![npm version](https://img.shields.io/npm/v/mex-agent.svg)](https://www.npmjs.com/package/mex-agent)
[![npm downloads](https://img.shields.io/npm/dm/mex-agent.svg)](https://www.npmjs.com/package/mex-agent)
[![GitHub stars](https://img.shields.io/github/stars/mex-memory/mex?style=flat)](https://github.com/mex-memory/mex/stargazers)
[![Website](https://img.shields.io/badge/website-mexmemory.com-4f7cff)](https://mexmemory.com)
[![Discord](https://img.shields.io/badge/Discord-Join-5865F2?logo=discord&logoColor=white)](https://discord.gg/FEdNsQ4Qt4)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/mex-memory/mex/blob/v0.8.0/LICENSE)
[![CI](https://github.com/mex-memory/mex/actions/workflows/ci.yml/badge.svg)](https://github.com/mex-memory/mex/actions/workflows/ci.yml)
[![Node.js >=22.5](https://img.shields.io/badge/Node.js-%3E%3D22.5-339933?logo=node.js&logoColor=white)](https://github.com/mex-memory/mex/blob/v0.8.0/package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178c6)](https://github.com/mex-memory/mex/blob/v0.8.0/package.json)
[![Agent memory](https://img.shields.io/badge/agent%20memory-compatible-6f8cff)](#agent-memory-mode)
[![MCP: source only](https://img.shields.io/badge/MCP-source%20only-6f8cff)](#mcp-server)

[Team memory](#what-your-team-remembers) · [A teammate-handoff example](#from-one-engineer-to-the-next) · [Project Hub](#project-hub) · [Quick start](#quick-start) · [How it works](#how-mex-works) · [Command map](#command-map)

</div>

---

One engineer knows why a constraint exists. Another has the debugging history. A coding agent found an important edge case in a session nobody else will read. The next teammate has to piece it together again.

**What one engineer and their agent learn should become context the next teammate can use.** MEX gives that knowledge a durable home in the repository: readable Markdown, code-linked explanations, reviewed Spec proposals, and structured handoffs. People explore and review it in a local Hub; agents retrieve and help maintain it through project instructions and the CLI.

> [!IMPORTANT]
> **[MEX 0.8](https://github.com/mex-memory/mex/releases/tag/v0.8.0) expands agent memory into team memory:** a local Project Hub, structured Wiki and team workflows, governed Specs, Members, Workstreams, Relays, Activity, and official Claude Code/Codex skills—all connected to the existing Code Graph, grounding, and drift system.

💬 **Join the MEX community on Discord** — discuss ideas, get help, share feedback, and show what you're building.

[Join the Discord →](https://discord.gg/FEdNsQ4Qt4)

## What your team remembers

| What the team needs to retain | Where it lives in MEX |
| --- | --- |
| How the system works, and why | Wiki architecture, decisions, conventions, and patterns, with Code Graph grounding |
| What the product must do | Specs, requirements, constraints, and acceptance criteria; Inbox proposals for governed changes |
| Where another engineer should continue | Relays with progress, decisions, blockers, evidence, and next actions |
| The context around an area of work | Workstreams and their recorded state |
| Who is involved, and what MEX recorded | Members and Activity history |

![An engineer and their agent contribute shared team memory through Git. A teammate and their agent reuse it in a separate checkout, with their own local indexes.](docs/diagrams/readme/git-sharing.svg)

Canonical memory travels with ordinary Git commit, push, and pull. Each teammate keeps their own local indexes, drafts, identity selection, and Hub. No hosted MEX service, Docker, proxy, MEX account, or MEX-owned model key is required.

Working solo? The next person using that memory can be you in a new session.

## From one engineer to the next

An example: Alex changes webhook retry handling, and Sam will continue the work. Both are active MEX Members in a repository their team has already set up.

1. **Start with the team's context.** Alex asks Codex to inspect the existing architecture, relevant decisions, and code evidence before making the change and running tests.
2. **Keep the useful discoveries.** With Alex's direction, Codex updates the relevant Wiki explanation and code references. If the work changes a durable product requirement, it prepares a separate Inbox proposal for explicit approval.
3. **Prepare and publish the handoff.** Alex asks `$mex-relay` to draft a Relay for Sam: what changed, which tests ran, what remains, and where to look next. She reviews the draft and publication preview in Hub, explicitly publishes it, then reviews, commits, and pushes the code and canonical MEX files through Git.
4. **Continue from shared context.** Sam pulls the relevant branch, updates his local indexes as needed, and opens Hub. He reviews and takes the Relay, then asks his coding agent to read its context and continue. His acknowledgement is another canonical change to commit and push.

![An engineer prepares and publishes a Relay, shares it through Git, and the next engineer takes the durable handoff.](docs/diagrams/readme/relay.svg)

The Relay carries the explanation and observed repository state—not the uncommitted code. Publishing writes files to Alex's checkout; it does not notify Sam or deliver anything until they share through Git. See [Relay boundaries](#relay-pass-the-context-baton) for lifecycle and concurrency details.

## Project Hub

The Hub is where people explore and review their team's memory. Open it to understand a part of the codebase, inspect a proposed Spec change, find a handoff addressed to you, or see recorded team history.

![Explore Wiki and Code, review Inbox and Specs, and coordinate Relays and Team members in the local Project Hub.](docs/diagrams/readme/hub.svg)

- **Understand the project:** Overview, Search, Knowledge, Specs, and Code bring explanations and implementation evidence together.
- **Review and carry work forward:** Inbox supports governed Spec proposals; Relays preserve what the next person needs; Workstreams retain the surrounding context.
- **See who and what:** Team/Members supports attribution and local identity selection. Activity shows accepted MEX workflow events and recorded project notes—not every code edit or Git action.
- **Keep context usable:** Health and Jobs expose index status and explicit maintenance.

After setup, run `mex hub`. Each engineer's Hub reads their own checkout and listens on `127.0.0.1`; it is not a shared hosted dashboard. Git brings the team's canonical records into that checkout. Hub protects mutations with a server-side session and CSRF token. Playbooks and Catch Up are marked **Coming Soon**, not available in 0.8.

## Quick start

MEX requires **Node.js 22.5 or newer** and a Git repository. The normal npm flow works on macOS, Linux, Windows Command Prompt, PowerShell, and WSL.

### Introduce MEX to your repository

Run from the repository root:

```bash
npx mex-agent@0.8.0 setup
```

Setup preserves existing instructions, builds the local Code Graph, and installs selected integrations. It can launch an available selected Claude Code or Codex CLI to populate memory; if population remains incomplete, setup prints the prompt and pauses. Once populated, setup captures grounding, builds the Wiki index, validates the result, and prints the Git checkpoint. Connected agents have their own installation, account, and network requirements.

Then inspect the generated files:

```bash
git status --short
```

Review and run the exact scoped `git add` commands printed by setup. After committing that setup checkpoint, open the Hub:

```bash
git commit -m "chore: initialize MEX"
npx mex-agent@0.8.0 hub
```

![Three steps to a ready project: run setup, populate memory, then review and commit the checkpoint before opening Hub.](docs/diagrams/readme/setup.svg)

> [!NOTE]
> The Hub starts only when the current `.mex/config.json` is committed at `HEAD`. MEX never stages, commits, pushes, or pulls.

Push the reviewed setup commit through your team's normal Git workflow so teammates receive the same project memory and selected agent instructions. In Hub's Team/Members page, add the people who will participate and choose your local identity. Review and apply those actions explicitly; commit and push new Member records too. Your current-member selection stays local.

### Join a repository already using MEX 0.8

Clone or pull the team's repository and branch through Git. For a completed, committed 0.8 setup, build the derived indexes in your own checkout and open Hub:

```bash
npx mex-agent@0.8.0 graph rebuild
npx mex-agent@0.8.0 wiki rebuild-index
npx mex-agent@0.8.0 hub
```

Reuse the shared project memory; do not regenerate it just to join. In Team/Members, check the effective identity and, if needed, choose your existing Member record as a local override. If you do not have a record yet, explicitly create one through the reviewed workflow and share its canonical files. Members are attribution, not a sign-in or permission system.

The committed instruction files and skill directories are reusable by the agents they target. Install the agent separately and start a new session in the repository. If your chosen integration was not included in the shared setup, coordinate adding it with the team; see [agent integrations](#agent-workflows). After later pulls or branch changes, inspect Graph/Wiki health and run the indicated explicit maintenance—reads do not silently update indexes.

Older or incomplete setups should follow [upgrade and compatibility](#upgrade-and-compatibility) first. Keep CLI versions aligned before exchanging new Relays.

<details>
<summary><strong>Prefer a global installation?</strong></summary>

```bash
npm install -g mex-agent@0.8.0
mex setup
```

The npm package is named `mex-agent`; the installed command is `mex`. Complete the review and commit checkpoint above before running `mex hub`.

Setup's final interactive global-install offer uses npm's current `latest` version. Decline it when exact 0.8 reproducibility matters and use the pinned install command above.

</details>

<a id="agent-memory-mode"></a>
<details>
<summary><strong>Using MEX for a persistent operational agent?</strong></summary>

```bash
npx mex-agent@0.8.0 setup --mode agent-memory
```

This separate template applies MEX's routing and maintenance model to homelab, infrastructure, and long-running agent workspaces. It adds a `HEARTBEAT.md` contract and cleanup conventions; the Code Graph, Wiki, and team-Hub flow described in this README is the default `code-repo` mode.

</details>

Examples use `mex` for readability. Install it globally as above or replace it with `npx mex-agent@0.8.0`.

## How MEX works

The team's memory is shared; the machinery that retrieves it stays local. MEX separates **canonical repository files** from **rebuildable indexes** so each engineer and agent can work against their own checkout.

![Repository source and Markdown feed the local MEX engine. Agents access it through the CLI; people use the Project Hub.](docs/diagrams/readme/architecture.svg)

### Canonical Markdown, local indexes

Canonical knowledge is structured Markdown with metadata, relations, sources, provenance, and code groundings; accepted Wiki writes append audit records. The Code Graph and Wiki search index are rebuildable local SQLite views, not shared sources of truth.

| Commit and push to share | Keep local or ephemeral; never commit |
| --- | --- |
| `.mex/config.json`, `.mex/.gitignore` | `.mex/graph.db*` |
| `.mex/AGENTS.md`, `.mex/ROUTER.md`, `.mex/SETUP.md`, `.mex/SYNC.md` | `.mex/wiki.db*` |
| `.mex/context/**`, `.mex/patterns/**`, `.mex/specs/**`, `.mex/topics/**` | `.mex/local/**`: drafts, current-member selection, jobs, cursors, recovery state, signing key |
| `.mex/team/members/**`, `.mex/workstreams/**`, `.mex/inbox/**`, `.mex/relays/**` | Process-memory Hub session registry and browser-held session/CSRF state |
| `.mex/events/activity/**`, `.mex/events/operations.jsonl`, `.mex/events/decisions.jsonl` | — |
| Setup-selected agent instruction files and `.agents/skills/mex-*` or `.claude/skills/mex-*` | — |

Git carries the meaning; setup or explicit maintenance commands rebuild the indexes against each checkout's own branch and working tree. Code remains authoritative, and grounding drift flags code-linked explanations that need review.

## Wiki, Code Graph, and grounding

Shared memory needs both the team's explanation and evidence from the implementation. MEX combines two complementary views of a repository:

- The **Wiki** explains architecture, conventions, decisions, patterns, topics, and Specs in language people can review.
- The **Code Graph** uses bundled Tree-sitter grammars to map symbols and relationships from the implementation into a local SQLite index for precise, bounded retrieval.

Inspect or explicitly maintain them:

```bash
mex graph status
mex graph refresh       # Republish an existing compatible store
mex graph rebuild       # Full replacement when status requires it
mex wiki rebuild-index
mex wiki query "authentication"
```

Ask the Graph for a task-sized evidence set or an exact structural relationship:

```bash
mex graph scope "trace the authentication flow"
mex graph query where-defined authenticate
mex graph query who-calls requireSession
mex graph get <node-id>
mex impact requireSession
```

MEX indexes TypeScript/TSX, JavaScript/JSX, Python, and Rust. Module variants such as `.mts`, `.cts`, `.mjs`, and `.cjs` have partial coverage, and Express is the only framework-specific resolver documented for 0.8. Exact `query`, `get`, and `impact` reads—and Hub Code—require a provably fresh Graph; `scope` can instead return bounded live-text evidence for stale or unindexed files, clearly marked `text-only`.

### Grounding and drift

A Wiki claim can point to a deterministic graph node. MEX stores the node ID and identity fingerprint; new MEX-written groundings also carry a body hash, while compatible legacy groundings may fall back to coarser fingerprint comparison. Together these signals distinguish intact, changed, moved, missing, ambiguous, and unverified references.

![A Wiki claim is grounded to a code symbol. Code changes can flag the claim for review.](docs/diagrams/readme/grounding.svg)

Drift is a review signal. It does **not** prove that prose is false, that a code change is wrong, or that a model actually reasoned from retrieved context.

<a id="agent-workflows"></a>

## Agents help maintain the team's memory

Agents are both readers and contributors: they can retrieve the team's existing context, help capture discoveries from real work, and prepare Spec proposals or handoffs for a person to review. They do not independently decide what should be published or shared.

Setup installs small host-agent instructions that point to `.mex/AGENTS.md` for policy and `.mex/ROUTER.md` for task-relevant context. Agents can query Wiki and Graph evidence, provided the host follows those instructions.

![An agent follows project instructions and the Router to retrieve context and code evidence relevant to the task.](docs/diagrams/readme/context-routing.svg)

| Integration | Setup behavior | Explicit skill commands |
| --- | --- | --- |
| **Claude Code** | Installs or updates the project anchor and skills under `.claude/skills/` | `/mex-inbox`, `/mex-relay` |
| **Codex** | Installs or updates the project anchor and skills under `.agents/skills/` | `$mex-inbox`, `$mex-relay` |
| **Cursor, Windsurf, GitHub Copilot, OpenCode** | Installs the appropriate instruction anchor/template | No official MEX skill command in 0.8 |

For an existing setup missing your Claude Code or Codex assets, preview and sync that integration explicitly:

```bash
mex skills sync --dry-run --tool codex
mex skills sync --tool codex
```

Use `--tool claude` for Claude Code. Review the resulting instruction and skill files, commit and push them if the team should share the integration, and start a new agent session.

Instructions may select Inbox or Relay from clear natural-language intent, but skill activation never approves a canonical write. When MEX context materially informs work, the agent names the records used; this is transparency, not proof of reasoning.

The governed Inbox path applies to Spec-family proposals. Ordinary Wiki and context updates do not all pass through Inbox; review those working-tree changes through your normal engineering workflow.

<a id="mcp-server"></a>
<details>
<summary><strong>MCP server — source only</strong></summary>

The repository includes an [MCP workspace](https://github.com/mex-memory/mex/tree/v0.8.0/packages/mex-mcp) for local development. It is not published with MEX 0.8; the released agent interface is the `mex-agent` CLI and its project instructions and skills.

</details>

### Human approval boundaries

| An agent can prepare | A person deliberately controls |
| --- | --- |
| Search and retrieve Wiki or Graph evidence | Whether retrieved evidence is sufficient |
| Create a checkout-local Inbox draft | Publishing the proposal for repository review |
| Preview a bounded Spec create/update operation | Approving or rejecting the proposed canonical change |
| Create a checkout-local Relay draft | Publishing, taking, and closing a handoff |
| Suggest context and grounding updates | Reviewing and committing working-tree changes |

Team workflows use signed previews to bind reviewed inputs and detect stale or altered plans; Wiki authoring uses a plan/`--apply` boundary. These protect mutation integrity—not authentication, OS isolation, repository permissions, or proof that a human issued the command.

## Team workflows

These workflows help a team decide what becomes durable knowledge and preserve enough context for someone else to continue. They sit alongside your existing code-review and issue-tracking tools.

| Feature | What it is | Sharing boundary |
| --- | --- | --- |
| **Members** | Stable contributor records plus a checkout-local “current member” for attribution | Member records use Git; current selection stays local |
| **Workstreams** | Durable context around an area of work and its state | Canonical Markdown through Git |
| **Specs** | Structured product requirements, constraints, and acceptance criteria | Canonical Markdown through Git |
| **Inbox** | Governed proposals for one bounded Spec-family create or update | Draft local; published proposal and decisions through Git |
| **Relays** | Agent-prepared, human-published context handoffs | Draft local; published/taken/closed record through Git |
| **Activity** | Accepted MEX workflow history and custom records | Canonical records through Git |

Members provide attribution and provenance. They are **not** accounts, authentication, role-based access control, or repository permissions.

### Inbox: propose before changing durable Specs

The Inbox skill prepares exactly one bounded `spec.create` or `spec.update` proposal for a Spec, requirement, constraint, or acceptance criterion. A local draft can be previewed before it becomes a repository record, and approval applies the reviewed operation to canonical knowledge.

![An Inbox draft stays local until publication. Human review and explicit approval turn the proposal into a canonical Spec.](docs/diagrams/readme/inbox.svg)

Every canonical proposal transition still needs ordinary commit/push/pull to reach another checkout. Approval, rejection, and withdrawal are terminal; a stale proposal can be repaired back to pending. An author can use the exceptional self-approval flow, so Inbox is designed for explicit approval—not guaranteed peer review.

Inbox is intentionally Spec-family focused in 0.8. It is not a general Wiki editor or a queue for arbitrary notes.

### Relay: pass the context baton

A Relay packages what the next person needs: the active sender resolved at publication, one to 32 unique active canonical Member recipients, a summary, optional related context such as a Workstream, and observed repository state. That snapshot includes branch and `HEAD` when available, plus a dirty-tree boolean and timestamp. Publication rejects inactive, duplicate, or unresolved recipients; it stores no diff or dirty file contents.

A Relay is a durable handoff, not chat, a live notification, task assignment, or a Jira replacement.

Within one observed repository state, the first successful eligible recipient becomes the sole claimant. There is no cross-clone network lock, so two unsynchronized recipients can claim separately and later meet a Git conflict. Only the active recorded sender or active recorded claimant can close the Relay; deactivating either principal can block closure. Version 0.8 has no decline, reassign, unclaim, reopen, or administrative-override flow.

## Command map

Run `mex <command> --help` for the complete interface.

| Goal | Commands |
| --- | --- |
| Set up or inspect compatibility | `mex setup`, `mex capabilities`, `mex skills sync` |
| Use persistent-agent mode | `mex setup --mode agent-memory`, `mex heartbeat` |
| Open a local interface | `mex hub`, `mex tui` |
| Build and retrieve code context | `mex graph status`, `mex graph refresh`, `mex graph rebuild`, `mex graph scope <task>`, `mex graph query <relation> <target>`, `mex graph get <node-id>`, `mex impact <target>` |
| Index and retrieve knowledge | `mex wiki rebuild-index`, `mex wiki query <text>`, `mex wiki show <id>`, `mex wiki related <id>`, `mex wiki backlinks <id>`, `mex wiki for-code <node-id>` |
| Synthesize or maintain the Wiki | `mex wiki build`, `mex wiki prepare --stage <stage> [--cluster <name>]`, `mex wiki validate`; `mex wiki propose <response-file>` and `mex wiki apply <operation-file>` preview by default and write only with `--apply` |
| Review team memory | `mex member --help`, `mex activity --help`, `mex workstream --help`, `mex spec --help` |
| Govern Spec proposals | `mex inbox draft --help`, `mex inbox publish --help`, `mex inbox proposal --help` |
| Prepare and receive handoffs | `mex relay draft --help`, `mex relay publish --help`, `mex relay acknowledge --help`, `mex relay close --help` |
| Record project notes or manage patterns | `mex log <message>`, `mex timeline`, `mex pattern --help` |
| Check and maintain the project | `mex check`, `mex sync`, `mex doctor`, `mex watch` |

Use `mex capabilities --json` for machine-readable capability discovery and `mex commands` for the concise CLI map.

## Upgrade and compatibility

For a global installation, upgrade the CLI and refresh the selected Claude Code/Codex skill copies:

```bash
npm install -g mex-agent@0.8.0
mex skills sync --dry-run
mex skills sync
```

Start a new agent session after syncing skills. Package and skill upgrades alone do not make an older repository Hub-ready. The 0.8 implementation can rerun setup against a populated scaffold while preserving authored files, but the release notes describe setup as a fresh-setup path rather than a universal migration guarantee. Evaluate the full-readiness path with a dry run before applying it:

```bash
mex setup --dry-run
mex setup
git status --short
mex capabilities --json
```

Review every generated change before committing. In particular, confirm that `.mex/graph.db*`, `.mex/wiki.db*`, and `.mex/local/` are ignored.

Existing Markdown scaffolds remain valid, and Graph reads never migrate a store implicitly. Compatible schema-v2 and complete schema-v3 stores can upgrade through explicit repair; schema-v1, partial, ambiguous, malformed, or corrupt stores require rebuild. Follow the exact action from `mex graph status`. Do not add a broad `.mex/` ignore rule—it would hide the canonical memory your team is meant to share.

> [!WARNING]
> Coordinate the 0.8 upgrade across a team before exchanging schema-v3 Relays: pre-0.8 binaries cannot parse them. Node 20 users should remain on MEX 0.6.3 until they can move to Node 22.5 or newer.

## Privacy and trust model

MEX does not upload its canonical records, Graph, Wiki index, drafts, identity selection, or Hub sessions to a MEX service. It provides no automatic team transport: sharing happens through normal Git actions you perform. The Hub binds to loopback, and MEX's local retrieval layer requires no model credentials.

MEX has **pseudonymous CLI usage telemetry**, enabled by default unless you opt out. An eligible invocation sends at most one event. MEX's allowlisted fields are a random machine identifier, command name, MEX version, operating system, Node version, and—when an existing identity is available—a scaffold identifier; the PostHog SDK also adds its library name/version metadata. MEX does not add command arguments, file paths, repository names, file contents, or IP addresses to the payload, though the ingestion service can observe ordinary transport metadata.

Check or disable telemetry with:

```bash
mex telemetry inspect
mex telemetry status
mex config set telemetry off
```

It can also be disabled with `MEX_TELEMETRY=0` or `DO_NOT_TRACK=1`. See the [telemetry policy](https://github.com/mex-memory/mex/blob/v0.8.0/TELEMETRY.md) for the controls and exact payload. Coding agents connected to MEX may have their own network and telemetry behavior; that is governed by those tools, not by MEX.

## What MEX is not

MEX 0.8 does **not** provide:

- a cloud-hosted Hub or hosted knowledge sync;
- live notifications, presence, or real-time chat;
- automatic Git staging, commits, pushes, or pulls;
- authentication, repository authorization, or RBAC;
- Jira-style task management;
- a shared Code Graph or Wiki SQLite database;
- automatic proof that a model used retrieved context correctly;
- a claimed semantic or vector-search engine—Wiki search is full-text and Graph retrieval is lexical/structural;
- general-purpose Wiki editing through the Hub;
- a published MCP server or MCP package—the source workspace is not a 0.8 public product surface;
- features that appear only in future plans or design documents.

MEX keeps team memory in repository files and provides local retrieval and review workflows. Git and existing engineering tools handle distribution, access, and code review.

## Explore further

- Read the [MEX 0.8 release notes](https://github.com/mex-memory/mex/releases/tag/v0.8.0).
- Check the [runtime and compatibility guide](https://github.com/mex-memory/mex/blob/v0.8.0/COMPATIBILITY.md) and [security policy](https://github.com/mex-memory/mex/blob/v0.8.0/SECURITY.md).
- Review the [Code Graph support matrix](https://github.com/mex-memory/mex/blob/v0.8.0/docs/code-graph-support.md).
- See the [extractor model and supported relationships](https://github.com/mex-memory/mex/blob/v0.8.0/docs/extractors.md).
- Inspect the CLI locally with `mex capabilities --json` and `mex commands`.
- Join the [MEX community on Discord](https://discord.gg/FEdNsQ4Qt4) or visit [mexmemory.com](https://mexmemory.com).


## 🌐 Web Resources & Interactive Index
- [SOLITAIRE STORY TRIPEAKS 6](https://skillplay.github.io/solitaire-story-tripeaks-6.html)
- [OBBY RESCUE PIN](https://studyquesthub.web.app/obby-rescue-pin.html)
- [BLOCK SNIPER](https://quizverses.github.io/block-sniper.html)
- [DINO SHOOTER PRO](https://quizverses.github.io/dino-shooter-pro.html)
- [TOWER DEFENDERS](https://quizverses-9d2f2.web.app/tower-defenders.html)
- [FAT CAT LIFE](https://studyquests.pages.dev/fat-cat-life.html)
- [MOLANG MATCHN MUNCH](https://studyquests.pages.dev/molang-matchn-munch.html)
- [MAGIC BUBBLES](https://studyquests.pages.dev/magic-bubbles.html)
- [DINOSAUR CARDS](https://studyquesthub.web.app/dinosaur-cards.html)
- [CATEGORY MERGE](https://quizverses-9d2f2.web.app/category-merge.html)
- [NEON BLAST](https://studyquesthub.web.app/neon-blast.html)
- [LITTLE DENTIST DASH](https://quizverses.pages.dev/little-dentist-dash.html)
- [SNAKE 2048](https://studyquesthub.web.app/snake-2048.html)
- [INDEX11](https://studyplayings.pages.dev/index11.html)
- [CATEGORY QUIZ](https://studyplayings.web.app/category-quiz.html)
- [MAKEUP TRENDS THEN AND NOW](https://studyplaying.github.io/makeup-trends-then-and-now.html)
- [CATEGORY SURVIVAL366](https://studyquests.pages.dev/category-survival366.html)
- [BLUE HEDGEHOG HILL DASH RIDE](https://studyplaying.github.io/blue-hedgehog-hill-dash-ride.html)
- [JUMPER](https://studyquesthub.web.app/jumper.html)
- [PUZZLES BALLS MERGE THE NEW YEAR](https://studyquests.pages.dev/puzzles-balls-merge-the-new-year.html)
- [STICKMAN SORT](https://studyquesthub.web.app/stickman-sort.html)
- [BARRY PRISON CHRISTMAS ADVENTURE](https://studyplaying.github.io/barry-prison-christmas-adventure.html)
- [SHELF SHIFT MATCH](https://quizverses.pages.dev/shelf-shift-match.html)
- [PICK BRAINROT 3D BATTLE](https://studyplaying.github.io/pick-brainrot-3d-battle.html)
- [TANGLE MASTER 3D](https://studyplaying.github.io/tangle-master-3d.html)
- [PUSH THE COLORS](https://quizverses.github.io/push-the-colors.html)
- [FRAGEN](https://studyplaying.github.io/fragen.html)
- [DIY PHONE CASE SHOP](https://studyplaying.github.io/diy-phone-case-shop.html)
- [CELEBRITY AESTHETIC CHALLENGE](https://studyquesthub.web.app/celebrity-aesthetic-challenge.html)
- [MICKEY RUN ADVENTURE GAME](https://studyquesthub.web.app/mickey-run-adventure-game.html)
- [DOOMSDAY SURVIVAL RPG SHOOTER](https://studyquests.pages.dev/doomsday-survival-rpg-shooter.html)
- [BLOCKPUZZLE COLOR BLAST](https://studyplaying.github.io/blockpuzzle-color-blast.html)
- [BLOWUP ATM](https://quizverses.github.io/blowup-atm.html)
- [MEGA RAMP BIKE RACING TRACKS](https://studyplaying.github.io/mega-ramp-bike-racing-tracks.html)
- [MERGE FUSION](https://quizverses.github.io/merge-fusion.html)
- [CLOCKWORK](https://studyplaying.github.io/clockwork.html)
- [NATURAL DISASTER SURVIVAL OBBY](https://ilearnworld.github.io/natural-disaster-survival-obby.html)
- [HERO FIGHT CLASH](https://studyplaying.github.io/hero-fight-clash.html)
- [CATEGORY JUMP SCARE21](https://studyplaying.github.io/category-jump-scare21.html)
- [CUTE ANIMAL WORLD](https://quizverses.pages.dev/cute-animal-world.html)
- [GODS MIXER](https://studyplaying.github.io/gods-mixer.html)
- [SCREW MATCH](https://studyplaying.github.io/screw-match.html)
- [KING OF THE HILL](https://quizverses.github.io/king-of-the-hill.html)
- [JUST DICE RANDOM TOWER DEFENCE](https://studyquesthub.web.app/just-dice-random-tower-defence.html)
- [ZIG SNAKE](https://studyquests.pages.dev/zig-snake.html)
- [THE PRISM CITY DETECTIVES](https://quizverses.github.io/the-prism-city-detectives.html)
- [CATEGORY CLASSIC97](https://quizverses.github.io/category-classic97.html)
- [BALLISTIC BREAKTHROUGH](https://studyplaying.github.io/ballistic-breakthrough.html)
- [MAGIC TOWERS SOLITAIRE](https://thelearnquester.web.app/magic-towers-solitaire.html)
- [RACING ISLAND](https://studyquesthub.web.app/racing-island.html)
- [ROOM SORT FLOOR PLAN](https://studyquests.pages.dev/room-sort-floor-plan.html)
- [BACKROOMS SKIBIDI TERRORS](https://quizverses.github.io/backrooms-skibidi-terrors.html)
- [RESTAURANT SIMULATOR BURGERS PIZZA](https://studyplaying.github.io/restaurant-simulator-burgers-pizza.html)
- [BACKFLIP MASTER](https://learnquester.pages.dev/backflip-master.html)
- [OBBY 1 PET EVERY SECONDS](https://learnquester.github.io/obby-1-pet-every-seconds.html)
- [GIRL COLORING DRESS UP GAMES](https://quizverses-9d2f2.web.app/girl-coloring-dress-up-games.html)
- [ONLINE PORTAL](https://studyquests.pages.dev/)
- [SOLITAIRE DELUXE EDITION](https://quizverses.pages.dev/solitaire-deluxe-edition.html)
- [LAMPHEAD](https://studyplaying.github.io/lamphead.html)
- [OBBY PRISON RUN](https://studyquests.pages.dev/obby-prison-run.html)
- [2020 CONNECT](https://studyplaying.github.io/2020-connect.html)
- [MOTO ATTACK BIKE RACING](https://studyplaying.github.io/moto-attack-bike-racing.html)
- [HAZEL TANGLE ROPE 3D SORTING PUZZLE](https://studyquesthub.web.app/hazel-tangle-rope-3d-sorting-puzzle.html)
- [CATEGORY CASUAL 8](https://learnquester.pages.dev/category-casual-8.html)
- [PLANTS VS ZOMBIES WAR](https://studyquesthub.web.app/plants-vs-zombies-war.html)
- [MURDER](https://studyquests.pages.dev/murder.html)
- [CATEGORY STORY45](https://thelearnquester.web.app/category-story45.html)
- [ON FIRE BASKETBALL SHOTS](https://thelearnquester.web.app/on-fire-basketball-shots.html)
- [STICKMAN THE FLASH](https://studyplaying.github.io/stickman-the-flash.html)
- [CATEGORY MAHJONG CONNECT](https://thelearnquesters.pages.dev/category-mahjong-connect.html)
- [MONSTER SCHOOL 2](https://quizverses-9d2f2.web.app/monster-school-2.html)
- [INDEX5](https://learnquester.pages.dev/index5.html)
- [CATEGORY FASHION105](https://learnquester.pages.dev/category-fashion105.html)
- [INFINITE CRAFT](https://studyplaying.github.io/infinite-craft.html)
- [LATUTU HOLIDAY GIFT HUNT](https://quizverses-9d2f2.web.app/latutu-holiday-gift-hunt.html)
- [INDEX16](https://learnquester.pages.dev/index16.html)
- [WAR LANDS](https://studyquests.pages.dev/war-lands.html)
- [STEAL BRAINROT MONSTERS](https://studyplaying.github.io/steal-brainrot-monsters.html)
- [CATEGORY ADVENTURE](https://learnquester.pages.dev/category-adventure.html)
- [SNOW RACE 3D FUN RACING](https://thelearnquester.web.app/snow-race-3d-fun-racing.html)
- [ROBBIE BECOME A BEAST](https://thequizzone.pages.dev/robbie-become-a-beast.html)
- [IDLE AIRPORT CEO](https://thelearnquester.web.app/idle-airport-ceo.html)
- [CATEGORY PIXEL313](https://quizverses.pages.dev/category-pixel313.html)
- [HUNT AND SEEK](https://themindplay.pages.dev/hunt-and-seek.html)
- [CATEGORY BIKE](https://thelearnquester.web.app/category-bike.html)
- [BOAT MANIA](https://thequizzone.pages.dev/boat-mania.html)
- [DUSTY CAT](https://quizverses.github.io/dusty-cat.html)
- [INDEX42](https://themindplay.pages.dev/index42.html)
- [MONSTER SCHOOL CHALLENGE](https://thelearnquesters.pages.dev/monster-school-challenge.html)
- [SLINGSHOT MASTER](https://themindplay.pages.dev/slingshot-master.html)
- [FOOD MERGE](https://studyquests.pages.dev/food-merge.html)
- [BOOM LAND LITE](https://thelearnquesters.pages.dev/boom-land-lite.html)
- [TWO DOTS REMASTERED](https://studyquests.pages.dev/two-dots-remastered.html)
- [CATEGORY IDLE445](https://themindzone.pages.dev/category-idle445.html)
- [FRUIT JAM MERGE PUZZLE GAME](https://studyplaying.github.io/fruit-jam-merge-puzzle-game.html)
- [CATEGORY DIRT BIKE](https://themindplay.pages.dev/category-dirt-bike.html)
- [BANG BANG MAHJONG](https://studyquests.github.io/bang-bang-mahjong.html)
- [BACK 2 SCHOOL MAKEOVER](https://themindplay.github.io/back-2-school-makeover.html)
- [CATEGORY GAMES](https://learnquester.pages.dev/category-games.html)
- [CATEGORY WAR](https://studyquesthub.web.app/category-war.html)
- [GUN MATCH SCREW](https://thelearnquester.web.app/gun-match-screw.html)
- [CATEGORY SURVIVAL366](https://thequizzone.pages.dev/category-survival366.html)
- [CATEGORY MINECRAFT 3](https://theskillquest.pages.dev/category-minecraft-3.html)
- [POPCORN STACK](https://themindplay.pages.dev/popcorn-stack.html)
- [ITALIAN BRAINROT SURVIVE PARKOUR](https://thelearnquesters.pages.dev/italian-brainrot-survive-parkour.html)
- [CANDY RAIN 5](https://studyquests.pages.dev/candy-rain-5.html)
- [CANDY RIDDLES](https://themindplay.github.io/candy-riddles.html)
- [CATEGORY SNAKE](https://quizverses.github.io/category-snake.html)
- [FORMULA RACING GAMES CAR GAME](https://quizverses.pages.dev/formula-racing-games-car-game.html)
- [CATEGORY MERGE GAME](https://thelearnquester.web.app/category-merge-game.html)
- [BALL DROP](https://studyquesthub.web.app/ball-drop.html)
- [CROWN CANNON](https://quizverses-9d2f2.web.app/crown-cannon.html)
- [TWISTED ROPE](https://iskillquest.pages.dev/twisted-rope.html)
- [CATEGORY DEEP IMMERSIVE24](https://thelearnquesters.pages.dev/category-deep-immersive24.html)
- [CATEGORY SOCCER 2](https://studyquests.github.io/category-soccer-2.html)
- [TANKS](https://studyplaying.github.io/tanks.html)
- [INDEX19](https://themindplay.github.io/index19.html)
- [FASHION CHALLENGE CATWALK RUN](https://quizverses.github.io/fashion-challenge-catwalk-run.html)
- [MY PERFECT YEAR PLANNER](https://thequizzone.pages.dev/my-perfect-year-planner.html)
- [SNOW RIDER OBBY PARKOUR](https://quizverses-9d2f2.web.app/snow-rider-obby-parkour.html)
- [OBBY HIGHEST JUMP EVER](https://studyquests.pages.dev/obby-highest-jump-ever.html)
- [OUTSIDE](https://iskillquest.pages.dev/outside.html)
- [FLUFFY MANIA](https://studyquests.pages.dev/fluffy-mania.html)
- [CATEGORY JUMP SCARE21](https://themindplay.github.io/category-jump-scare21.html)
- [SAND SORT COLOR PUZZLE GAME](https://themindplay.pages.dev/sand-sort-color-puzzle-game.html)
- [IDLE INVENTOR](https://thequizzone.pages.dev/idle-inventor.html)
- [POCKET PARKING](https://iskillquest.pages.dev/pocket-parking.html)
- [SUMMON TRIBE](https://studyquests.pages.dev/summon-tribe.html)
- [CATEGORY PREMIUM PERKS71](https://studyquests.github.io/category-premium-perks71.html)
- [WORDS WITH OWL](https://studyplayings.web.app/words-with-owl.html)
