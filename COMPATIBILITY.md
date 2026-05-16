# Compatibility & versioning

This document defines `mex-agent`'s public contract: what's stable, what isn't,
and what counts as a breaking change. It is intended for embedders — tools that
depend on `mex-agent` as a library — and for `mex-agent` maintainers when
shipping new versions.

If you only use the `mex` CLI, most of this still applies, but CLI flags
themselves are best-effort (see [CLI surface](#cli-surface) below).

## The public API

The only public surface is what's exported from the package entry point:

```ts
import { /* … */ } from "mex-agent";
```

Concretely, that's everything re-exported from
[`src/index.ts`](./src/index.ts):

- **Functions** — `findConfig`, `createConfig`, `appendEvent`, `readEvents`,
  `eventLogPath`, `runDriftCheck`, `parseFrontmatter`, `checkHeartbeat`,
  `runHeartbeat`.
- **Runtime constants** — `EVENT_KINDS`, `DEFAULT_STALENESS_THRESHOLDS`,
  `DEFAULT_SCAFFOLD_PATTERNS`, `DEFAULT_HEARTBEAT_PATTERNS`.
- **Types** — `MexConfig`, `CreateConfigInput`, `EventEntry`, `EventKind`,
  `LogOpts`, `DriftReport`, `DriftIssue`, `RunDriftCheckOpts`,
  `HeartbeatResult`, `HeartbeatOpts`, `CheckHeartbeatOpts`,
  `StalenessThresholds`, `WatchConfig`, `HeartbeatConfig`, `AiTool`,
  `IssueCode`, `Severity`, `ScaffoldFrontmatter`, `FrontmatterEdge`, `Claim`,
  `ClaimKind`.

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

Inside the `.mex/` scaffold directory, some paths are owned by `mex-agent`
itself, and some are reserved for embedders.

### Owned by mex (mex writes, scans, or manages these)

- `ROUTER.md`, `AGENTS.md`, `SETUP.md`, `SYNC.md` — top-level scaffold files.
- `context/*.md` — context documents (scanned by drift checkers).
- `patterns/*.md` — pattern documents (scanned by drift checkers).
- `events/decisions.jsonl` — append-only event log.
- `config.json` — persisted scaffold configuration.

Embedders should not write to these paths.

### Reserved for embedders

These paths are not scanned by default checkers and `mex-agent` will not write
to them. Embedders may use them freely:

- `.mex/traces/**` — long-form decision traces.
- `.mex/failures/**` — failure / postmortem records.

Other paths under `.mex/` are unclaimed. If you're an embedder and need a new
namespace, open an issue first — `mex-agent` may add features later that
conflict otherwise.

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

Concrete example: if `foo` is deprecated in 0.5.0, it still works in 0.5.x and
0.6.x. It may be removed in 0.7.0 or 1.0.0.

## Reporting compatibility issues

If you find behaviour that diverges from this document — an undocumented
breaking change, an unclear case, or a contract you need that isn't covered —
open an issue at <https://github.com/theDakshJaitly/mex/issues>.
