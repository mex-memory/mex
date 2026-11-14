# CI and releases

Require **`ci-passed`** on `next`, then on `main` at integration. It collects all
CI gating jobs, including Hub browser tests. Failed, cancelled or unexpectedly
skipped jobs fail it. One required check lets jobs change without editing branch
protection or leaving skipped matrix checks waiting forever. Do not require
advisory or path-filtered workflows.

| Workflow | Checks | Triggers |
| --- | --- | --- |
| `ci.yml` | Node 22/24 suites (two shards each), types/packages/evaluators, three-OS Go, serial portability parts, browser and workflow lint | Every PR; `next`/`main` pushes |
| `statechart-checker.yml` | Real TLC and packed skill on three OSes | Relevant source/skill/Hub/build/dependency PR paths; `next`/`main` pushes |
| `typescript-servers.yml` | Compiler-server parity on pinned repositories | Relevant PR paths; `next`/`main` pushes; manual |
| `release-performance.yml` | Pinned budgets and conditional fresh-runner confirmation | `next`/`main` pushes, 0.9 tags, manual; advisory; one tracking issue for red `next` results |
| `gates.yml` | Seven release gates and three-OS `release-gates` verdict | Called by Release; manual once on `main` |
| `release.yml` | Decisions, seven packages, three-OS registry smoke, dry/real publication | `v0.9.0*` tags; release-path PRs (always dry); manual once on `main` |
| `setup-agent-smoke.yml` | Setup with controlled fake agents | Manual |

Docs-only PRs run scope detection, a workflow-lint no-op and the aggregate. Only
Markdown under `docs/` and diagram SVGs qualify. Root Markdown ships in the
package; skill files, calibration JSON, code and workflow edits run full CI.
Renames consider both paths. Pushes run everything. PR runs replace older runs;
pushes retain a verdict per commit. Windows temporary files and caches use the
fast `RUNNER_TEMP` disk before setup actions restore caches.

For a listed flake, rerun once and investigate a second failure. Otherwise treat
a red check as a real failure and fix it. Do not widen assertions, raise budgets
or add global retries.

## Known flakes

Reserved for the reviewed list: test, same-commit failed/passed runs, tracking
issue and narrow retry. No flakes are approved by this page yet.

## Hook timing

Local runs and release gates require p95 <=17 ms, or <=3 ms above a bare process.
Ordinary CI reports shim/bare p50, p95 and max, plus the strict verdict. Its
current per-OS p50-overhead baseline lives in
`native/cmd/mex-hook/testdata/timing-baseline.json`; a regression exceeds
`max(2 * recorded overhead, recorded overhead + 3 ms, 5 ms)`. The release adapter
clears report mode and budget overrides. A reported strict failure still needs
product investigation even when ordinary CI passes.

## Release path

PR rehearsals skip the expensive gates, prove that absent same-commit evidence
refuses a real release, and say so in the summary. They build and smoke all seven
packages, run `npm publish --dry-run` in order, then print the GitHub release
command. No credentials or environment approval are needed.

Real publication is currently blocked: required gate adapters are not built and
the strict Windows timing budget is not satisfied. A rehearsal cannot certify
those gates. For a real release:

1. Commit matching root/lockfile and six platform manifest versions. Push the
   matching version tag. A mismatch stops immediately. Release calls gates once
   on that commit; every later job requires the same-commit `release-gates`
   verdict. The current gate profiles support beta.1, beta.2 and final/rc.
2. Linux builds all binaries and the production app, packs seven tarballs and
   writes `SHA256SUMS`. Checksums, versions, constraints and all six exact root
   optional dependencies are checked before publication. Each OS installs
   `mex-agent@<version>` from a read-only loopback registry containing the actual
   tarballs; public npm supplies other dependencies. npm must select only the
   host package, its native resolver/self-test must pass, and `mex --version`
   must match. There is no tarball-install shortcut.
3. A real publish waits for **`npm-publish`** environment approval. Checksum-pinned
   npm 11.6.1 publishes with provenance/public access: Linux x64/arm64, macOS
   x64/arm64, Windows x64/arm64, then `mex-agent`. Beta/rc use `next`; `0.9.0`
   uses `latest`. Existing versions are skipped on retry; registry/authentication
   errors fail. Nothing is unpublished. Failed-only reruns reuse the build artifact.
4. After npm succeeds, another job creates the GitHub pre-release (beta/rc) or
   release, attaching seven tarballs and checksums. It requires an existing tag
   and completes existing assets on retry. Releases per ref queue without cancellation.

Manual inputs default to `dry_run: true`, `require_gates: true`. Only dry runs
may set `require_gates: false`; real manual runs also need the matching existing
tag on this commit. Dispatch is unavailable until the workflow reaches `main`;
until then use a release-path PR rehearsal. Tag pushes always take the real,
gated path.

## One-time owner setup

- Require only `ci-passed`; remove the old matrix requirements. Apply to `main`
  at integration.
- Claim `mex-agent-hook-linux-x64`, `mex-agent-hook-linux-arm64`,
  `mex-agent-hook-darwin-x64`, `mex-agent-hook-darwin-arm64`,
  `mex-agent-hook-win32-x64`, `mex-agent-hook-win32-arm64`; confirm publish rights
  for these and `mex-agent`.
- Create `npm-publish` with required maintainer reviewers and release-ref restrictions.
- Configure trusted publishing for all seven packages: this repository,
  `release.yml`, environment `npm-publish`. Alternatively set an authorized
  publishing token as the environment's `NPM_TOKEN` secret (supplied as
  `NODE_AUTH_TOKEN`). Without it npm uses OIDC. Only publish requests
  `id-token: write`; only GitHub-release requests `contents: write`.
  See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) and
  [provenance](https://docs.npmjs.com/generating-provenance-statements/).
- After all six platform versions are published, commit all six exact root
  `optionalDependencies` and regenerate/test the lock with npm 10 and 11. Until
  then packing stages them without changing the checkout: npm 10 omits
  unpublished entries, while npm 11 rejects that lock or creates versionless
  placeholders. Packing always pins all six to the packed root's own version.

Keep actual tags, credentials, namespace claims and approval with the owner.
