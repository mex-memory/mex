---
name: stack
description: Technology stack, library choices, and the reasoning behind them. Load when working with specific technologies or making decisions about libraries and tools.
triggers:
  - "library"
  - "package"
  - "dependency"
  - "which tool"
  - "technology"
edges:
  - target: context/decisions.md
    condition: when the reasoning behind a tech choice is needed
  - target: context/conventions.md
    condition: when understanding how to use a technology in this codebase
  - target: context/architecture.md
    condition: when locating a technology in the runtime flow
  - target: context/setup.md
    condition: when runtime, build, or test prerequisites are needed
# Broad inventory: ground only claims embodied by a small number of symbols.
# Entry shape: { node: "function:<tier-1-id>", fingerprint: "mh2:64:<base64url>" }
grounds_to: []
last_updated: 2026-09-06
mex:
  id: mx_01M1M0CJH1XW1V1FRGAGMWFXD6
  type: architecture
  status: promoted
  revision: 4
  title: stack
  relations:
    - type: related_to
      target: mx_01M1M0CJ9460AT00V8TH0QCKAC
      note: when understanding how to use a technology in this codebase
    - type: related_to
      target: mx_01M1M0CJ5C5XQV0HM5VM787WQS
      note: when locating a technology in the runtime flow
    - type: related_to
      target: mx_01M1M0CJGBPPFPWHY980PMTS2T
      note: when runtime, build, or test prerequisites are needed
---

# Stack

## Core Technologies

- **Node.js 22.5+** — ESM runtime; `node:sqlite` makes this minimum mandatory for MEX 0.8.x.
- **TypeScript 5.9** — strict root implementation and shared contracts, targeting ES2022 with bundler-style module resolution.
- npm workspaces — root CLI/core plus `@mex/hub-contracts` and `@mex/hub-web` packages.
- **tsup** — builds the Node CLI/library and contract package; root output is ESM with declarations and source maps.
- **React** — version 19 UI runtime for the Project Hub.
- **Vite** — builds the route-lazy Hub web application after the Node bundle.
- **SQLite** — disposable Graph/Wiki indexes and checkout-local Team state; canonical knowledge and team artifacts remain files.

## Key Libraries

- **Commander** — CLI command tree and option parsing.
- **web-tree-sitter** — multi-language structural extraction through packaged WASM grammars; TypeScript adds compiler-backed resolution.
- **Hono** — routing for the loopback Project Hub HTTP service.
- **@hono/node-server** — Node listener adapter for the Hub.
- **Zod** — closed private Hub request/response contracts and safe projections.
- **unified**, **remark-parse**, **remark-frontmatter**, and **yaml** — Markdown frontmatter, Wiki entities, edges, and grounding metadata.
- **Ink** — terminal UI surfaces; keep TUI behavior separate from JSONL graph protocols.
- **Vitest** — root unit and integration test runner.
- **@playwright/test** and **@axe-core/playwright** — production-browser and accessibility coverage.
- **cross-spawn** — cross-platform local agent CLI execution without shell quoting.
- **simple-git** and **glob** — bounded repository operations and corpus discovery; neither is permission to mutate Git implicitly.

## What We Deliberately Do NOT Use

- No remote service or external database for project memory; local files and built-in SQLite keep operation repository-bound.
- No ORM over the safety-critical SQLite stores; schema, transactions, immutable reads, and migrations are explicit.
- No automatic Git writer in production workflows; MEX prepares canonical bytes and the user owns publication.
- No production mocks or fixture fallback when Graph, Wiki, or Team capabilities are unavailable.

## Version Constraints

- MEX 0.8.x requires Node.js `>=22.5`; Node 20 users must remain on MEX 0.6.3.
- The release performance baseline is calibrated on Ubuntu 24.04 with Node 22; Node 24 is compatibility coverage, not a second calibration target.
- Graph schema, extractor, grammar, and provenance versions are compatibility inputs. Reads reject or degrade incompatible stores; explicit maintenance owns migration/rebuild.
