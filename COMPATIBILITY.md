# Compatibility & versioning

## Runtime requirement

mex 0.8.x requires Node.js 22.5 or newer. The code graph and the wiki index use
the built-in `node:sqlite` module; older Node releases are unsupported.

Users who cannot upgrade Node can remain on mex v0.6.3, which supports Node.js
20 or newer. Note what that costs: the code graph shipped in 0.7.0, so v0.6.3
has no `mex graph`, no `mex impact`, and no code-node grounding. It is a
scaffold-and-drift-checking release, not an older version of the same feature
set.

### SQLite FTS5

**A supported Node version is necessary but not sufficient.** Both databases
need SQLite's FTS5 full-text extension, and `node:sqlite` embeds whatever
SQLite the Node binary was built with. FTS5 is a compile-time option that Node
does not document or guarantee, so whether you have it depends on the *build*,
not the version number alone — official builds, distro packages, and
self-compiled Node can differ at the same version.

Check the Node you actually run in one command:

```console
$ node --no-warnings -e "new (require('node:sqlite').DatabaseSync)(':memory:').exec('CREATE VIRTUAL TABLE t USING fts5(x)')" && echo "FTS5 ok"
```

Silence plus `FTS5 ok` means you are fine. `no such module: fts5` means that
Node build cannot run the graph or the wiki index; install a different build or
version of Node. mex preflights this itself, so `mex graph` and
`mex wiki rebuild-index` name the problem and your Node version rather than
failing with a bare SQLite error.

Known data points, which are reports rather than a supported-range claim:

| Node | Platform | FTS5 |
|---|---|---|
| 23.10.0 | Windows 11 | missing ([#110](https://github.com/mex-memory/mex/issues/110)) |
| 24.11.0 | Windows 11 | present |

`engines` stays at `>=22.5`: FTS5 does not track version order, so narrowing
the range would lock out working builds without excluding broken ones. If you
hit a build without it, please add it to the table via issue #110 — the sample
is small, and that is the only thing that would justify a floor.

This document defines `mex-agent`'s public contract: what's stable, what isn't,
and what counts as a breaking change. It is intended for embedders — tools that
depend on `mex-agent` as a library — and for `mex-agent` maintainers when
shipping new versions.

If you only use the `mex` CLI, most of this still applies, but CLI flags
themselves are best-effort (see [CLI surface](#cli-surface) below).

## Upgrading to 0.8.3

Install `mex-agent@0.8.3`. In a project with an existing code graph, keep that
index and run:

```bash
mex graph refresh
mex sync
```

The first refresh performs a full extraction using `typescript-5.9-v5`.
TypeScript signatures now use stable module paths and canonical type ordering,
so some node IDs change. Refresh uses the old graph to retain identity aliases;
sync can then rewrite affected `grounds_to` entries and inline `mex://` anchors.
Review the changes and any ambiguous or missing groundings before committing the
scaffold through Git. Do not delete or rebuild a working old graph as the first
upgrade step. If status reports an incompatible or damaged store, follow its
explicit recovery action; a fresh clone or rebuild without the old graph must
reconcile from committed fingerprints and may need manual re-grounding.

Refresh the Wiki index with `mex wiki rebuild-index` if the scaffold changed.
Graph schema remains v4; refresh adds an internal per-file extraction cache.
Canonical Wiki and Relay artifact versions remain unchanged. Ordinary reads
never migrate, rebuild, or accept a new grounding baseline.

For project integrations managed by MEX, run `mex skills sync --dry-run`, review
any conflicts, then run `mex skills sync` and start a new agent session.
Standalone skills installed through `npx skills add mex-memory/mex` are an
alternative installer; do not overlay them on a MEX-managed integration.
Completed 0.8.0–0.8.2 setups do not need setup again solely for this upgrade.

The 0.8.2 browser behavior continues: `mex setup` opens the setup wizard and bare
`mex` opens Hub (or setup when incomplete). Use `mex setup --cli` for terminal
prompts and `mex tui` for the terminal dashboard. `setup --dry-run` remains a
read-only preview; `--no-open` and `--port` apply to browser launches.

### Additive API changes in 0.8.3

No package-root export is removed. `HeartbeatResult` adds the optional
`filesWithoutLastUpdated` field, and `IssueCode` adds `GROUNDING_UNVERIFIED`,
`GROUNDING_MIXED_SHAPE`, and `GROUNDING_MOVED_BY_NEIGHBORS`. Consumers that handle
issue codes exhaustively should handle these cases. Existing entry points and
required arguments remain unchanged.

In 0.8.3, these additive changes ship within the 0.8 release line as a scoped
exception to the usual minor-version rule for optional public fields below.
The general versioning policy is unchanged.

New **open-to-team Relays use artifact schema v4**. Upgrade teammates to 0.8.1
before exchanging these handoffs; 0.8.0 cannot read the new format. Existing
schema-v1, v2, and v3 Relays remain supported, and newly published named-recipient
Relays continue to use v3. This Relay artifact version is separate from Graph
and checkout-local database schema versions.

Tracked Markdown remains canonical. Graph/Wiki indexes and `.mex/local/` stay
checkout-local and ignored by Git. Follow the explicit action reported by
`mex graph status` after upgrading; ordinary reads never rebuild or migrate an
index. A successful agent session no longer authorizes replacing a grounding
baseline: existing baselines change only through explicit, scoped acceptance.

Telemetry now includes CLI and Hub events under one random installation UUID,
with the existing scaffold UUID and configured AI-tool names when available.
These are pseudonymous usage signals, not verified people or team sizes. Use
`mex telemetry inspect` to inspect the catalog and `mex telemetry disable` to
opt out; `DO_NOT_TRACK=1` and `MEX_TELEMETRY=0` also disable collection and
sending. See [TELEMETRY.md](TELEMETRY.md) for payloads, exclusions, and delivery
limits. Existing opt-out preferences remain effective.

### Nix source package

The source `flake.nix` takes its version from `package.json`, but its fixed
`npmDepsHash` predates the current dependency lockfile and needs regeneration
and a successful `nix build` before that package can be considered verified.
The release checks cover the npm installation path; they do not establish
Nix build support. The helper `prefetch-npm-deps package-lock.json` can compute
the dependency hash in an environment where it is available.

## The public API

The only public surface is what's exported from the package entry point:

```ts
import { /* … */ } from "mex-agent";
```

Concretely, that's everything re-exported from
[`src/index.ts`](./src/index.ts):

- **Functions** — `findConfig`, `createConfig`, `getScaffoldIdentity`,
  `appendEvent`, `readEvents`, `eventLogPath`, `runDriftCheck`,
  `parseFrontmatter`, `checkHeartbeat`, `runHeartbeat`.
- **Runtime constants** — `EVENT_KINDS`, `DEFAULT_STALENESS_THRESHOLDS`,
  `DEFAULT_SCAFFOLD_PATTERNS`, `DEFAULT_HEARTBEAT_PATTERNS`.
- **Types** — `MexConfig`, `CreateConfigInput`, `EventEntry`, `EventKind`,
  `LogOpts`, `DriftReport`, `DriftIssue`, `RunDriftCheckOpts`,
  `HeartbeatResult`, `HeartbeatOpts`, `CheckHeartbeatOpts`,
  `StalenessThresholds`, `WatchConfig`, `HeartbeatConfig`, `AiTool`,
  `ScaffoldIdentity`, `IssueCode`, `Severity`, `ScaffoldFrontmatter`,
  `FrontmatterEdge`, `Claim`, `ClaimKind`.

The CI smoke test at [`test/public-api.test.ts`](./test/public-api.test.ts)
asserts the existence and basic shape of these exports. Any change that breaks
that test is a breaking change.

## What is NOT public

Everything else. Specifically:

- All internal modules — `src/cli.ts`, `src/sync/`, `src/scanner/`,
  `src/setup/`, `src/tui.ts`, `src/watch.ts`, `src/doctor.ts`, and any other
  path not re-exported from `src/index.ts`.
- Deep imports such as `mex-agent/dist/internal.js` — the `exports` field in
  `package.json` blocks these, and they may break without notice.
- The on-disk format of internal files such as the scaffold `config.json`. Use
  the documented helpers to read and write them.

## Semver policy

`mex-agent` follows [semver](https://semver.org/) with this interpretation:

| Change                                                | Type  |
| ----------------------------------------------------- | ----- |
| Adding a new export                                   | minor |
| Adding an optional parameter to a public function     | minor |
| Adding an optional field to a public interface        | minor |
| Widening accepted input types                         | minor |
| Bug fix preserving documented behaviour               | patch |
| Internal refactor not visible from outside            | patch |
| Removing a public export                              | major |
| Renaming a public export                              | major |
| Changing a function signature (required parameters)   | major |
| Narrowing a return type or required field             | major |
| Removing a field from a public interface              | major |

While the package is on `0.x` (pre-1.0), breaking changes may ship in minor
versions, but they will still be flagged as breaking — surfaced in the
changelog, with a deprecation note where possible and migration guidance in the
PR description.

## "Soft" parts of the public API

Two exports are public *in name* but not in *contents*:

- **`DEFAULT_SCAFFOLD_PATTERNS`** — the constant continues to exist and to be
  exported, but new entries may be added in any minor version. Embedders that
  need exact behaviour should pass `scaffoldPatterns` explicitly to
  `runDriftCheck`.
- **`DEFAULT_HEARTBEAT_PATTERNS`** — same policy. Pass `scaffoldPatterns`
  explicitly to `checkHeartbeat` / `runHeartbeat` if exact behaviour matters.

These constants are exported so embedders can extend the defaults
(`[...DEFAULT_SCAFFOLD_PATTERNS, "traces/**/*.md"]`) rather than re-typing the
list. They are not a contract on the list's contents.

## Scaffold-directory ownership

### Code-node grounding

Scaffold frontmatter may include an optional `grounds_to` array. Each entry stores a graph node id and serialized fingerprint:

```yaml
grounds_to:
  - node: "function:a3f8...c21"
    fingerprint: "mh2:64:AXbN..."
```

Fingerprints are written as `mh2:64:<base64url>`. Scaffolds committed before #233 hold `mh:64:<hex>`; both are read and compared by value, and an older entry is re-encoded only when its file's groundings are rewritten. `mex graph compact-fingerprints` re-encodes them all in one explicit pass (`--dry-run` writes nothing). Versions before #233 cannot read `mh2:`, so everyone sharing a scaffold should upgrade before new groundings are committed.

An entry may also carry `bodyHash`, the hash of the node's body when it was grounded, and `codeHash`, the hash of that body's code with comments set aside, bound to the `bodyHash` it was captured with (#236). Capture writes both; neither is hand-written. When only `bodyHash` differs from the current code, `mex check` reports the info notice `GROUNDING_COMMENT_DRIFT` instead of `GROUNDING_DRIFT`.

Files without `grounds_to` retain their previous behavior. The graph database and grounding baselines under `.mex/` are internal mex data and should not be edited directly.

### Declared entity type

A scaffold file that no Wiki migration rule names may declare what it is with a root `type` key, for example `type: component` on a domain file such as `context/payments.md` (#227):

```yaml
name: payments
description: How payouts are scheduled and settled.
type: component
```

`mex wiki migrate` then adopts the file as one file-level entity of that type and moves the value to `mex.type`, removing the root key. Every Wiki-authored type except the Spec family is accepted; Spec-family entities are created through `mex inbox`. A value that is not one of those types, or that disagrees with the rule that already types the file (such as `type: guide` on `context/stack.md`), is reported and the file is left unchanged. A file without `type` behaves as before: untyped `context/*.md` files are still not adopted, and `mex check` and `mex wiki validate` now report them as `KNOWLEDGE_UNTYPED`.

The `LanguageExtractor` and `FrameworkResolver` interfaces are source-level contribution seams, not part of the public npm API, and may change between minor versions. They are intentionally not exported from `src/index.ts`.

Inside the `.mex/` scaffold directory, some paths are owned by `mex-agent`
itself, and some are reserved for embedders.

### Owned by mex (mex writes, scans, or manages these)

- `ROUTER.md`, `AGENTS.md`, `SETUP.md`, `SYNC.md` — top-level scaffold files.
- `context/*.md` — context documents (scanned by drift checkers).
- `patterns/*.md` — pattern documents (scanned by drift checkers).
- `team/members/**`, `workstreams/**`, `inbox/**`, and `relays/**` — canonical team workflow records.
- `specs/**`, `topics/**`, and `playbooks/**` — canonical Wiki and shared workflow records.
- `events/decisions.jsonl`, `events/activity/**`, and `events/operations.jsonl` — canonical event and operation records.
- `config.json` — persisted scaffold configuration.
- `.gitignore` — managed protection for checkout-local state.
- `graph.db*` and `wiki.db*` — generated Graph and Wiki indexes, including SQLite sidecars.
- `local/**` — checkout-local drafts, cursors, jobs, and signing state.

Embedders should not write to these paths.

### Reserved for embedders

These paths are not scanned by default checkers and `mex-agent` will not write
to them. Embedders may use them freely:

- `.mex/traces/**` — long-form decision traces.
- `.mex/failures/**` — failure / postmortem records.

Other paths under `.mex/` are not part of the embedder contract and may be
claimed by `mex-agent` in a later release. Open an issue before introducing a
new namespace.

## CLI surface

The `mex` CLI ships in the package, but its flag and subcommand surface is
**best-effort, not contract-bound**. The CLI is a thin wrapper over the
programmatic API; embedders should consume the programmatic API directly
rather than shell out.

If you need a CLI flag to remain stable, file an issue requesting it be
promoted to the public contract.

## Deprecation policy

When a public export is going to be removed:

1. It is marked `@deprecated` in JSDoc and noted in the changelog.
2. It remains functional for **at least one minor version** with the
   deprecation warning in place.
3. The next major version removes it.

Concrete example: if `foo` is deprecated in 0.7.0, it still works in 0.7.x. It
may be removed in 0.8.0 or 1.0.0.

## Reporting compatibility issues

If you find behaviour that diverges from this document — an undocumented
breaking change, an unclear case, or a contract you need that isn't covered —
open an issue at <https://github.com/mex-memory/mex/issues>.
