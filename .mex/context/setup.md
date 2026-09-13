---
name: setup
description: Dev environment setup and commands. Load when setting up the project for the first time or when environment issues arise.
triggers:
  - "setup"
  - "install"
  - "environment"
  - "getting started"
  - "how do I run"
  - "local development"
edges:
  - target: context/stack.md
    condition: when specific technology versions or library details are needed
  - target: context/architecture.md
    condition: when understanding how components connect during setup
  - target: patterns/dogfood-mex-setup.md
    condition: when running or repairing MEX setup against this repository itself
  - target: patterns/release-performance-gate.md
    condition: when running or changing pinned release and packaging gates
# Ground only setup behavior implemented by specific code symbols.
# Entry shape: { node: "function:<tier-1-id>", fingerprint: "mh:64:<hex>" }
grounds_to: []
last_updated: 2026-09-13
mex:
  id: mx_01M1M0CJGBPPFPWHY980PMTS2T
  type: guide
  status: promoted
  revision: 6
  title: setup
  relations:
    - type: related_to
      target: mx_01M1M0CJH1XW1V1FRGAGMWFXD6
      note: when specific technology versions or library details are needed
    - type: related_to
      target: mx_01M1M0CJ5C5XQV0HM5VM787WQS
      note: when understanding how components connect during setup
    - type: related_to
      target: mx_01M1M0CJJD2AQZ6XKHV4VKYTGJ
      note: when running or repairing MEX setup against this repository itself
    - type: related_to
      target: mx_01M1M0CJNG4SW0WCJF3NB547HE
      note: when running or changing pinned release and packaging gates
---

# Setup

<!-- mex:entity
id: mx_01M1M0CJFM7745E5H4WNP73T2G
type: guide
status: promoted
revision: 1
-->
## Prerequisites

- Node.js `>=22.5` (MEX 0.8.x uses built-in `node:sqlite`).
- npm and Git.
- Optional: Claude Code or Codex CLI for setup population; OpenCode is also supported for interactive sync.
- Optional: a local browser for `mex hub`; browser and API traffic stay on loopback.

<!-- mex:entity
id: mx_01M1M0CJEX81H4G5X2CV5K65FA
type: guide
status: promoted
revision: 1
-->
## First-time Setup

1. `npm install`
2. `npm run typecheck`
3. `npm test`
4. `npm run build`
5. For exact-checkout browser setup, run `node dist/cli.js setup`. Use `node dist/cli.js setup --cli` for terminal dogfooding; rerun that terminal command after manual population to finalize grounding and Wiki readiness.
6. Review the canonical scaffold and selected agent files in setup, then explicitly commit them through the Hub action or your Git client. Keep generated databases and `.mex/local/` ignored. The completion guide precedes **Open Hub** and offers optional version-pinned global install and contact details.
7. Bare `node dist/cli.js` opens the Hub or setup; `node dist/cli.js hub` remains supported. Verify any installed global CLI matches the checkout. `mex tui` retains the terminal dashboard.

<!-- mex:entity
id: mx_01M1M0CJE778KMAJA005V2RWWN
type: guide
status: promoted
revision: 1
-->
## Environment Variables

- No environment variable is required for normal local CLI/library operation.
- `MEX_TELEMETRY=0` or `DO_NOT_TRACK=1` (optional) — disable pseudonymous CLI/Hub telemetry; the development repository also disables it automatically.
- `MEX_HOME` (optional) — override the base directory used for global MEX configuration, primarily for isolation in tests.
- `MEX_DEV` (optional) — force development-repository behavior, including telemetry suppression.
- `MEX_ENFORCE_RELEASE_BUDGETS=1` (release CI only) — enforce the pinned release resource budgets on the calibrated runner.
- `MEX_WIKI_SCALE=1` and `MEX_MIGRATION_CORPUS` (specialized tests only) — enable full-scale Wiki concurrency or a real-scaffold migration gate.

<!-- mex:entity
id: mx_01M1M0CJDF75G8KWY5VY3ZWD5A
type: guide
status: promoted
revision: 1
-->
## Common Commands

- `npm run dev` — watch-build the root Node package with tsup.
- `npm run typecheck` — typecheck contracts, root TypeScript, and Hub web.
- `npm test` — run the root Vitest suite with telemetry disabled and bounded worker concurrency.
- `npm run test:hub:web` — run the Hub web workspace tests.
- `npm run test:hub:e2e` — build all packages and run Playwright browser coverage.
- `npm run build` — build contracts and root Node output, then the packaged Hub web assets.
- `npm run eval:test` — run graph and comparison evaluator tests.
- `npm run test:hub:package` — pack/install smoke for the published CLI, skills, setup, Graph, Wiki, Team, and Hub boundaries.

<!-- mex:entity
id: mx_01M1M0CJCRH0R5BV8T5R7NPPQ6
type: guide
status: promoted
revision: 1
-->
## Common Issues

- **`node:sqlite` is unavailable:** confirm `node --version` is at least 22.5; older Node releases cannot run MEX 0.8.x.
- **Graph reports migration/rebuild required after an upgrade:** run the exact checkout CLI with `node dist/cli.js graph rebuild`, or rerun setup; do not edit SQLite files manually.
- **Wiki reports migration required:** finish scaffold population and continue browser setup or rerun `node dist/cli.js setup --cli` so migration, index rebuild, and validation happen in the supported order.
- **Tests become flaky while a build runs:** do not run the full test suite concurrently with tsup/Vite cleanup of generated output.
- **Graph status is degraded:** inspect parse health and narrow graph queries; partial structural parsing is usable evidence, not permission to invent missing facts.
