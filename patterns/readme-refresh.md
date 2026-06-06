---
name: readme-refresh
description: Refreshing the project README, screenshots, and explanatory diagrams.
triggers:
  - "README"
  - "screenshot"
  - "diagram"
  - "sponsor"
  - "docs polish"
edges:
  - target: context/conventions.md
    condition: when checking repository style and verification expectations
last_updated: 2026-05-22
---

# README Refresh

## Context

The README is the public product surface for mex. Keep the mascot and ASCII banner because they give the project identity, but make the rest of the page quick to understand for new users, contributors, and potential sponsors.

## Steps

1. Preserve the top identity block: mascot, ASCII art, badges, and short project positioning.
2. Put one strong screenshot near the top; avoid stacking many terminal screenshots.
3. Use diagrams for explanation-heavy sections, preferably with editable `.excalidraw` source plus README-ready SVG.
4. Keep provider or sponsor language neutral unless a partnership is finalized.
5. Move social proof after the core onboarding flow so it does not interrupt installation or understanding.

## Gotchas

- The npm package is `mex-agent`, but the installed CLI command is `mex`.
- README images should use repo-relative paths so they render on GitHub and npm.
- GitHub renders fenced code blocks inside centered HTML as full-width blocks; use an image/SVG asset for centered ASCII-style banners.
- Only add badges for things that are true and maintained by the repo: package, downloads, stars, license, CI, runtime, language, documented compatibility.
- Sponsor sections should not imply a default provider or exclusive recommendation unless that is a deliberate project decision.
- If a diagram is committed as SVG, also commit the editable source file so future polish does not require recreating it.

## Verify

- [ ] `README.md` references only files that exist in the repo.
- [ ] The first screen explains what mex does, how to install it, and shows a visual.
- [ ] Diagrams have editable source files next to exported assets.
- [ ] No sponsor/provider claim overstates a finalized relationship.
- [ ] Existing public links such as `CONTRIBUTING.md`, `CHANGELOG.md`, and `LICENSE` still resolve.

## Debug

- If an image does not render on GitHub, check path casing and whether the asset is committed.
- If npm rendering differs from GitHub, prefer simple Markdown or HTML image tags with repo-relative paths.
- If a diagram feels too small in the README, increase the SVG canvas rather than shrinking labels.

## Update Scaffold

- [ ] Update this pattern when the README structure or asset strategy changes.
- [ ] Add any recurring sponsor/integration policy decisions to `context/decisions.md` if they become project policy.
