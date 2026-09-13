---
name: hub-first-run-onboarding
description: Add or change the browser-local first-run Hub tour without mixing it into setup or checkout preferences.
triggers:
  - onboarding
  - first-run
  - Hub tour
  - welcome tour
edges:
  - target: patterns/secure-local-project-hub.md
    condition: when the tour would need a new Hub API, session field, or job
  - target: patterns/usage-telemetry.md
    condition: when considering a capture for tour open, skip, or completion
  - target: context/conventions.md
    condition: before changing Hub page or dialog tests
grounds_to: []
last_updated: 2026-09-12
---

# Hub first-run onboarding

## Context

The setup wizard already greets incomplete checkouts. The first-run tour is
different: it appears only after the full dashboard mounts, once per browser
on that device. Completion uses `localStorage`, the same class of preference as
Team Access, not checkout-local Settings like agent logging.

Mount the tour from `HubOnboarding` inside `HubLayout`. Do not render it from
`SetupLayout`.

## Steps

1. Keep the tour out of setup. Incomplete checkouts stay on the setup welcome
   until the listener is promoted.
2. Persist only `{ completed: true }` under `mex.hub.onboarding.v1`. Treat
   missing, empty, or malformed values as "not completed". Storage failures
   must not block the in-memory done state.
3. Wait until the Home/Overview shell query settles before opening the first
   visit, so the copy can name the repository when the shell knows it.
4. The tour is a spotlight overlay on the live dashboard, not a modal that
   inerts the page. It marks real sidebar targets with `data-onboarding` and
   force-opens the group being explained. Close, skip, Escape, and backdrop
   dismiss all complete the tour. Replay from Settings opens it again without
   clearing completion.
5. Do not add a Hub API, checkout-local file, or telemetry event for this
   preference unless an explicit catalog/contract change is requested.
6. Seed completed state wherever an existing flow drives a fresh browser:
   `packages/hub-web/src/test/setup.ts`, every `test/hub-e2e` spec (through
   `context.addInitScript`, since setup specs promote on a random origin), and
   the release benchmark's browser contexts. First-run tests clear the key in
   their own `beforeEach`.
7. Load `OnboardingTour` on demand. The shell mounts `HubOnboarding` on every
   route, so a static import puts the tour's JS, CSS, and mascot in the frozen
   initial-asset budget.

## Gotchas

- Do not use the modal Dialog primitive for the tour. It hides the page from
  assistive tech and defeats the point of pointing at live chrome.
- Force-open sidebar groups during the matching step so hidden System/Project
  items can be measured. Measure after that render, then again on resize.
- Object-spreading `createFixtureApi()` drops class methods. Assign setup
  methods onto the instance when a test needs the wizard.
- Overview's Context card also offers "Open Context". While the tour is open
  on Overview, scope last-step queries to the tour dialog.
- This is per browser, not per Member. Teammates and other devices still see
  the tour. The same loopback origin reused for another checkout will not.

## Verify

- First visit opens the tour; skip or finish writes `completed: true`.
- Completed storage leaves the dashboard without a dialog.
- Settings replay reopens the tour.
- Setup welcome still says "Build a Hub for this checkout" and has no tour
  dialog.
- Focused hub-web onboarding, settings, and App route tests pass.

## Debug

- If every test suddenly sees a dialog, the shared setup file is no longer
  seeding completion.
- If Settings has no Replay control, `HubOnboarding` is not wrapping
  `HubLayout`.
- If the tour names "this checkout" forever, the shell query never became
  ready or the repository name was empty.

## Update Scaffold

- [x] Update `.mex/ROUTER.md` "Current Project State" if what's working/not built has changed
- [x] Update any `.mex/context/` files that are now out of date
- [x] If this is a new task type without a pattern, create one in `.mex/patterns/` and add to `INDEX.md`
