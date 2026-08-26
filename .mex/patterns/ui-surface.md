---
name: ui-surface
description: How to add or extend a user-facing surface (web dashboard, TUI, CLI command) without duplicating engine logic. Use when a task adds a view, endpoint, or command that presents project state.
triggers:
  - "web ui"
  - "dashboard"
  - "mex ui"
  - "new endpoint"
  - "new cli command"
  - "new panel"
edges:
  - target: "context/architecture.md"
    condition: "when deciding which engine module a new surface should read from"
  - target: "context/conventions.md"
    condition: "before writing code, for naming and error-handling conventions"
last_updated: 2026-08-25
---

# Adding a user-facing surface

## Context

mex is a headless engine with thin surfaces over it. The engine owns graph
construction, drift detection, scoring, setup, and fingerprinting. `.mex/`
Markdown and `.mex/graph.db` are the single source of truth.

A surface — the CLI, the Ink TUI, the web dashboard in `src/ui/` plus
`packages/mex-ui` — reads from the engine and renders. It never re-derives a
score, re-parses source, or re-implements a setup step. When a surface needs
something the engine does not expose in a usable shape, the fix is to extract
the shared logic into a headless module both callers use, not to reimplement it.
`src/setup/steps.ts` exists for exactly that reason: the interactive CLI wizard
and the web wizard drive the same functions.

## Steps

1. Find the engine entry point that already answers the question. For project
   state that is `readSnapshot`; for drift, `runDriftCheck`; for the graph,
   `GraphStore` through a read-only connection; for setup, `src/setup/steps.ts`.
2. If no reusable entry point exists, extract one. Move the logic out of the
   interactive path into a plain function that returns a result instead of
   printing it, then make the existing caller use it too. Do not fork it.
3. Add the read path. For the web UI that is a route in `src/ui/api.ts`, which
   takes a request record and returns a response record — no socket needed to
   test it.
4. Add the wire type to `packages/mex-ui/src/lib/types.ts` and a method on the
   client in `lib/api.ts`. The frontend declares its own types rather than
   importing server modules, so the bundle stays free of Node types.
5. Render it with the four states every view needs: loading, error, empty,
   loaded. `useResource` returns all four so a view never has to infer them from
   a nullable value. New web screens are views under `packages/mex-ui/src/views`,
   registered in `lib/nav.ts`, and swapped inside `AppShell` — the sidebar stays
   put. Dashboard stays glanceable; put detail on the dedicated view.
6. For anything that can take more than a second, make it a job via
   `JobRegistry` rather than a blocking request. Declare the steps up front so
   the whole checklist renders from the first frame.

## Gotchas

- **Reading must not write.** Use `findConfig`, not `loadConfig`: the latter
  backfills a scaffold identity, which would make opening a dashboard mutate the
  project. Any new side-effect-free command also belongs in
  `SIDE_EFFECT_FREE_COMMANDS` in `src/cli.ts` so it emits no telemetry and skips
  the first-run notice.
- **A missing graph is a state, not an error.** `graph.db` may be absent or
  built by an incompatible schema version. Both must render as a first-class
  view with a call to action. Never let a `GraphRebuildRequiredError` reach the
  user as a 500.
- **Non-JS assets do not get bundled.** tsup bundles JS only. Anything else —
  `schema.sql`, grammar WASMs, the built frontend — needs an explicit copy step
  in `scripts/` and a resolver that probes both the source and installed
  layouts, the way `src/graph/assets.ts` and `src/ui/assets.ts` do. Shipping
  without the copy step is the classic way to publish a broken release.
- **Keep CLI startup cheap.** `src/cli.ts` imports must stay light; pull heavy
  modules in behind `await import()` inside the action. Constants the help text
  needs live in a dependency-free module (`src/ui/defaults.ts`).
- **Degrade per step, not per operation.** An unavailable scanner or graph must
  not fail setup. Report it on its own step and continue, which is what the
  interactive CLI already does.
- **Grounding is a two-party contract.** The agent authors `grounds_to` entries
  and `mex://` anchors; mex fingerprints the code they point at. The web wizard
  has no agent session to wait on, so capture is an explicit follow-up job that
  calls `captureGroundingBaselines` — never a second implementation. Zero
  captured after a successful job is a real outcome (the agent wrote prose, not
  grounding), not a silent success. Refuse capture with 409 when there is no
  scaffold or no graph; a job that reports zero baselines is worse than an
  explanation.
- **Setup is an ordered path, not a pile of cards.** For code-repo the UI always
  runs scaffold → code graph → agent population → capture grounding. The agent
  prompt stays locked until `graph.db` exists; never offer “skip graph” next to
  “paste this into your agent.” `SetupJourney` on the wizard finish screen and
  on Setup (when returning mid-flight) is the single sequence users follow.
- **Empty states match the companion, not a landing page.** The no-`.mex/`
  screen is left-aligned and dense like the rest of the dashboard. A centered
  logo-plus-three-cards hero reads as a template, not as a panel you keep open
  while coding.
- **Graph builds must stay chatty.** `createGraphEngine({ onProgress })`
  reports discover/compile/extract/publish phases; the UI job layer maps that
  onto `updateStep` so SSE keeps moving. Never call `engine.build()` from a UI
  job without that hook — a silent multi-minute spinner is how users think the
  process died.
- **Don't occupy the event loop before the 202 flushes.** Job bodies are
  `setImmediate`'d so the browser gets the job id and can open SSE. A long
  scan or graph build that never awaits will still freeze progress frames —
  yield before those steps, and seed the wizard from the POST snapshot so it
  never sits on "Starting setup…" with a running job.

## Verify

- [ ] `npm run typecheck` and `npm run build` both pass
- [ ] `npm test` passes; new modules have tests that exercise real files on disk
      rather than mocks
- [ ] Opening the surface on a project with no `.mex/` produces a guided path
      forward, not an error
- [ ] Opening it on a project with a broken `.mex/` explains what is wrong
- [ ] No new file re-implements engine logic — every fact on screen traces to an
      engine call
- [ ] Reading changed nothing: `git status` in a test project is clean after a
      read-only session

## Debug

- Blank page or 503 from the web UI: the frontend was not built. Run
  `npm run build:ui`; `mex ui` says so on the page and in its banner.
- Endpoint 500s where a 409 was expected: the handler is not going through the
  `withConfig` wrapper that turns a missing scaffold into a structured error.
- Progress stops updating mid-job: the SSE stream closed. The client falls back
  to polling only while the job is still running, so check the last frame's
  status before suspecting the transport.
- Assets missing from a published package: check the copy script ran and that
  `package.json` `files` covers the output directory.
- Setup is blocked with "this is the mex repository": you pointed the UI at this
  checkout. Run `npm run sandbox` instead.

## Update Scaffold
- [ ] Update `.mex/ROUTER.md` "Current Project State" if what's working/not built has changed
- [ ] Update any `.mex/context/` files that are now out of date
- [ ] If this is a new task type without a pattern, create one in `.mex/patterns/` and add to `INDEX.md`
