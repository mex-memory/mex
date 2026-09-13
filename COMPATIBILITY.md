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

## Upgrading to 0.8.2

Install `mex-agent@0.8.2`, then run `mex skills sync --dry-run` and
`mex skills sync` in each project whose managed agent skills and instructions
you want to update. Review conflicts with locally edited instructions and start
a new agent session afterward. An already completed 0.8.0 or 0.8.1 setup does not need
to run setup again just for this package upgrade. Installing the package alone
does not change the repository.

In 0.8.2, `mex setup` opens the browser setup wizard and bare `mex` opens
Hub (or setup when incomplete). Terminal users and scripts should use
`mex setup --cli`; `mex tui` keeps the terminal dashboard. `setup --dry-run`
remains a read-only terminal preview. `--no-open` and `--port` apply to browser
launches. Optional global installation pins the running version. No public
package exports or Graph/Wiki/Relay storage formats change in this release.

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
    fingerprint: "mh:64:9f2a..."
```

Files without `grounds_to` retain their previous behavior. The graph database and grounding baselines under `.mex/` are internal mex data and should not be edited directly.

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
