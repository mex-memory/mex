---
name: architecture
description: How the major pieces of this project connect and flow. Load when working on system design, integrations, or understanding how components interact.
triggers:
  - "architecture"
  - "system design"
  - "how does X connect to Y"
  - "integration"
  - "flow"
edges:
  - target: context/stack.md
    condition: when specific technology details are needed
  - target: context/decisions.md
    condition: when understanding why the architecture is structured this way
  - target: patterns/fresh-graph-hub-integration.md
    condition: when connecting Graph reads or maintenance to Project Hub
  - target: patterns/local-first-team-state.md
    condition: when changing canonical or checkout-local Team state
  - target: patterns/secure-local-project-hub.md
    condition: when changing Hub routes, sessions, projections, or jobs
  - target: patterns/safe-graph-snapshot-evolution.md
    condition: when changing Graph indexing, freshness, or recovery
# Broad overview: keep this empty unless a claim depends on a few specific symbols.
# Entry shape: { node: "function:<tier-1-id>", fingerprint: "mh:64:<hex>" }
grounds_to: []
last_updated: 2026-09-12
mex:
  id: mx_01M1M0CJ5C5XQV0HM5VM787WQS
  type: architecture
  status: promoted
  revision: 10
  title: architecture
  relations:
    - type: related_to
      target: mx_01M1M0CJH1XW1V1FRGAGMWFXD6
      note: when specific technology details are needed
    - type: related_to
      target: mx_01M1M0CJKZF3ABC1PQREMA2HYR
      note: when connecting Graph reads or maintenance to Project Hub
    - type: related_to
      target: mx_01M1M0CJMRWZY5TZCEBSFJPAHT
      note: when changing canonical or checkout-local Team state
    - type: related_to
      target: mx_01M1M0CJQ2BSV71G1C7TXZD9RH
      note: when changing Hub routes, sessions, projections, or jobs
    - type: related_to
      target: mx_01M1M0CJP81C590FCKTSN5HA3Q
      note: when changing Graph indexing, freshness, or recovery
---

# Architecture

<!-- mex:entity
id: mx_01M1M0CJ4PS8VVVJJTFA58S3A5
type: component
status: promoted
revision: 1
-->
## System Overview

Repository source and tracked MEX artifacts—primarily Markdown, plus canonical
JSONL audit/event history—are the durable inputs.
The CLI resolves the repository/scaffold, validates bounded input, and dispatches
to Graph, Wiki, drift, Team, or Hub application services. Graph maintenance
extracts supported source into the disposable `.mex/graph.db`; graph reads adopt
an immutable, provenance-bound snapshot. Agents use those facts to author or
repair tracked Markdown and attach tight symbol groundings. Wiki maintenance
migrates and indexes that Markdown into disposable `.mex/wiki.db`. The local
Project Hub consumes repository adapters for Graph, Wiki, and Team data through
private contracts, while explicit jobs own maintenance. Canonical Team records
remain Git-tracked; per-checkout identity, drafts, cursors, leases, and jobs live
under `.mex/local/`.

<!-- mex:entity
id: mx_01M1M0CJ403NMAF19JFEKQ5W29
type: component
status: promoted
revision: 1
-->
## Key Components

- **CLI and setup (`src/cli.ts`, `src/setup/`)** — command dispatch, resumable scaffold creation, agent asset installation, Graph construction, population, grounding capture, and Wiki finalization.
- **Code Graph (`src/graph/`)** — deterministic extraction, versioned SQLite storage, immutable read sessions, provenance/freshness checks, retrieval, impact, and explicit refresh/rebuild recovery.
- **Wiki (`src/wiki/`)** — treats repository Markdown as canonical, owns migration/validation/indexing, and exposes bounded query plus repository-adapter services.
- **Team workflows (`src/team/`)** — canonical Members, Activity, Workstreams, Inbox, and Relay records plus signed preview/apply services and isolated checkout-local state.
- **Project Hub (`src/hub/`, `packages/hub-contracts`, `packages/hub-web`)** — `launchHub()` opens the loopback server. Incomplete checkouts get a setup-only process that shares the CLI setup phases through `runHeadlessSetup()`. Claude Code and Codex run as owned background children. Their structured streams supply activity timing and a separate read-only transcript of assistant messages with compact fixed tool labels; command details and tool results are dropped before transcript retention. Cursor-based SSE replays a bounded process-memory history without copying it into run snapshots. After code setup finishes and the committed scaffold identity passes the existing Team authority check, an explicit action promotes the same listener and session into the full Hub. The promoted dashboard then shows a browser-local first-run spotlight tour once per device; it overlays the live sidebar rather than replacing it, does not persist in checkout state, and does not run during setup. Existing committed code projects retain Health recovery for missing disposable indexes; Agent memory keeps its separate completion path.
- **Drift and agent workflows (`src/drift/`, `src/sync/`, `src/agent-skills/`)** — check grounded knowledge, prepare bounded repair briefs, and install the governed Inbox/Relay integrations.

<!-- mex:entity
id: mx_01M1M0CJ3B8XKJ8NJGYRMYJ59C
type: component
status: promoted
revision: 1
-->
## External Dependencies

- **Git** — repository identity, revisions, sharing, and bounded read-only observations. The setup-only Hub also offers an explicit, revision-bound diff review and local commit of scoped setup files, preserving unrelated staged work. Ordinary reads do not stage or commit; product code never pushes or pulls.
- Claude Code or Codex may be launched for setup population; interactive sync
  can use Claude Code, Codex, or OpenCode, and prompt-only fallback works with
  any file-reading agent.
- A local browser connects only to the loopback Project Hub and exchanges a one-use bootstrap token for a private session.
- **PostHog ingestion** — optional pseudonymous CLI/Hub events share one random installation UUID. A bounded read-only configuration snapshot can add the existing scaffold UUID for shared-project estimates and known configured AI-tool names; it never identifies the invoking agent or creates project identity. Names, remotes, paths, content, queries, and contact details remain excluded. A bounded per-user outbox and cancellable Node HTTP transport replace the SDK. Development checkouts and opt-out controls disable collection/delivery; see `TELEMETRY.md`.

<!-- mex:entity
id: mx_01M1M0CJ1E1X7BW1Q7PMGPVCRC
type: component
status: promoted
revision: 1
-->
## What Does NOT Exist Here

- No hosted MEX service, remote database, account system, or cloud sync; sharing is ordinary Git-tracked Markdown.
- No implicit repair on Graph, Wiki, or Team read paths; all maintenance and mutations are explicit operations.
- No production fixture fallback: unavailable repository capabilities stay visibly unavailable.
- No public package export for internal Hub or Team workflow contracts unless a separate compatibility change deliberately adds one.
