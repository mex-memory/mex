---
name: hub-first-run-onboarding
description: Add or change the checkout-local first-run Hub tour without mixing it into setup.
triggers:
  - onboarding
  - first-run
  - Hub tour
  - welcome tour
edges:
  - target: patterns/secure-local-project-hub.md
    condition: when the tour needs a new Hub API, session field, or job
  - target: patterns/usage-telemetry.md
    condition: when considering a capture for tour open, skip, or completion
  - target: context/conventions.md
    condition: before changing Hub page or dialog tests
grounds_to: []
last_updated: 2026-09-13
---

# Hub first-run onboarding

## Context

The setup wizard already greets incomplete checkouts. The first-run tour is
different: it appears only after the full dashboard mounts, once per checkout.
Completion lives in `.mex/local/hub-onboarding.json`, the same class of
checkout-local preference as agent logging. It doesn't use `localStorage`,
because the Hub binds a new loopback port on each launch and browser storage is
scoped per origin.

Mount the tour from `HubOnboarding` inside `HubLayout`. Do not render it from
`SetupLayout`.

## Steps

1. Keep the tour out of setup. Incomplete checkouts stay on the setup welcome
   until the listener is promoted. The setup-only Hub leaves the onboarding
   services unimplemented, so its route answers as unavailable.
2. Read completion through `GET /api/v1/settings/onboarding` and record it with
   `POST` `{ completed: true }`. `src/hub/onboarding.ts` owns the file: reads
   never initialize state, the write is idempotent under a contained lock, and
   a malformed file fails closed instead of reopening the tour.
3. Wait until the Home/Overview shell query settles before opening the first
   visit, so the copy can name the repository when the shell knows it. Auto-open
   at most once per mount, so a failed completion write never reopens it, and
   keep the tour closed when the state can't be read.
4. The tour is a spotlight overlay on the live dashboard, not a modal that
   inerts the page. It marks real sidebar targets with `data-onboarding` and
   force-opens the group being explained. Close, skip, Escape, and backdrop
   dismiss all complete the tour. Replay from Settings opens it again without
   writing completion.
5. Do not add a telemetry event for the tour unless an explicit catalog change
   is requested.
6. Existing flows run as a returning checkout. The development fixture defaults
   to completed, and first-run tests opt in with `onboardingFixture: "first-run"`.
   The release benchmark seeds `hub-onboarding.json` in each fixture scaffold.
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
- Browser `localStorage` does not survive a Hub relaunch: `startHubNodeServer`
  listens on `options.port ?? 0`. Keep launch-stable preferences checkout-local.
- Steps without a feature list render no body. Don't add filler notes about the
  overlay; the spotlight explains itself.

## Verify

- First visit opens the tour; skip or finish writes `hub-onboarding.json`.
- Completed checkout state leaves the dashboard without a dialog, across Hub
  relaunches on different ports.
- Settings replay reopens the tour without another write.
- A first-run read leaves `.mex/local` absent; the route rejects missing
  session, wrong Origin/CSRF, and malformed or extra fields.
- Setup welcome still says "Build a Hub for this checkout" and has no tour
  dialog.
- Focused hub-web onboarding, settings, App route, and
  `src/hub/__tests__/onboarding-settings.test.ts` pass.

## Debug

- If every test suddenly sees a dialog, the fixture no longer defaults
  `onboardingFixture` to completed.
- If Settings has no Replay control, `HubOnboarding` is not wrapping
  `HubLayout`.
- If the tour reopens on every launch, completion is being read from browser
  storage again instead of `/api/v1/settings/onboarding`.
- If the tour names "this checkout" forever, the shell query never became
  ready or the repository name was empty.

## Update Scaffold

- [x] Update `.mex/ROUTER.md` "Current Project State" if what's working/not built has changed
- [x] Update any `.mex/context/` files that are now out of date
- [x] If this is a new task type without a pattern, create one in `.mex/patterns/` and add to `INDEX.md`
