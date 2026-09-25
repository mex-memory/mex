---
name: release-readme-visuals
description: Refresh the release README without losing community links, release boundaries, or readable architecture visuals.
triggers:
  - "README redesign"
  - "README badges"
  - "release diagrams"
edges:
  - target: "context/architecture.md"
    condition: "when selecting the relationships a diagram must preserve"
  - target: "context/conventions.md"
    condition: "when verifying documentation and asset changes"
last_updated: 2026-09-25
mex:
  id: mx_01M1V9D2FQZYY5AP60RRXXH8YE
  type: pattern
  status: promoted
  revision: 4
  title: release-readme-visuals
  relations:
    - type: related_to
      target: mx_01M1M0CJ5C5XQV0HM5VM787WQS
      note: when selecting the relationships a diagram must preserve
    - type: related_to
      target: mx_01M1M0CJ9460AT00V8TH0QCKAC
      note: when verifying documentation and asset changes
---

# Release README Visuals

## Context

Use the exact published release as the product-behavior authority. Current
checkout context can include later work. The root `README.md` uses a shared
banner and eight SVG illustrations in `docs/diagrams/readme/` for setup,
architecture, Git sharing, Hub, grounding, context routing, Inbox, and Relay.

## Steps

1. Inspect the working tree and preserve existing edits. Inventory the current
   badges, language links, community invitation, and section anchors before a rewrite.
2. Keep all badge categories and the prominent Discord invitation unless asked
   to remove them. Use live statistics, and qualify unpublished integrations;
   the 0.8 MCP badge links to a source-only explanation.
3. Reduce each diagram to one relationship or a short workflow. Explain edge
   cases in adjacent prose and retain descriptive Markdown alt text.
4. For the 0.8 visual family, use a 1200 × 520 SVG canvas, blue `#226483`, cream
   `#F1EEDC`, black `#171B18`, and red `#FF5738`. Use restrained grain, cream
   wireframe geometry, a serif headline, and readable sans-serif labels.
5. Keep SVGs self-contained: no scripts, external fonts, embedded remote images,
   or browser-only HTML. Include a title, description, and accessible image role.
6. Preview the illustrations together and in context on light and dark pages.

## Shared header banner

Use the unnumbered `banner.svg` at 1200 × 420 in all four README headers. Keep
the cream lowercase wordmark, subtle quarter-circle tiles, and the diagrams'
blue, black, and red wireframe style. Keep prose outside the SVG so each README
can translate its tagline. The banner image belongs inside one accessible
`h1` with `id="mex"` and `alt="MEX"`, replacing the separate mascot and plain
heading without changing badges, language links, or the community invitation.

## Team-memory narrative

Lead with the team's knowledge and a concrete two-engineer handoff before
describing indexes and implementation. The preferred reading order is shared
memory, a Relay example, the human-facing Hub, setup, then architecture and
agent/workflow details. Keep plate numbering aligned with the reading order.

Separate introducing MEX to a repository from joining a completed, committed
0.8 setup. Teammates reuse canonical knowledge and the selected agent assets;
they build local indexes with `graph rebuild` and `wiki rebuild-index`, then
open Hub and check their effective Member identity. Adding another supported
skill integration can use an explicit `skills sync --tool` preview and apply.
Older or incomplete scaffolds belong in upgrade guidance, not this joining path.

## Keep translations aligned

Use the current English `README.md` as the translation source for
`README.zh-CN.md`, `README.es.md`, and `README.pt-BR.md`. Translate the full
narrative and caveats, including image descriptions, while reusing the shared
SVGs. Keep executable examples, versions, flags, paths, and skill invocations
unchanged. Preserve badge URLs, Discord, language navigation, tables, details,
and admonitions; mark the current language as active.

Localized headings need stable explicit anchors wherever English fragment
links are reused. Compare section order, code blocks, inline command tokens,
table rows, and asset/link targets against English so a translation cannot
quietly retain obsolete features or drop a sharing/approval boundary.

## Gotchas

- Do not let a simplified Git arrow imply automatic commit, push, or pull.
- Distinguish checkout-local drafts from canonical proposals and approved Specs.
- Keep human approval explicit; a Relay is a durable handoff, not chat.
- A code-change signal prompts review; it does not prove that a claim is wrong.
- Preserve badge anchors when moving their target sections into details blocks.
- Ordinary Wiki updates do not all require Inbox approval. Keep the governed
  Spec path distinct from normal working-tree review.
- Team-first language must still explain that each Hub is local and each
  canonical transition needs manual Git sharing; it is not live collaboration.
- Present standalone skill installers as alternatives to MEX-managed skills,
  not a second setup step. External installers can replace the managed skill
  directories or ownership metadata, making later MEX setup or sync refuse them.

## Verify

- Validate SVG XML, local asset links, alt text, and all restored badge categories.
- Check for clipped labels, low-contrast text, and remaining obsolete diagrams.
- Run `git diff --check` and the applicable repository verification checklist.
- Leave unrelated worktree changes and generated files unstaged.

## Debug

For missing images, check relative paths and XML validity first. For visual
failures, inspect the SVG as an image rather than assuming an inline SVG preview
matches Markdown rendering. For broken badge jumps, check explicit anchor IDs.

## Update Scaffold

- Update this pattern when the README visual conventions change.
- Update architecture or Router state only if product behavior actually changes.
- Documentation visuals have no code-symbol grounding; do not invent fingerprints.
