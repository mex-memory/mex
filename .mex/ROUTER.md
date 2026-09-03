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
last_updated: 2026-09-02
---

# Session Bootstrap

If you haven't already read `AGENTS.md`, read it now — it contains the project identity, non-negotiables, and commands.

Then read this file fully before doing anything else in this session.

## Current Project State

**Working:**
- Fresh-user setup is now a release-complete path: it preserves authored
  scaffold files, protects disposable Graph/Wiki/local state from Git, launches
  the first selected available Claude Code or Codex CLI from the repository
  root, captures grounding, migrates and indexes Wiki content, validates the
  result, and prints the required canonical commit checkpoint before Hub.
- MEX v0.7.3 graph extraction and protocol-v3 JSONL behavior, including
  sequential TypeScript programs, compiler crash isolation, explicit WASM tree
  disposal, compact fingerprints/LSH, and bounded repair.
- Graph schema v4 combines v0.7.3's compact store with subject-generalized Wiki
  grounding. Explicit locked maintenance recognizes both historical v3
  lineages; ordinary reads never migrate or repair a store.
- Internal human-team application contracts, ownership rules, and stable error
  codes are available under `src/team/contracts` as a provisional boundary.
- A behavioral WikiPort mock, realistic fixture, reusable conformance suite,
  and graph protocol goldens cover the consumer-side Checkpoint 0 work.
- Lane C provides internal canonical team-member/activity artifacts, actor
  resolution, bounded read-only Git access, legacy timeline normalization, and
  local configured-member/Catch Up cursor state. These remain non-public.
- Lane B provides the loopback-only Project Hub, secure browser-session
  bootstrap, bounded `/api/v1` contracts, persistent local job orchestration,
  packaged React shell, and honest Home/Search/Health/Jobs states.
- The Project Hub now presents Lane C's immutable MEX records and
  Project notes through a bounded, read-only Activity timeline. Recorded actors
  remain immutable while current alias resolution is shown separately;
  schema-v2 workflow/custom origin and optional labels are projected without
  rewriting schema-v1 history.
- Versioned graph snapshot provenance and read-only freshness inspection gate
  grounding in check, doctor, and dashboard flows without implicit graph sync.
- Grounding carries its change signal in Markdown: `grounds_to[].bodyHash` is
  optional and additive, written by the capture and MOVED-repair passes from the
  graph's own hash, and backfilled for existing scaffolds on the next capture.
  The `_mex_grounded_source` row remains as a cache of that canonical value. The
  drift checker prefers the committed hash, falls back to the cache for a
  grounding authored before the field, and resolves the `grounds_to` key path so
  migrated scaffolds under `mex.grounds_to` are checked rather than skipped.
- Explicit graph status, refresh, and isolated rebuild/recovery commands preserve
  the last trustworthy index behind one cross-process maintenance lease.
- Targeted graph get/query/impact consumers use one provenance-bound immutable
  snapshot and discard output if graph or exact source identity changes.
- The graph half of Checkpoint 2 is working in the Project Hub: grouped symbol
  and source Search, the read-only Code workspace, structured graph Health, and
  explicit refresh/rebuild jobs all use the repository-bound GraphPort adapter.
  Hub graph reads preserve engine ranking and never maintain the index implicitly.
- Graph evaluator determinism includes semantic snapshot provenance while
  excluding only operational timestamps and Git coordinates.
- The pinned Wiki engine now has an internal repository WikiPort adapter with
  exact-byte index freshness, immutable bounded reads, strict revision-bound
  cursors, complete entity/relationship/grounding projections, pinned operation
  and migration plans, and explicit cancellable maintenance. The real adapter
  passes the consumer-owned conformance suite without skips.
- The Wiki half of Checkpoint 2 is working in the Project Hub: independent Wiki
  Search, read-only Knowledge browse/detail, explicit Code-to-Knowledge links,
  structured Wiki Health, and explicit refresh/rebuild jobs all use the real
  repository adapter. Ordinary Hub reads never repair either local index.
- Checkpoint A supplies a pinned Ubuntu 24.04/Node 22 release benchmark with
  deterministic small/medium/large fixtures, production asset closure budgets,
  Hub readiness/idle/read/browser measurements, and explicit Graph/Wiki
  maintenance and database-ratio measurements. Node 24 remains compatibility
  coverage rather than a second calibration environment.
- Hub workbenches are route-lazy, Home excludes Code/Knowledge/Activity/setup
  closures, idle job discovery is event-driven rather than polled, and browser
  pagination, query/mutation caches, terminal jobs, corpus scans, diagnostics,
  and maintenance working sets have hard bounds.
- `mex capabilities --json` provides bounded, deterministic, read-only schema-v1
  discovery for the installed Project Hub, member identity, canonical Activity
  read/record, Graph, and Wiki surfaces, plus only registered structured reads,
  previews, and explicit apply/maintenance commands that are currently safe.
  Team availability requires the exact tracked scaffold identity. Generated
  agent anchors require discovery first and structured reads. An explicit
  create/save/draft request authorizes preview and apply of that exact
  checkout-local Inbox or Relay draft; local draft deletion and canonical
  publish/approve/reject/withdraw/mark-stale/repair/take/acknowledge/close
  actions require fresh confirmation after semantic preview. Git operations
  remain separately authorized.
- Checkpoint B supplies the internal repository-bound `TeamWorkflowPort` and
  consumer-owned real conformance suite. Strict schema-v1 repositories cover
  Workstreams, Inbox proposals, Relays, Playbooks, and manual runs; team-owned
  paths are reserved from Wiki authoring while remaining readable by Wiki.
- Checkout-local `team.db` schema v4 adds bounded Inbox/Relay drafts, one
  repository workflow lease, and a metadata-only operation journal. Reads do
  not initialize storage; the first explicit mutation migrates transactionally.
- Canonical workflow publication binds service-owned actor/time/repository
  authority, exact revisions, Activity, local cleanup, and operation replay.
  Interrupted multi-file Wiki batches resume only from a bounded portable
  manifest after proving the exact durable audit prefix.
- Checkpoint C exposes bounded `mex member` and structured `mex activity`
  commands plus authenticated private Hub member/current-actor and Team
  preview/apply APIs. Member selection is checkout-local; canonical member
  mutations and direct Activity recording each emit one immutable event.
- Cross-process identity/Activity previews are authenticated by one strict
  repository-local HMAC key. Only the first explicit C preview or Hub startup
  provisions it; pure reads remain noninitializing. Activity corpus, page, and
  diagnostic bounds fail closed.
- Checkpoint D exposes bounded `mex workstream` reads and exact signed
  create/update/archive preview/apply. The private Hub adds a lazy Workstreams
  workbench and Home summary; every canonical mutation emits exactly one
  Activity and archive is one-way.
- `mex spec list|show --json` and the lazy Hub Specs workspace project only
  fresh canonical Wiki Spec roots and their explicit bounded hierarchy. These
  reads share one immutable Wiki/grounding snapshot, never refresh or rebuild an
  index, and provide no Spec mutation surface.
- Checkpoints E1-E4 implement the product-only Team Inbox and governed
  Spec authoring contract in `docs/design/inbox-spec-authoring-contract.md`:
  local draft and
  portable proposal summary/detail reads, signed exact preview/apply, one
  non-batch create or title/summary/body update per proposal, explicit
  stale/repair lifecycle, service-minted create identity, and strict
  privacy/recovery boundaries. The guarded CLI, static contract resolver,
  private Hub, lazy Inbox workbench, deterministic fixture, and release
  measurements are active. Pinned Ubuntu Inbox asset, API, and heap candidates
  are calibrated from the retained schema-valid report; a clean enforcing CI
  run remains a mandatory merge gate and cannot widen earlier thresholds.
- Checkpoints F1-F4 implement repository-native Relay handoffs: authority-free
  checkout-local drafts, standalone active-Member publication,
  first-recipient claim, sender-or-claimant close, strict schema-v1/v2/v3 reads,
  and Relay-specific signed portable preview/apply. New schema-v3 Relays omit
  Workstream and preserve the publication-time branch, HEAD, dirty flag, and
  observation time from signed authority; v1/v2 remain byte-preserving legacy
  formats. The guarded CLI and static resolver, private Hub API, lazy Relay
  workbench, deterministic two-Member fixture, and owned release measurements
  are active. Pinned Ubuntu Relay route, two Relay list API, and Relay heap
  candidates are calibrated from the retained schema-valid report; Home,
  Members, and every shared budget remain frozen. A separate clean enforcing
  run on the final exact head remains mandatory.

**Not Built:**
- Wiki migration and synthesis UI, grounding-drift/review workbenches, product
  Playbook commands and Hub routes, Catch Up actions, notifications, external
  delivery, and later checkpoints from the human-team program. The workflow
  port remains internal; Checkpoint F is the latest registered product surface.
- Public package-root exports for the provisional team contracts.

**Known Issues:**
- The current scaffold architecture, conventions, decisions, stack, and setup
  context files are still largely unpopulated placeholders.
- Development fixtures are never production data. Graph and Wiki repair controls
  appear only when a stable status observation makes the requested operation
  safe; migration-required or unstable Wiki observations never fabricate a
  repair action.
- The Wiki CLI's `serviceOptions` carries no code graph, so `wiki validate`
  cannot resolve a grounding and `wiki migrate`'s body-hash backfill never runs.
  Both degrade silently rather than failing; the validate notice now reports
  that the pass had no graph instead of asserting the checkout has none.

**Working:**
- Code graph extraction for TypeScript, TSX, JavaScript, JSX, Python, Rust, and Go
- Go language support with tree-sitter-go grammar (structs, interfaces, type aliases, functions, methods, generics, imports, calls, struct fields)
- Cross-file reference resolution and grounding

**Not yet built:**
- Framework resolvers for Go (e.g., Gin, Echo, Chi)
- Additional language extractors (Java, C#, etc.)

**Known issues:**
- None for Go extractor in current scope

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
