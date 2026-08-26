---
name: router
description: Session bootstrap and navigation hub. Read at the start of every session before any task. Contains project state, routing table, and behavioural contract.
edges:
  - target: context/architecture.md
    condition: when working on system design, integrations, or understanding how components connect
  - target: context/stack.md
    condition: when working with specific technologies, libraries, or making tech decisions
  - target: context/conventions.md
    condition: when writing new code, reviewing code, or unsure about project patterns
  - target: context/decisions.md
    condition: when making architectural choices or understanding why something is built a certain way
  - target: context/setup.md
    condition: when setting up the dev environment or running the project for the first time
  - target: patterns/INDEX.md
    condition: when starting a task — check the pattern index for a matching pattern file
last_updated: 2026-08-25
---

# Session Bootstrap

If you haven't already read `AGENTS.md`, read it now — it contains the project identity, non-negotiables, and commands.

Then read this file fully before doing anything else in this session.

## Current Project State
<!-- What is working. What is not yet built. Known issues.
     Update this section whenever significant work is completed.
     This is the primary drift prevention mechanism — it re-grounds the agent every session.
     Length: 3 sections (Working / Not Built / Known Issues), 3-7 items each.
     Example:
     **Working:**
     - User authentication and session management
     - Core CRUD operations for all main entities

     **Not yet built:**
     - Email notification system
     - Admin dashboard

     **Known issues:**
     - Pagination breaks on filtered queries with more than 1000 results -->

**Working:**
- `mex ui` / `mex dashboard`: local web companion on `127.0.0.1:3847` with a persistent sidebar (Dashboard, Setup, Health, Graph, Activity, Settings) over drift, graph stats, activity, heartbeat, scaffold coverage, grounding coverage, and identity from the real engine
- Visual setup wizard that takes a project from no `.mex/` to a populated scaffold plus a built graph, with per-step progress over SSE. The finish screen is an ordered journey: scaffold → code graph → agent population (prompt locked until the graph exists) → capture grounding. After the agent populates, **capture grounding** fingerprints authored `grounds_to` / `mex://` references via the same `captureGroundingBaselines` the CLI uses
- `npm run sandbox` / `npm run sandbox:populate`: throwaway order-service project at `.sandbox/orders` so the wizard can be re-run from zero, then stand in for the agent when capturing grounding
- `src/setup/steps.ts`: the disk-touching setup steps as headless functions, shared by the interactive CLI wizard and the web wizard

**Not yet built:**
- Interactive code-graph explorer in the web UI (symbol browsing stays in `mex graph query` / `mex graph scope`)
- Visual drift repair — the dashboard reports drift and points at `mex sync`
- Editing scaffold Markdown from the browser
- Job persistence across a server restart

**Known issues:**
- On Windows, several graph integration tests fail on temp-directory cleanup (`EPERM`) because SQLite file handles outlive the test, and `test/graph-integration.test.ts` has a hardcoded 10s timeout that tree-sitter work exceeds on slower machines. Both predate the web UI work.

## Routing Table

Load the relevant file based on the current task. Always load `context/architecture.md` first if not already in context this session.

| Task type | Load |
|-----------|------|
| Understanding how the system works | `context/architecture.md` |
| Working with a specific technology | `context/stack.md` |
| Writing or reviewing code | `context/conventions.md` |
| Making a design decision | `context/decisions.md` |
| Setting up or running the project | `context/setup.md` |
| Any specific task | Check `patterns/INDEX.md` for a matching pattern |

## Behavioural Contract

For every task, follow this loop:

1. **CONTEXT** — Load the relevant context file(s) from the routing table above. Check `patterns/INDEX.md` for a matching pattern. If one exists, follow it. Narrate what you load: "Loading architecture context..."
2. **BUILD** — Do the work. If a pattern exists, follow its Steps. If you are about to deviate from an established pattern, say so before writing any code — state the deviation and why.
3. **VERIFY** — Load `context/conventions.md` and run the Verify Checklist item by item. State each item and whether the output passes. Do not summarise — enumerate explicitly.
4. **DEBUG** — If verification fails or something breaks, check `patterns/INDEX.md` for a debug pattern. Follow it. Fix the issue and re-run VERIFY.
5. **GROW** — After completing the task:
   - If no pattern exists for this task type, create one in `patterns/` using the format in `patterns/README.md`. Add it to `patterns/INDEX.md`. Flag it: "Created `patterns/<name>.md` from this session."
   - If a pattern exists but you deviated from it or discovered a new gotcha, update it with what you learned.
   - If any `context/` file is now out of date because of this work, update it surgically — do not rewrite entire files.
   - Update the "Current Project State" section above if the work was significant.
