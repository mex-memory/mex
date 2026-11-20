<!-- Tracked .mex excerpts from mex-memory/mex at 515e034a, paired with oss67-mex-rules.json. -->

## .mex/context/conventions.md (94–101)

## Patterns

- **Read paths are immutable.** Inspect through read-only/immutable sessions and return stable structured errors; creation, migration, repair, refresh, and rebuild belong to explicit write paths.
- **Preview before canonical mutation.** Validate a closed request, emit an exact signed/revision-bound preview, then apply only that reviewed envelope after revalidation. Keep Git publication separate.
- **Bound every layer.** Cap corpus scans, bytes, rows, diagnostics, cursors, source bodies, subscribers, jobs, and serialized responses—not only the returned page size.
- **Project through allowlists.** Do not serialize storage rows, errors, Git output, filesystem details, prompts, or private metadata directly into CLI/Hub responses.
- **Preserve the last trustworthy state.** Build maintenance candidates separately, revalidate all authority and provenance at publication, and atomically replace only after success.


## .mex/context/decisions.md (77–83)

### Keep internal application boundaries out of the npm API
**Date recorded:** 2026-09-03
**Status:** Active
**Decision:** Only exports from `src/index.ts` are public; Hub and Team workflow contracts remain internal until deliberately promoted.
**Reasoning:** Internal ports can evolve with their consumers without accidentally becoming a compatibility promise to external embedders.
**Alternatives considered:** Deep/public exports for every useful internal adapter were rejected because they widen semver and declaration obligations prematurely.
**Consequences:** New internal functionality should use repository-local imports and conformance tests; a package-root export requires an explicit compatibility decision and public API test update.

## .mex/ROUTER.md (319–341)

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

## .mex/ROUTER.md (411–450)

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

## .mex/patterns/contract-first-external-adapter.md (55–71)


## Gotchas

- A mock can prove consumer semantics, but not real parsing, atomic filesystem
  replacement, symlink containment, index recovery, or graph provenance.
- Handler-level serializer goldens are not full-process CLI goldens.
- A parser may read another lane's canonical Markdown without becoming its
  mutation owner; keep writers path-partitioned.
- Index inspection and ordinary reads must not perform hidden refreshes.
- Lexical path validation is insufficient at a filesystem boundary; adapters
  must also enforce realpath containment.
- A real adapter needs a generation-bound read session, not a sequence of safe
  individual queries. Buffer the whole projection, then revalidate the bound
  database and canonical corpus before returning it.
- Keep semantic entity revisions separate from exact containing-file hashes.
  CRLF/LF or BOM-only changes can preserve meaning while invalidating byte
  offsets and optimistic file expectations.

## .mex/patterns/fresh-graph-hub-integration.md (44–73)

## Context

The Hub composition in
[`runHubCommand()`](mex://function:188820af31f0d74c6518f6926f559877)
is a consumer of the internal `GraphPort`, not another graph engine.
Graph reads may return source only after proving that indexed facts, the
published snapshot, and the exact live source bytes describe one repository
observation. Graph maintenance is a separate, explicit user action. The Hub
must not open graph SQLite directly, shell out to `mex graph`, fuse rankings,
or make Wiki availability appear real.

## Steps

1. Bind one package-private repository adapter through
   [`createRepositoryGraphPort()`](mex://function:9099fdd7e5562f7507cc7e80a6d67f1e).
   Implement the frozen `GraphPort` by calling Lane A modules directly; do not add a package-
   root export, raw SQLite callback, or public CLI subprocess. Production Hub
   maintenance selects Lane A's private candidate process; read paths retain
   their existing immutable-session contract.
2. Route every graph-derived response through the complete freshness handshake:
   inspect a stable `fresh` graph, adopt one inode-bound immutable SQLite
   session, read graph facts and hash-matched contained source, build the whole
   bounded response in memory, revalidate database/snapshot/source freshness,
   and only then release it. Discard the complete response on any final mismatch.
3. Batch facts that must agree. Search symbols and sources through one
   `searchBundle()` session; assemble symbol identity, source, and the selected
   callers/callees/impact view through one `readSymbolWorkspace()` session.
4. Preserve engine order and scores. Keep Wiki, symbol, and source groups
   separate, with independent cursors and group-local cursor failures. Never
   rerank graph output or fuse scores across domains.

## .mex/patterns/release-preparation.md (25–44)

## Steps

1. Inspect Git status and preserve unrelated edits before switching or pulling
   an authorized branch. Record any preservation stash so it can be recovered.
2. Compare current main with the last published GitHub tag and npm dist-tag.
   A version in package metadata does not establish publication.
3. Check CI on the exact intended commit, including Node 22/24, platform,
   browser, packed-install, evaluator, and pinned performance coverage.
4. Reconcile changes merged after the preparation PR into the release scope.
   Move applicable Unreleased entries into the selected version, preserve older
   release records, and use the intended publication date.
5. Verify actual Graph/Wiki schema versions and extractor identities against
   upgrade prose. Update the English README and the translations' upgrade
   paragraphs together. Preserve whole-team fingerprint compatibility guidance.
6. Build and inspect a package in an isolated temporary copy with its own
   dependencies. Build workspace contracts before typechecking a source archive
   without generated declarations. Keep the original `dist/` intact for running
   setup/Hub processes.
7. Record verification and pending actions in the release plan. Leave tagging,
   npm publication, and GitHub release creation pending until authorized.

## .mex/patterns/safe-graph-snapshot-evolution.md (111–122)

  before opening is insufficient; revalidate around and after graph use.
- A live WAL may contain the current schema while the main file looks stale or
  corrupt. Treat writer activity as transient/degraded, never durable damage.
- `PRAGMA quick_check` does not prove application compatibility. FTS shadow
  tables, fingerprint JSON, LSH bands, ownership, and dangling references need
  explicit invariants.
- A schema version integer is not lineage proof. When independently developed
  stores reused version 3, migration had to inspect the complete compact
  fingerprint/LSH and generalized-grounding shapes before choosing a lossless
  v4 path. Partial or ambiguous shapes require rebuild rather than inference.
- Source bytes can change A→B→A while a compiler runs. Final source hashing alone
  cannot detect facts extracted from B; extraction must be bound to A.

## .mex/patterns/local-first-team-state.md (117–139)

- Inbox proposals are review artifacts, not a Wiki knowledge category. Apply
  corrections to existing entities and append proposal/evidence sources while
  retaining original producer attribution and grounding baselines. Routine
  non-Spec Wiki/GROW upkeep does not require Inbox.
- A stable Wiki read can represent an already stale index. Target discovery for
  a correction must require fresh status in the same immutable observation as
  the returned text and revisions; a separate earlier status check is not enough.
- An open-to-team Relay audience must remain a rule, not a snapshot of today's
  Members. Check current active identity at Take; preserve omitted audience as
  legacy named intent. A recipient-free local draft must never silently broaden
  named publication. Reactivation restores the same Member ID and revalidates
  alias uniqueness without rewriting prior actors or selecting that Member.
- A CLI shortcut that internally previews and applies still needs exact restart
  authority. Local draft publication and journal intent are separate transactions:
  persist the complete signed preview privately before apply, reuse it for an
  interrupted same-operation retry, and remove only its exact bytes after success.
  Bound pending count and bytes; never replace a conflicting receipt, silently
  evict pending operations, or put draft content into the metadata-only journal.
- Generic file reads and replacements default to exact bytes. Only known
  canonical Team codecs opt into uniform CRLF-to-LF conversion; Wiki files,
  operation ledgers, and local receipts retain exact revisions. Compare tracked
  config with checkout conversion applied only to that comparison, then recheck
  its exact revision. Reading an absent preference must not initialize state.
