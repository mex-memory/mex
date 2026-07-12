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
# Ground only setup behavior implemented by specific code symbols.
# Entry shape: { node: "function:<tier-1-id>", fingerprint: "mh:64:<hex>" }
grounds_to: []
last_updated: [YYYY-MM-DD]
---

# Setup

<!-- Commands and environment facts need no code grounding. For a concrete symbol:
```markdown
[`someFunction()`](mex://function:<tier-1-id>)
```
-->

## Prerequisites
<!-- What must be installed before anything else.
     Include exact versions if they matter.
     Minimum 2 items. If you cannot find 2, write "[TO DETERMINE]".
     Length: 2-5 items.
     Example:
     - Node.js 20+
     - PostgreSQL 15
     - pnpm (`npm install -g pnpm`) -->

## First-time Setup
<!-- Exact steps to go from clone to running. In order.
     Use the actual commands from this project. No placeholders.
     Minimum 3 steps. If you cannot find 3, write "[TO DETERMINE]".
     Length: 3-7 steps.
     Example:
     1. `pnpm install`
     2. Copy `.env.example` to `.env` and fill in values
     3. `pnpm db:migrate`
     4. `pnpm db:seed` (optional, loads sample data)
     5. `pnpm dev` -->

## Environment Variables
<!-- Required environment variables and what they do.
     Mark which are required vs optional vs conditionally required.
     Do NOT include actual values — this file is committed to version control.
     Length: list all required, then conditional, then optional.
     Example:
     - `DATABASE_URL` (required) — PostgreSQL connection string
     - `JWT_SECRET` (required) — secret for signing tokens, min 32 chars
     - `STRIPE_API_KEY` (required if payments enabled) — only needed when ENABLE_PAYMENTS=true
     - `SENDGRID_API_KEY` (optional) — only needed if email features are used -->

## Common Commands
<!-- The commands used daily. Already in AGENTS.md but repeated here with more detail.
     Minimum 4 commands. If you cannot find 4, write "[TO DETERMINE]".
     Length: 4-8 commands.
     Example:
     - `pnpm dev` — starts dev server on port 3000 with hot reload
     - `pnpm test` — runs full test suite
     - `pnpm test:watch` — runs tests in watch mode
     - `pnpm lint` — ESLint + TypeScript check
     - `pnpm db:migrate` — runs pending migrations -->

## Common Issues
<!-- The things that go wrong most often and how to fix them.
     Only include issues that have actually occurred — not hypothetical problems.
     Minimum 2 items. If you cannot find 2, write "[TO DETERMINE]".
     Length: 2-5 issues.
     Example:
     **Port already in use:** `lsof -i :3000` to find the process, `kill -9 [PID]`
     **Migration fails:** Check DATABASE_URL is correct and the database is running -->
