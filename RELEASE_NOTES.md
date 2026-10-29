# MEX 0.8.5 — Checked state diagrams and resumable setup

October 29, 2026.

Ask your coding agent to explain a complicated flow with a state diagram.
MEX 0.8.5 adds checked statecharts that use relevant project knowledge and code
evidence, with an interactive Hub viewer when you want to explore further.
This release also makes setup parallel and resumable and reduces graph build
and refresh costs on large repositories.

## Understand the agent's explanation

Ask “explain this using a statechart” or invoke `mex-statechart` in Claude Code
or Codex. The skill can explain existing behavior, show a bug or recovery path,
compare a proposed fix, or start from an agreed chart or existing TLA+ model.
It draws states and events in human language and uses MEX knowledge, code links
and relevant history when they help explain the behavior.

TLA+/TLC checking explores the modeled states and checks the stated rules.
Numbered counterexample paths show how a rule can break. A checked model is
still an abstraction: source alignment, reproduction against real code and
current evidence freshness are reported separately. Missing tooling or evidence
stays visible rather than becoming a passing result.

- Read native Mermaid where your client supports it. Terminal clients receive
  readable text when they cannot render the required diagram; optional PNG
  delivery is available for clients that display images.
- Explore an optional Hub preview with selectable states, directed transitions,
  pan/zoom, numbered paths, rules and evidence. The agent can offer to start and
  open the preview for you.
- Keep a preview temporary, or explicitly review and Save a snapshot in Hub.
  Saved diagrams live in Markdown-owned bundles under `.mex/diagrams/` and can
  be reopened without Java or a built code index. Save never stages, commits
  or pushes; use Git when you want to share them.

Generation uses scratch space. Installation, upgrades and Hub viewing do not
install or execute Java/TLC. Explicit checking requires Java 11+ and the pinned,
checksum-verified TLC 1.7.4 toolchain; first-use setup is documented in the skill.
See [state diagram compatibility](COMPATIBILITY.md#state-diagrams-in-085).

## Setup that keeps completed work

Larger repositories are split into subsystem tasks, with up to three population
tasks running in parallel by default. Background population can overlap graph
construction, and completed batches survive interruption or an agent usage
limit. The terminal and Hub show progress and recovery guidance.

Background setup now supports Cursor, GitHub Copilot and OpenCode CLI alongside
Claude Code and Codex, provided the selected agent is installed and signed in.
For agents MEX cannot launch, `mex setup next --start` begins a resumable
one-paste flow. Subsequent calls apply completed batches and continue the plan.

A healthy checkout reports its setup status on rerun instead of starting over.
Only one setup can run per checkout. Setup recognizes deeply nested sources,
checks Git before the terminal tool picker, audits thin project knowledge and
keeps existing facts whose code has changed for explicit sync review.
Managed skill updates also accept unmodified files checked out with Windows
CRLF line endings while preserving real local edits.

## Faster graph work and clearer results

- Large TypeScript monorepos use less build memory and time. A previously
  failing 9,400-file benchmark completes at the default heap; its graph database
  is about 27% smaller. These are measurements on that fixture, not a guarantee
  for every repository. Refresh reuses unchanged compiler projects, and CLI
  maintenance uses the same memory-sized worker as Hub.
- `who-calls` and `impact` prioritize production callers. Omitted test results
  are counted; use `--include-tests` to include them. Call locations and compact
  line counts make long declarations easier to navigate.
- Scope preserves requested fingerprints and no longer drops a compact answer
  when given a larger budget. CRLF source output and phase-timing flags are fixed.
- Interrupted maintenance cleans up abandoned candidate databases safely,
  retaining deliberate recovery copies. Fresh `mex graph` runs reuse the index;
  changed or incompatible indexes take the appropriate maintenance path.
- Wiki operations can be applied as atomic batches of up to 200, with scoped
  grounding checks. Fresh setup creates Wiki identities from the start, and
  finalization reports unverifiable code references with actionable detail.

Hub also recovers from expired or reused access links and shows the Wiki
migration command in Health. An optional hosted-beta signup is available from
setup, Relays and Overview; MEX's shipped knowledge-sharing workflow remains Git.

## Upgrade an existing project

Once 0.8.5 is available on npm, install it and run skill sync in **each existing
MEX project**:

```bash
npm install -g mex-agent@0.8.5
mex skills sync --dry-run
mex skills sync
```

Review the dry run and resolve reported local conflicts, then start a fresh
Claude Code or Codex session. This installs `mex-statechart` through the same
managed updater as Inbox and Relay. Upgrading the CLI alone does not update
project skill copies; completed setup does not need to run again just for this.
Review and commit/push the project changes when teammates should receive them.

Preserve the existing graph, then run:

```bash
mex graph refresh
mex check
mex sync
```

The updated TypeScript extractor causes a one-time rebuild, and some declaration
IDs can change. Refreshing the existing graph preserves the opportunity to map
old IDs before reviewing affected links. Graph schema v4 and Wiki index v5 are
unchanged from 0.8.4. Projects upgrading from 0.8.3 or earlier must also follow
the [earlier maintenance steps](COMPATIBILITY.md#upgrading-to-084), including an
explicit Wiki index rebuild. Everyone sharing `mh2:` fingerprints needs 0.8.4
or newer. Node.js 22.5+ with SQLite FTS5 remains required.

Graph JSONL keeps protocol v3 with read-output changes, including removal of
the redundant `sourceBackedNodes` summary field. See the
[upgrade and compatibility guide](COMPATIBILITY.md#upgrading-to-085) and
[full changelog](CHANGELOG.md#085---2026-10-29) for details.

**Full comparison:** [v0.8.4…v0.8.5](https://github.com/mex-memory/mex/compare/v0.8.4...v0.8.5).

## Contributors

Thanks to everyone who contributed since 0.8.4:

- @theDakshJaitly — checked state diagrams, Hub rendering and release integration ([#317](https://github.com/mex-memory/mex/pull/317)).
- @theyashasvipandey — parallel/resumable setup, setup reliability and graph performance ([#298](https://github.com/mex-memory/mex/pull/298), [#316](https://github.com/mex-memory/mex/pull/316), [#322](https://github.com/mex-memory/mex/pull/322)).
- @Akshtdhamija — setup recovery and validation, graph read fixes, managed skill portability, Hub access and platform coverage ([#277](https://github.com/mex-memory/mex/pull/277), [#278](https://github.com/mex-memory/mex/pull/278), [#279](https://github.com/mex-memory/mex/pull/279), [#303](https://github.com/mex-memory/mex/pull/303), [#304](https://github.com/mex-memory/mex/pull/304), [#306](https://github.com/mex-memory/mex/pull/306), [#307](https://github.com/mex-memory/mex/pull/307), [#309](https://github.com/mex-memory/mex/pull/309), [#312](https://github.com/mex-memory/mex/pull/312), [#313](https://github.com/mex-memory/mex/pull/313), [#314](https://github.com/mex-memory/mex/pull/314), [#315](https://github.com/mex-memory/mex/pull/315)).
- @M4Y4NK-V3RM4 — orphan graph-candidate cleanup and Wiki migration guidance ([#265](https://github.com/mex-memory/mex/pull/265), [#272](https://github.com/mex-memory/mex/pull/272)).
- @Golden007-prog — deeply nested project-source detection ([#295](https://github.com/mex-memory/mex/pull/295)).
- @tarun5004 — Git preflight before terminal setup ([#296](https://github.com/mex-memory/mex/pull/296)).
- @arxh80 — preserving Scope fingerprints within the output budget ([#299](https://github.com/mex-memory/mex/pull/299)).
- @iamcipherdev — agent-facing paused-setup instructions ([#294](https://github.com/mex-memory/mex/pull/294)).
- @uzumakienes and @onuracar-dev — graph phase-timing flag handling ([#301](https://github.com/mex-memory/mex/pull/301)).
