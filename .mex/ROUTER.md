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
  - target: patterns/release-readme-visuals.md
    condition: when refreshing the release README, badges, community links, or architecture illustrations
last_updated: 2026-09-12
---

# Session Bootstrap

If you haven't already read `AGENTS.md`, read it now — it contains the project identity, non-negotiables, and commands.

Then read this file fully before doing anything else in this session.

## Current Project State

**Working:**
- Incomplete checkouts open a Hub setup wizard from `mex hub` instead of the
  full dashboard. Setup begins on a welcome screen, then runs the same ordered
  `mex setup` steps through a headless engine, pauses at population with a
  copyable prompt when no selected CLI is available. Claude/Codex population
  runs as a cancellable background process; failures surface safe diagnostics.
  Headless Claude pre-approves only the read-only graph, impact, and event-log
  `mex` commands (Bash and PowerShell); other commands are still denied.
  Finalization failures show their authored remediation in the Hub.
  Both tools stream their visible assistant messages and compact fixed tool
  activity labels to a read-only view with bounded scrollback, elapsed time,
  and honest quiet periods. Commands, arguments, paths, and tool results are
  omitted from the tool stream. History stays in process memory and reconnects
  through cursor pages.
  Mode and empty tool choices survive refresh. New code projects show a bounded
  setup-file diff with numbered, highlighted additions/removals and an explicit
  local commit action before in-place Hub promotion; the commit preserves
  unrelated staged work and never pushes. The review lists per-file counts and
  loads each file's diff on expand from the retained snapshot (128 Ki characters
  per file, 1 Mi per review); any truncated diff still forces a manual commit.
  Unsupported Git configurations retain the manual checkpoint. Setup never
  runs git init, while Agent-memory completes without Graph or Wiki. Existing
  committed code projects retain Hub Health recovery for missing local indexes.
- The MEX repository now dogfoods the ordinary `mex setup` path. Resumed setup
  reuses persisted AI-tool selection even while population is incomplete, and
  existing-codebase prompts merge missing knowledge without replacing authored
  Router, AGENTS, context, or pattern content.
- Canonical Team state includes the active Member `theDakshJaitly` and its
  immutable `member.added` Activity record. These Git-tracked records become
  visible in collaborators' Hubs after commit, push, and pull; effective Member
  selection remains checkout-local.
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
  optional and additive, written during initial capture or an explicitly
  accepted per-entry sync review from the graph's own hash. Legacy backfill
  preserves an existing cached baseline, and MOVED repairs carry earlier change
  evidence forward rather than accepting the new body.
  The `_mex_grounded_source` row remains as a cache of that canonical value. The
  drift checker prefers the committed hash, falls back to the cache for a
  grounding authored before the field, and resolves the `grounds_to` key path so
  migrated scaffolds under `mex.grounds_to` are checked rather than skipped.
- The first 0.8.1 release phase is implemented on `codex/0.8.1`: successful
  agent exit no longer authorizes baseline renewal. Interactive sync offers
  bounded default-no review of individual groundings, releases the graph lease
  before asking, and revalidates document bytes and graph facts before applying.
  All planned release phases are implemented; the current main integration,
  validation status, and remaining release preparation are tracked in
  `docs/design/0.8.1-release-plan.md`.
- Phase 2 adds a graph-first Context Hub at `/knowledge`, with every usual
  Wiki entity (including unlinked sections), recorded relationships, and direct
  code groundings expanding on selection. The list and full-record routes remain
  readable. Bounded private graph/code projections never maintain indexes;
  completed Graph/Wiki jobs invalidate the Context caches. Home and primary
  navigation now emphasize Context, Code, Relays, and Activity while legacy
  workflow routes remain readable. Overview keeps the two-column atlas and
  original Attention queue. A compact Context doorway sits above the atlas
  for everyday return visits; first-run welcome stays on Setup. The From mex
  waitlist remains under Latest team memory. Local
  verification is recorded in the
  same release plan; this is local implementation, not a published release.
- Phase 2b extends Inbox into an explicit contribution workflow for existing
  Wiki knowledge: architecture, component, convention, decision, pattern, and
  guide additions or text corrections, including existing section entities.
  Local drafts publish as Markdown proposals; approval writes existing
  `context/` or `patterns/` knowledge and carries the proposal source/evidence.
  Original attribution and grounding survive corrections. Legacy Spec payloads
  and signed recovery remain supported; ordinary GROW upkeep remains direct.
  Inbox and its review count are restored in primary navigation; Team sits with
  Relays/Activity. The agent skill searches existing knowledge and uses the
  fresh, bounded `mex inbox target <id> --json` lookup for exact correction
  revisions. This is working-tree implementation, not a published release.
- Phase 3 adds explicit open-to-team Relays, including future active Members,
  while preserving named v3 and earlier artifact/recovery formats. New team
  handoffs use schema v4; local drafts may defer recipient selection. Hub and
  CLI show the audience, current eligibility, and working-tree/Git boundary.
  `mex relay draft save --from <draft.json>` saves a local draft through the
  existing signed workflow, retaining a bounded private preview before apply
  so an interrupted save can resume exactly. Explicit Member reactivation
  preserves the original identity and older handoffs. This is local
  implementation on `codex/0.8.1`; release gates remain in the release plan.
- Phase 4 adds checkout-local agent logging preferences through `mex logging`
  and Hub Settings, with a quiet significant-events default and managed
  instructions for relevant bounded Timeline retrieval. Timeline filters now
  honor type, message, and recorded files without initializing project/global
  identity. Unknown untyped context files abstain during Wiki migration.
  Ordinary Wiki creation/synthesis retain explicit provenance or capture the
  operation actor/time/session; completed plain creates replay without duplicate
  records. Legacy Team/Spec recovery bytes stay unchanged. This is local
  implementation on `codex/0.8.1`. The three missing Settings heap limits are now
  calibrated from retained pinned Linux run `34286120355`; subsequent enforcing
  CI passed, as recorded below. Evidence is in
  `docs/design/settings-heap-calibration.json`. The separately accepted Graph
  isolation timing calibration below changes only its five owned time limits.
- Phase 5 narrows shared artifact I/O to exact bytes by default, with explicit
  checkout-neutral reads for canonical Team records. Wiki/local revisions remain
  exact through Inbox preview and recovery; legacy Timeline IDs remain stable
  across LF/CRLF. The four corrected Wiki ownership boundaries and shared Team
  artifact locks retain full-width device/inode IDs and preserve replacement
  files during failure cleanup. The expanded Windows/macOS CI job supplies real
  platform verification; current results and remaining gates are in the release
  plan. Graph extraction, public exports, and on-disk schemas are unchanged.
- The completed release phases are shared on `codex/0.8.1` in draft PR #176.
  Main's subsequent Graph/FTS5 fixes are integrated; the release plan records
  the import-only conflict resolution and distinguishes this main sync from
  the isolated Windows changes. Runner verification is attached to the PR.
- Explicit graph status, refresh, and isolated rebuild/recovery commands preserve
  the last trustworthy index behind one cross-process maintenance lease.
- Graph performance work is implemented separately on
  `codex/0.8.1-graph-performance`: outer-owned fingerprint publication, fixed
  statement reuse, smaller continuity/reference staging, and disposable Hub
  candidate construction. The parent retains validation and publication;
  ordinary CLI construction remains in process. Implementation, verification,
  and actual Hub measurements are in
  `docs/design/code-graph-performance-implementation.md`. This targets the
  release branch and is not a published release.
- Corrected graph performance PR #180 run `34288560611` passed Node 22/24,
  browser, and Windows/macOS portability checks. Two independent pinned runners
  confirmed five material Graph timing failures. The product decision accepts
  disposable-worker startup latency for a responsive Hub and compiler-memory
  release after jobs. Only those five time limits are recalibrated from retained
  pinned evidence in `docs/design/graph-maintenance-timing-calibration.json`;
  all memory and other limits stay unchanged. A clean enforcing run on the new
  calibrated head remains required. Local same-code memory/latency evidence is
  retained in `docs/design/graph-isolation-diagnostic.json`.
- Graph performance PR #180 passed the final checks (run `34291831733`) and
  merged into `codex/0.8.1` as `d64f171`; the preceding calibration notes are
  historical. Main remains separate.
- Telemetry v2, developed on `codex/0.8.1-telemetry`, merged through PR #188
  into `codex/0.8.1` as `0ad565d`. Final head `a37277b` passed all required
  checks in run `34378404972`, including Windows and release performance.
  Local verification and latency evidence for the initial implementation and
  approved project-context follow-up remain in `docs/design/telemetry-v2.md`.
  The approved random installation UUID is shared
  across CLI and Hub. The user additionally approved existing scaffold UUIDs
  for shared-project estimates and configured AI-tool names from project setup;
  these cannot establish team size or identify the invoking agent. The bounded
  reader never creates or repairs project identity. Content, paths, queries,
  names, repository remotes, and contact data remain outside the event catalog.
  Namespaced CLI outcomes, explicit Hub actions/pages, and terminal jobs use a
  bounded per-user queue and cancellable delivery. Pure discovery/read commands
  remain quiet. CLI feedback uses the existing Hub hosted form without an
  analytics identity.
- The authorized main sync incorporates 18 upstream commits through
  `bc2d40a5b3db15fc27d9d2ee19ca642050bccc04` into `codex/0.8.1`.
  Three catch-block conflicts in `src/cli.ts` combine upstream detailed Graph
  diagnostics with the release branch's `process.exitCode`/return behavior. Upstream
  degraded Graph reads and extraction-relevant config identity are retained;
  Hub reads keep strict freshness and isolated candidate publication keeps its
  parent-owned authority checks. Build, typecheck, 257 focused tests, and 85
  evaluator tests pass. Full regression passed 3,668 tests with one skip and
  four timeouts; all four passed a serial rerun at unchanged limits. The
  release-plan addendum records this evidence. Merge `465c192` passed Node
  22/24 and Windows/macOS CI; browser/performance setup failed twice on an
  unused Google Chrome apt repository checksum mismatch before tests ran.
  CI now removes its legacy `.list` and newer `.sources` entries before
  installing Playwright's own Chromium. Final head `0118536` passed all
  required checks in run `34385511415`, including browser and release
  performance. Main was not updated by this sync.
- Release preparation for 0.8.1 is authorized on `codex/0.8.1`: root package
  metadata and capability goldens now use 0.8.1, and changelog/release notes
  describe the complete release. Install examples and compatibility guidance
  cover managed skill refresh, Relay-v4 teammate upgrades, FTS5, and telemetry.
  Translations retain an explicit older-narrative notice while their upgrade
  commands and compatibility warnings are refreshed. Verification and sharing
  state are tracked in `docs/design/0.8.1-release-plan.md`; merging to main,
  tagging, and publication remain outside this checkpoint.
- Targeted graph get/query/impact consumers use one provenance-bound immutable
  snapshot and discard output if graph or exact source identity changes.
- Graph reads separate engine identity from bounded, reportable shortfalls. A
  store built by incompatible code still refuses every read. A store whose
  config inputs drifted, whose files parsed partially, or whose indexed source
  changed is answered and labelled: resolved edges are marked stale under config
  drift, an incomplete parse reports its affected files, and drifted source is
  excluded by an exhaustive path set the response names. Definitions,
  containment and verified source stay unlabelled. Scope classifies through the
  same predicate and refuses through the same record while keeping its own
  per-file text-only fallback.
- Publication applies the same judgement: a candidate whose only fault is a
  skipped or partially parsed file is published rather than discarded, and a
  failed maintenance run reports the diagnostics that blocked it.
- Config inputs are identified by the fields that affect extraction rather than
  by raw bytes, so a dependency bump or a reformat no longer invalidates an
  index; anything unparseable falls back to exact bytes.
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
- Graph construction still rebuilds the full eligible corpus after source
  changes and has no peak-memory quota. The branch's actual Hub probe peaked at
  about 1,963 MiB combined RSS and retained multi-second pauses around initial
  checks and validation/publication despite responsive compiler-phase polling.
  Fatal parent exit may leave owned temporary artifacts. The historical
  `docs/design/code-graph-resource-investigation.md` explains the bottleneck and
  retained-memory experiments; neither it nor the implementation rules out all
  native, slow, or repository-specific leaks. Process isolation can increase
  aggregate peak memory even while reducing memory left in the surviving Hub.
  PR #180's final platform, browser, and release-performance checks passed after
  the accepted five-leaf timing calibration; each later integration requires
  its own verification.
- Graph schema v4 is operational in this checkout, with two partially parsed
  source files and no failed files. Treat partial graph evidence as degraded and
  narrow or fall back to source discovery when needed.
- Development fixtures are never production data. Graph and Wiki repair controls
  appear only when a stable status observation makes the requested operation
  safe; migration-required or unstable Wiki observations never fabricate a
  repair action.
- The Wiki CLI's `serviceOptions` carries no code graph, so `wiki validate`
  cannot resolve a grounding and `wiki migrate`'s body-hash backfill never runs.
  Both degrade silently rather than failing; the validate notice now reports
  that the pass had no graph instead of asserting the checkout has none.

## Routing Table

Load the relevant file based on the current task. Always load `context/architecture.md` first if not already in context this session.

| Task type | Load |
|-----------|------|
| Understanding how the system works | `context/architecture.md` |
| Working with a specific technology | `context/stack.md` |
| Writing or reviewing code | `context/conventions.md` |
| Making a design decision | `context/decisions.md` |
| Setting up or running the project | `context/setup.md` |
| Refreshing the release README or visuals | `patterns/release-readme-visuals.md` |
| Any specific task | Check `patterns/INDEX.md` for a matching pattern |

## Behavioural Contract

For every task, follow this loop:

1. **CONTEXT** — Load the relevant context file(s) from the routing table above. Check `patterns/INDEX.md` for a matching pattern. If one exists, follow it.
2. **BUILD** — Do the work. If a pattern exists, follow its Steps. If you are about to deviate from an established pattern, say so before writing any code — state the deviation and why.
3. **VERIFY** — Load `context/conventions.md` and run the Verify Checklist item by item. State each item and whether the output passes. Do not summarise — enumerate explicitly.
4. **DEBUG** — If verification fails or something breaks, check `patterns/INDEX.md` for a debug pattern. Follow it. Fix the issue and re-run VERIFY.
5. **GROW** — After completing the task:
   - If no pattern exists for this task type, create one in `patterns/` using the format in `patterns/README.md`. Add it to `patterns/INDEX.md`. Flag it: "Created `patterns/<name>.md` from this session."
   - If a pattern exists but you deviated from it or discovered a new gotcha, update it with what you learned.
   - If any `context/` file is now out of date because of this work, update it surgically — do not rewrite entire files.
   - Update the "Current Project State" section above if the work was significant.
