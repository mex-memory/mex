# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added
- A bounded Next.js App Router resolver turning `app/**/route.ts|js` modules (including `src/app` roots) into route nodes: one per exported HTTP handler (`GET` through `HEAD`), with the URL path derived from the route file's directory, dynamic segments such as `[id]` and catch-alls preserved verbatim, and route groups `(marketing)` excluded the way Next resolves them. Same-file handlers resolve only when unambiguous; Pages Router, layouts, and pages stay out of scope (#95).
- Coverage reporting for source files no extractor indexes. `mex graph` now prints the recognized-but-unindexed file count grouped by extension after the build summary, with the full histogram behind `--json` as `unindexedSources`; `mex graph query` and `mex impact` add `filesIndexed` and `unindexedSources` coverage context to `TARGET_NOT_FOUND` records (only when it changes the record's meaning, so misses in fully covered repositories are unchanged); and `mex doctor` shows a Coverage line. A mixed repository used to build a complete-looking graph while every `.svelte`, `.vue` or `.go` file was silently absent, indistinguishable from an empty one (#163).

### Fixed

- `mex sync` now migrates an inline `mex://` anchor together with a `grounds_to` entry for the same moved node. The anchor used to reconcile on its own against the stored baseline instead of the refreshed frontmatter fingerprint. When that baseline was missing, or still listed a neighbour that had since been re-identified, the anchor was skipped or scored `AMBIGUOUS`, sync moved the shared baseline row anyway, and the next `mex check` reported `GROUNDING_GONE` until the link was edited by hand (#128).

## [0.8.1] - 2026-09-10

### Added

- A Context graph in the Project Hub showing existing Wiki entities,
  relationships, and direct code groundings, with type filters, selection
  details, pan/zoom, and a list alternative.
- Inbox contributions for one addition or correction to existing architecture,
  component, convention, decision, pattern, or guide knowledge. Local drafts
  publish as Git-shareable Markdown proposals; explicit approval writes the
  existing Wiki knowledge and retains contribution evidence.
- Open-to-team Relays that eligible active Members can take, including teammates
  who join later; local drafts may leave recipients undecided.
  `mex relay draft save --from <draft.json>` shortens local saving through the existing signed workflow.
  Hub and CLI show audience, current eligibility, and the sharing boundary.
- Member reactivation with the original identity, plus checkout-local agent
  logging preferences in Hub Settings and `mex logging`: `significant` (the
  quiet default), `checkpoints`, and `manual`. Managed agent instructions now
  retrieve relevant bounded Timeline notes without automatically promoting
  those notes to accepted project knowledge.
- Additive Graph ignore globs under `.mex/config.json`'s `graph.ignore`, with
  repository-relative validation that behaves consistently across platforms.
- `mex telemetry disable` and `mex telemetry enable`, writing the same `~/.mex/config.json` key as `mex config set telemetry on|off`. `mex telemetry --help` and `mex telemetry status` now name the `DO_NOT_TRACK=1` and `MEX_TELEMETRY=0` env opt-outs and say which one is in effect; previously the only switch lived under `config` and the env vars appeared solely in the first-run notice (#110).

### Changed

- Agent instructions and skills mention MEX naturally alongside useful findings
  instead of requiring a fixed acknowledgement footer or routine context-loading
  narration.
- Hub navigation centers Context, Code, Inbox, Relays, Team, and Activity.
  Specs and Workstreams leave primary navigation; existing artifacts and direct
  routes remain readable.
- Hub Graph refresh/rebuild constructs candidates in a disposable Node process,
  keeping compiler work off the Hub event loop. The parent retains validation,
  cancellation, and atomic publication. Reused SQLite statements, smaller
  temporary collections, and outer-owned fingerprint transactions reduce
  avoidable work. CLI construction remains in process; changed-source builds
  still rebuild the eligible corpus, and aggregate peak memory is not capped.
- Targeted CLI Graph reads can report useful results with explicit qualifications
  for config drift, partial parses, and excluded changed source files. Incompatible
  engine identity still refuses reads; Hub reads retain strict freshness.
  Graph config identity now uses extraction-relevant fields, so formatting and
  dependency-version-only edits no longer invalidate the index. Unparseable
  configuration still falls back to exact bytes.
- Telemetry now records namespaced CLI commands and outcomes, fixed Hub
  page/action categories, and terminal job results through a bounded local queue
  and cancellable delivery. CLI/Hub share a random installation UUID; optional
  metadata contains only an existing scaffold UUID and known configured AI-tool
  names. This supports repeat/shared-project estimates, not verified team size
  or detection of the invoking agent. Names, remotes, content, paths, search
  text, and contact details remain excluded; existing opt-outs apply.
- `mex feedback` opens the same voluntary form as the Hub's Help shape MEX card,
  without adding an analytics identity to the form URL. See [TELEMETRY.md](TELEMETRY.md)
  for the event catalog, pseudonymous identifiers, exclusions, and opt-outs.

### Fixed

- Successful agent exit no longer authorizes grounding baseline renewal.
  Interactive sync requires explicit acceptance of individual groundings and
  revalidates document/code identity; moved-symbol repair preserves prior change
  evidence instead of accepting changed behavior.
- Unknown untyped `context/*.md` files are no longer automatically classified
  as architecture. Wiki creation/synthesis preserves supplied provenance or
  records the operation's provenance; Inbox corrections retain original
  attribution and grounding alongside proposal evidence.
- Setup links selected tools to the scaffold even when their instruction files
  already exist or setup resumes without showing the selection menu. Existing
  instructions are preserved, and repository self-setup reuses saved tool
  choices while preserving authored knowledge.
- Windows artifact handling now uses exact bytes by default, with explicit
  checkout-neutral handling for canonical Team records. Wiki revisions and
  recovery stay exact, legacy Timeline IDs remain stable across LF/CRLF, and
  affected Team/Wiki ownership checks preserve full-width device/inode identity
  and replacement files during failure cleanup.
- Graph maintenance can publish otherwise valid candidates with documented
  per-file skips or incomplete parses, instead of discarding the entire build.
  Failed maintenance reports the diagnostics that blocked publication.
- `mex graph` now fails with an actionable message naming the running Node version when the built-in `node:sqlite` module lacks FTS5 support, instead of surfacing SQLite's raw `no such module: fts5` on the first schema statement that needs it. FTS5 availability is not guaranteed by every Node build/version inside the documented `engines` range (#110).
- The FTS5 preflight now covers every consumer, not only `mex graph`'s writable open: read-only and immutable graph opens (`mex check`, `graph scope`/`query`/`get`, `impact`) and the wiki index, whose `wiki_fts` table has the same dependency. `mex wiki rebuild-index` reports the new `WIKI_INDEX_FTS5_UNAVAILABLE` diagnostic rather than `WIKI_INDEX_REBUILD_REQUIRED`, which would have sent users round a loop rebuilding an index no rebuild can fix (#110).
- The wiki index's two direct read paths — contract status inspection and the read session — also preflight FTS5 now, instead of letting SQLite's raw error escape. Reachable by building the index on one Node and reading it on another (#110).
- COMPATIBILITY.md documents the FTS5 requirement, a one-line command to check the Node you actually run, and that the v0.6.3 fallback predates the code graph. The preflight's error message pointed at a document that said nothing about FTS5 (#110).
- `mex graph rebuild`/`refresh`/`repair` and `mex wiki rebuild-index` now ensure `.mex/.gitignore` exists before creating a store. Only `mex setup` did this, so building a store in a checkout that had never run setup left `graph.db`, `-wal` and `-shm` untracked, ready for the next `git add -A` to commit (#110).

### Compatibility

- New open-to-team Relays use schema v4. Teammates need MEX 0.8.1 before
  consuming those artifacts; existing named v1–v3 Relays and legacy Spec
  proposals remain supported. New named Relays continue using v3.
- The Graph store remains schema v4. Ordinary reads never migrate or repair
  indexes. Upgrading the npm package does not update project agent instructions;
  review `mex skills sync --dry-run`, then run `mex skills sync` in existing
  projects to refresh managed skills and anchors and start a new agent session.
  A completed 0.8.0 setup does not need to run again solely for this upgrade;
  follow any explicit maintenance action reported by `mex graph status`.

## [0.8.0] - 2026-09-02

### Added
- A bounded release-performance gate for local Hub startup, idle CPU/RAM,
  browser heap, API latency, maintenance working sets, asset closure, and
  Graph/Wiki database ratios, plus `mex capabilities --json` for agent-safe
  discovery of installed and currently available commands.
- An internal repository TeamWorkflowPort with strict canonical repositories,
  checkout-local state, leases, operation recovery, and conformance coverage
  for members, Activity, Workstreams, Inbox, Relays, Playbooks, and manual runs.
- Bounded Member and canonical Activity CLI/private Hub workflows with signed
  preview/apply, local actor selection, exact revisions, and immutable Activity
  emission for accepted canonical mutations.
- Bounded canonical Workstream CLI and private Hub surfaces with signed
  preview/apply for create, update, and one-way archive; each successful
  canonical mutation emits exactly one immutable Activity event.
- Fresh-index, read-only Spec CLI and Hub views over explicit Wiki hierarchy,
  provenance, sources, and grounding without implicit index maintenance.
- A governed Team Inbox and Spec-authoring workflow for local drafts, portable
  canonical proposals, explicit approval/rejection/withdrawal/repair, and exact
  single-Spec create or update through the real Wiki preview/apply boundary.
- Official `mex-inbox` and `mex-relay` project skills for Claude Code and Codex,
  installed by `mex setup` and safely refreshed with `mex skills sync` without
  overwriting user instructions, modified managed copies, or unrelated skills.

### Changed
- `mex setup` now preserves existing scaffold files, launches the first selected
  available Claude Code or Codex CLI from the project root, completes Wiki
  migration/indexing after population, and stops at an explicit Git commit
  checkpoint before Hub.
- The integration graph uses schema v4: v0.7.3's compact BLOB fingerprints and
  integer-reference LSH storage combined with subject-generalized Wiki
  grounding. The v0.7.3 sequential compiler, crash isolation, fallback, and
  WASM-tree cleanup run inside the existing immutable freshness and atomic
  publication boundaries.
- `mex graph repair` now uses the graph maintenance lease and a validated
  same-directory candidate instead of mutating the published database in place.
- Inbox and Relay contracts now support bounded action-scoped discovery while
  preserving the existing complete contract catalogs for compatibility.

### Fixed
- Fresh setup now installs and verifies ignore protection for Graph/Wiki
  databases and `.mex/local/`, refuses broad rules that hide canonical config,
  and no longer overwrites authored files merely because they contain template
  examples or date placeholders.
- Setup now refuses malformed or redirected canonical config, publishes config
  updates atomically, honors Wiki exclude/read-only scope, and blocks readiness
  when authored grounding cannot be verified.
- Claude Code and Codex population now uses an ignored prompt file with a short
  launcher argument, avoiding Windows command-line length limits.
- New Claude Code and Codex root instructions bootstrap `.mex/AGENTS.md` and
  `.mex/ROUTER.md` on later sessions instead of installing only skill policy.

### Compatibility
- Explicit graph maintenance recognizes v1, v2, released-main v3,
  integration-grounding v3, and complete hybrid v3 stores structurally. v2 and
  complete v3 lineages upgrade losslessly to schema v4; v1, partial, or
  ambiguous stores require a safe rebuild. Ordinary reads never migrate.
- Installing or upgrading the npm package only delivers the skill payload; it
  does not mutate a repository. Activation remains an explicit `mex setup` or
  `mex skills sync` action, and no plugin package is required.

## [0.7.3] - 2026-08-27

### Added
- `mex graph repair` checkpoints a stranded write-ahead log and verifies store integrity in place, so a graph left behind by an interrupted build or check no longer requires a full rebuild to recover.

### Changed
- `mex check` now reads the last published graph read-only. It never synchronizes the graph as a side effect, and reports how many source files the graph is behind instead of silently re-staging the corpus.
- TypeScript projects are extracted one at a time, with each compiler program released before the next is created, instead of holding every project's program and type checker in memory simultaneously.
- Graph stores use schema v3, a compact encoding of the fingerprint and locality-sensitive-hashing tables: binary MinHash sketches, integer band hashes, integer fingerprint references, and the composite primary key as the only index.
- The per-file semantic type-check pass is now opt-in. Parser health has always been derived from syntactic diagnostics, and reference resolution uses the type checker directly, so the full semantic pass only added diagnostic detail at a cost that scaled with the installed dependency surface.
- Discovered TypeScript projects are configured with `skipLibCheck` and `noEmit`, because extraction needs symbol and type queries rather than a full compile.

### Fixed
- A malformed source file that triggers an internal TypeScript compiler assertion no longer aborts the entire graph build. The affected project is isolated and its files fall back to Tree-sitter extraction.
- Two same-identity declarations in one TypeScript or JavaScript file no longer abort corpus staging with a duplicate node id; they are ordinal-disambiguated, matching the existing Python and Rust extractors.
- Tree-sitter parse trees are released after extraction. They are allocated in the WebAssembly heap and were never reclaimed, so every parsed file leaked for the lifetime of the process.
- Grammars are now loaded for compiler-language files that compiler extraction could not stage, so the Tree-sitter fallback can actually extract them.

### Performance
- On a 3,254-file multi-project repository, peak resident memory during a graph build fell from 5.17 GB to 2.11 GB and wall-clock time fell from 448 s to 309 s, with byte-identical graph output.
- Graph stores are roughly 36-40% smaller: 700.1 MB to 451.1 MB on that repository, and 269.8 MB to 162.9 MB on a 494-file repository. The fingerprint and LSH tables themselves shrank by about 86% and are no longer the largest consumer in a store.
- A drift check on a repository with edited sources no longer pays graph-staging cost at all, because `mex check` no longer stages.

### Compatibility
- Node.js 22.5 or newer remains required.
- Schema-v2 `.mex/graph.db` files migrate to v3 losslessly the next time a writing command runs (`mex graph`, `mex sync`, `mex graph ground`). No rebuild is required and existing groundings continue to resolve. Read-only commands report the usual rebuild guidance until that migration has run.
- Schema-v1 stores still require a one-time `mex graph` rebuild, unchanged from 0.7.2.
- Serialized `mh:64:` grounding anchors in scaffold Markdown are unchanged; no scaffold edits are needed.
- Graph output is unchanged by this release except for the TypeScript project isolation and duplicate-identity fixes, which add nodes and edges that previously aborted or were absent. The compiler extractor version advances, so the first `mex graph` after upgrading performs a full rebuild.

## [0.7.2] - 2026-08-20

### Added
- Compiler-backed TypeScript extraction now resolves calls, imports, inheritance, containment, and callback flow with stable declaration identities, while retaining bounded Tree-sitter support for TypeScript, JavaScript, Python, and Rust.
- Source-chunk search, parser-health metadata, graph-integrity reporting, and deterministic native holdouts for Hono, TypeScript's compiler subtree, MEX, and mixed-language fixtures.
- Evidence-aware JSONL protocol v3 records for source ranges, directed execution flows, summaries, omissions, and trustworthy fallback guidance.

### Changed
- `mex graph scope` now defaults to bounded source-backed retrieval instead of a minimal manifest, prioritizing the most relevant declarations and real high-confidence execution paths in the first response.
- Scope budgets adapt to repository size, enforce file/node/flow/source ceilings, and distinguish mandatory evidence from optional truncation.
- TypeScript 5.9.3 is now an exact runtime dependency because graph construction uses the compiler API.
- CI verifies Node.js 22 and 24, runs the evaluator tests on Node 22, and uses Node 24-based GitHub Actions.
- Tool-config sync ignores unmarked user-authored files and reports the actual managed config that moved.

### Fixed
- Stale or unreadable source files can no longer silently erase trusted graph state; changed-file failures abort publication and preserve the last good graph.
- Callback synthesis no longer maps extra arguments onto a non-rest final parameter, and rest callbacks are linked only when the corresponding indexed element is invoked.
- Retrieval now preserves compiler-proven cross-file flows, source-aligned declarations, whole primary answers, and fair source allocation without manufacturing relationships or exceeding the output ledger.
- Deterministic identity, duplicate/dangling-edge, FTS, confidence, parser-loss, and production-to-test integrity checks fail closed in the evaluation harness.
- Headless comparison runs now enforce exact command permissions, subject/bundle identity, rate-limit-safe resume semantics, and blind answer grading.

### Performance
- In a descriptive 24-session, 12-task Claude Sonnet pilot against a files-only baseline, the candidate answered 7/12 tasks correctly versus 6/12 while reducing new tokens by 54.5%, processed tokens by 72.5%, estimated cost by 56.6%, and mean latency by 22.9%.
- First responses returned 22/23 required source spans, all required Hono flows, and graph evidence for all 12 tasks. The pilot used one repetition per task and did not include the released `main` implementation as an arm.

### Compatibility
- Node.js 22.5 or newer remains required.
- Existing schema-v1 `.mex/graph.db` files require a one-time `mex graph` rebuild; the Markdown scaffold itself does not need to be reset.
- The richer graph currently uses more disk than 0.7.1. Incremental/no-op rebuild and storage optimization are deferred to a follow-up release.

## [0.7.1] - 2026-08-05

### Changed
- Agent guidance in the shipped tool configs now describes when to use each graph command, rather than preferring graph commands over text search in all cases. `mex graph query` and `mex graph get` lead when a symbol name is known — they are exact and typically 200-500 output tokens. `mex graph scope` is positioned as a starting point for unfamiliar tasks, with an explicit note that it matches on words rather than meaning, so a task phrased in vocabulary the code does not use will return weak results.
- Agents are now told to fall back to Grep/Glob when a scope manifest does not contain what they need, and to rephrase a scope task at most once. The previous wording discouraged text search, which could lead an agent to spend additional calls expanding a manifest that was not going to answer the question.
- Applied to `AGENTS.md`, `CLAUDE.md`, `.cursorrules`, `.windsurfrules`, and `.github/copilot-instructions.md`.

### Note for existing scaffolds
Upgrading does not modify an existing `.mex/` scaffold. To pick up the new guidance, replace the `## Code Graph` section of your tool config files with the version in `templates/AGENTS.md`.

## [0.7.0] - 2026-07-25

### Added
- Deterministic local SQLite code graph for TypeScript, TSX, JavaScript, JSX, Python, and Rust, including cross-file resolution, body hashes, MinHash fingerprints, and LSH reconciliation.
- Twelfth drift checker for `grounds_to` code-node grounding, with drift, gone, ambiguous, and durable moved-node repair behavior.
- Inline `mex://<node-id>` anchors for navigable symbol mentions, including warning-only drift detection and durable sync repair.
- `mex graph`, `mex graph scope`, `mex graph query`, `mex graph get`, and `mex impact` commands for graph building, compact task-neighborhood retrieval, structural lookup, targeted source expansion, and blast-radius analysis.
- `mex graph ground` for idempotently retro-grounding populated pre-0.7 scaffolds while preserving their prose.
- Express reference resolver that links route registrations to handler nodes.
- Fresh setup now builds and consumes the graph, authors tight `grounds_to` entries and load-bearing inline anchors, and captures grounding baselines immediately.
- A deterministic JSONL agent protocol with explicit detail levels, scored selection reasons, stable ordering, node quotas, and a hard estimated-output-token ceiling.
- Reproducible retrieval and agent evaluation harnesses under `evaluate/`.

### Changed
- Minimum Node.js version is now 22.5 because the graph uses the built-in `node:sqlite` module.
- The mex repository's own scaffold moved from the legacy root layout into `.mex/`; published user scaffolds continue to come from `templates/`.
- Agent tool-config templates now explain graph queries, impact analysis, and ambiguous-grounding adjudication.
- Setup, migration, and sync follow “read broad, ground tight”: broad context stays sparse while behavioral patterns ground to the specific implementing symbols.
- Sync repairs prose and refreshes both frontmatter grounding and inline anchors after body drift, moves, deletions, or ambiguous reconciliation.
- Telemetry delivery failures are silent so offline analytics cannot pollute JSON or JSONL command output.
- Agent retrieval defaults to compact `minimal` facts; source is opt-in through `--detail source` or fetched for exact node ids with `mex graph get`.
- The direct `glob` dependency is updated to v13, with patched minimatch and brace-expansion transitive releases.

### Fixed
- External-content FTS5 indexing remains consistent across duplicate node ids and clean installed-package builds, preventing graph-build corruption seen during real setup testing.
- Grounding baselines are captured after setup and migration as well as sync, so the first post-authoring body edit emits `GROUNDING_DRIFT` without a hand-seeded snapshot.
- Retrieval output now enforces its configured budget while emitting, avoids over-expanding broad symbols, and remains byte-deterministic across equivalent graph rebuilds.
- Full graph builds and incremental change discovery now include registered Rust `.rs` files; the packed-install smoke test covers TypeScript, Python, and Rust.

### Performance
- On the mex benchmark corpus, the median grep-top-3-to-scope estimated-output ratio was **10.74×** while `mex graph scope` retained **1.0 expected-symbol recall** across six symbol tasks.
- A five-task real-agent comparison answered all tasks correctly with both retrieval detail modes. The default `minimal` mode used targeted `graph get` expansion and required no Read/Grep fallback; `source` fell back on four of five tasks.
- These are small-N, single-repository measurements. They do not establish an end-to-end graph-vs-no-graph token-savings claim.

### Compatibility
- Existing scaffolds without grounding or `.mex/graph.db` continue to run the original filesystem and lexical checks unchanged; upgrade with `mex graph` followed by `mex graph ground`.
- Graph interfaces are source-level contribution seams, not public npm API exports.

## [0.6.3] - 2026-07-06

### Added
- **MCP server** — new `packages/mex-mcp` package exposes mex to AI agents over the Model Context Protocol as native tool calls: `mex_check`, `mex_log`, `mex_timeline`, `mex_heartbeat`, and `mex_read_file`. It imports the `mex-agent` public API directly (no subprocess) and returns structured JSON, so agents in Claude Code, Cursor, and other MCP clients call mex as first-class tools instead of shelling out. Every tool takes an optional `projectRoot` (defaults to cwd) and `mex_read_file` is sandboxed to the `.mex/` scaffold. `mex_sync` is deferred until its structured return shape is settled. [#84](https://github.com/mex-memory/mex/pull/84) [#81](https://github.com/mex-memory/mex/issues/81)

### Changed
- README documents the MCP server, its five tools, and client (`.mcp.json`) configuration.

### Compatibility
- No changes to the published `mex-agent` package surface or the `.mex/` scaffold. `packages/mex-mcp` is not yet published to npm; build it from the repo with `npm run build --workspace mex-mcp` and point your MCP client at `packages/mex-mcp/dist/index.js`.

## [0.6.2] - 2026-06-22

### Fixed
- **Windows AI-CLI detection and launch** — `mex sync` and `mex setup` now detect an installed AI CLI on Windows and launch it correctly. Detection used `which` (absent on Windows), so every tool reported as not installed and interactive mode silently fell back to copy-paste even when Claude Code/Codex were present; it now probes with `where` on Windows. Launch used `spawn`/`spawnSync`, which threw `ENOENT` on the `claude.cmd` wrapper; it now uses `cross-spawn`. `runToolInteractive` also no longer treats a spawn failure or timeout as a successful session. [#85](https://github.com/mex-memory/mex/issues/85)
- **Cross-platform path output and global config** — drift issue paths, heartbeat stale files, scanner entries, and event-log paths are normalized to forward slashes on Windows (new `toPosix()` boundary), fixing a `patterns/` severity check that silently misfired; global config and telemetry id now respect Windows `USERPROFILE`, with a new `MEX_HOME` override. [#78](https://github.com/mex-memory/mex/pull/78)
- **checkPaths false positives** — `checkPaths` now only validates inline code paths from `ROUTER.md`, not all scaffold files. Eliminates false `MISSING_PATH` errors from context docs, pattern files, and tool config files where backtick-wrapped strings are config values, IPs, annotation keys, or other non-path content. [#79](https://github.com/mex-memory/mex/issues/79)
- **Package version metadata guard** — the CLI validates that `package.json` contains a non-empty string `version` before reading it at runtime. [#58](https://github.com/mex-memory/mex/issues/58)

## [0.6.1] - 2026-06-14

### Added
- **Event log provenance/lifecycle fields** — `EventEntry` now accepts two optional, free-form string fields: `source` (where an event came from, e.g. `meeting`, `manual`, `agent`) and `status` (decision lifecycle, e.g. `decided`, `implemented`). Both are written only when provided and are preserved by `mex timeline` (including `--json`). `kind` stays a closed enum; `status` is deliberately ungated so unrecognized values are never dropped. Exposed via `appendEvent` (the in-process API) and optional `mex log --source`/`--status` flags. Entries without these fields are unchanged.

## [0.6.0] - 2026-06-09

### Added
- **Feedback command** — `mex feedback` opens a hosted form for users to opt in to maintainer user-research calls. A quiet, dismissible one-line invite appears after a successful `check`/`sync` and in the `mex` TUI (TTY-only, shown a few times then stops). The CLI never reads or transmits an email — it only opens the URL. Hide it with `mex config set feedback off`. Kept fully separate from telemetry.
- **Anonymous telemetry** — opt-out usage counting via PostHog. Each command sends one event with only `machine_id`, `scaffold_id`, `command` name, `mex_version`, `os`, and `node_version` — no args, paths, file contents, repo names, IP, or location. Opt out with `DO_NOT_TRACK=1`, `MEX_TELEMETRY=0`, or `mex config set telemetry off`. Audit the exact payload with `mex telemetry inspect`; check state with `mex telemetry status`. Telemetry is disabled automatically when running from a clone of the mex repo. See [TELEMETRY.md](TELEMETRY.md).
- **Scaffold identity** — the scaffold's `config.json` now carries a stable `scaffold_id` (UUID v4), `scaffold_name`, and nullable `origin`/`upstream`. Generated at `mex setup` and silently backfilled for existing scaffolds on the next CLI invocation. New `getScaffoldIdentity()` export on the public API.
- **broken-link drift checker** — flags Markdown links in scaffold files whose local target file does not exist.

### Changed
- README and CONTRIBUTING now list all 11 drift checkers (including `tool-config-sync`, `todo-fixme`, and `broken-link`).

## [0.3.5] - 2026-05-14

### Added
- **Package rename** — the npm package is now `mex-agent`; the installed binary command remains `mex`.
- **Agent memory mode** — `mex setup --mode agent-memory` creates templates for persistent-agent, homelab, OpenClaw-style, and operational-memory workspaces.
- **Heartbeat checks** — `mex heartbeat` runs lightweight scheduled health checks over optional `last_updated` frontmatter, stale context, memory cleanup metadata, and old daily memory files.
- **Scheduled heartbeat loop** — `mex watch --interval` runs heartbeat repeatedly in the foreground while preserving the existing post-commit hook behavior for plain `mex watch`.
- **Event log** — `mex log` appends notes, decisions, risks, and todos to `.mex/events/decisions.jsonl`.
- **Timeline** — `mex timeline` reads recent event entries, with `--json` for scripting.
- **Doctor command** — `mex doctor` summarizes scaffold health across drift, heartbeat, config, and events.
- **Interactive TUI** — bare `mex` and `mex tui` open an Ink terminal dashboard with drift score, heartbeat status, event activity, timeline/log actions, and a bordered action panel.
- **Shell completions** — `mex completion bash|zsh|fish` prints completion scripts.
- **Config tuning** — optional `.mex/config.json` supports staleness thresholds, heartbeat thresholds, and watch interval defaults.

### Changed
- `mex check` output is grouped by severity with clearer remediation hints.
- `mex check --json` provides a script-friendly report shape.
- Scaffold templates now include `last_updated` frontmatter guidance and a GROW loop that encourages logging rationale with `mex log`.
- Agent-memory templates frame mex as three-layer memory: state memory in scaffold files, procedural memory in patterns, and event memory in JSONL logs.
- README documents the TUI, agent-memory mode, heartbeat, config, and the OpenClaw/persistent-agent use case.

### Compatibility
- No scaffold migration is required.
- `last_updated` is optional; files without it are ignored by heartbeat staleness checks.
- `.mex/config.json` is optional; missing values use defaults.
- `.mex/events/` is created only when events are logged.
- The TUI is additive; all existing CLI commands remain available and script-friendly.

### Deferred
- Context routing command.
- Full schema migration with ids/requires fields.
- Federation / hierarchical scaffolds.
- Bidirectional state-event references.
- Dynamic domain nodes via Tree-sitter.

## [0.3.4] - 2026-04-07

### Changed
- **Simplified install flow** — `npx promexeus setup` now offers to install globally at the end, so `mex check` and `mex sync` just work
- Users who skip global install get clear `npx promexeus` commands as the fallback
- Removed dev-dependency + package.json scripts instructions — one canonical flow, not three
- README install section rewritten: setup → global install prompt → done
- Fixed wrong package name (`mex-cli`) in post-setup instructions
- `mex commands` output cleaned up: removed shell scripts section, shows `npx promexeus` fallback

## [0.2.0] - 2026-04-05

### Added
- **`mex setup` command** — npx-first install replaces git clone + bash script. One command: `npx promexeus setup`
- Bundled scaffold templates in npm package (`templates/` directory)
- Interactive tool config selection (Claude Code, Cursor, Windsurf, GitHub Copilot)
- Project state detection: fresh, existing, or partial scaffold
- Codebase pre-scanner integration during setup
- `--dry-run` flag for setup command
- Published to npm as `promexeus`

### Fixed
- False positive `DEPENDENCY_MISSING` warnings for versioned dependencies with semver prefixes (`^`, `~`, `>=`)

### Changed
- Package renamed from `mex` to `promexeus` for npm availability
- Sync now sends all drift issues to Claude in a single session instead of one session per file — reduces token usage and eliminates repeated session restarts
- README updated: npx is now the primary install method, git clone is the alternative

## [0.1.0] - 2026-03-21

### Added
- Initial release
- 8 drift checkers: path, edges, index-sync, staleness, command, dependency, cross-file, script-coverage
- `mex check` with `--quiet`, `--json`, `--fix` flags
- `mex sync` with interactive and prompt modes, dry-run support
- `mex init` codebase pre-scanner
- `mex watch` post-commit hook
- `setup.sh` for first-time scaffold population
- `sync.sh` interactive menu
- Multi-tool support (Claude Code, Cursor, Windsurf, GitHub Copilot)
