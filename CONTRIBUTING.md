# Contributing to mex

Thanks for your interest in contributing! Here's how to get started.

**New here?** The best starting point is an issue labeled [`good first issue`](https://github.com/theDakshJaitly/mex/labels/good%20first%20issue) — most are self-contained drift checkers, and there are 11 existing checkers to copy from. See [Adding a drift checker](#adding-a-drift-checker) below.

## Code-graph developer preview

The upcoming mex 0.7.0 code graph is being developed on `code-graph-preview`. It is not the stable release and is not published to npm. Issues for this work should be labeled `code-graph` and `developer-preview` and must state:

> Target branch: `code-graph-preview`

For any code-graph issue, create your branch from the preview branch:

```bash
git switch code-graph-preview
git pull
git switch -c <feature-or-fix-branch>
```

When opening the pull request, set:

- **Base branch:** `code-graph-preview`
- **Compare branch:** your feature or fix branch

Do not target `main` with code-graph work. `main` remains the stable v0.6.3 line until the preview has been tested, documented, and approved for release.

Changes to graph identity, reconciliation, schema, or drift semantics are core changes. Open an issue and agree on the approach before implementing them.

Language extractor and framework resolver contributors should read [Extending the code graph](docs/extractors.md) before starting. It documents the frozen interfaces, registration points, fixtures, tests, and required proof for a pull request.

## Setup

```bash
git clone https://github.com/theDakshJaitly/mex.git
cd mex
npm install
npm run build
```

## Development

```bash
npm run dev          # watch mode — rebuilds on changes
npm run test:watch   # run tests in watch mode
npm run typecheck    # type check without emitting
```

## Before submitting a PR

1. Run the full check suite:
   ```bash
   npm run typecheck && npm run test && npm run build
   ```
2. Keep changes focused — one fix or feature per PR.
3. Add tests for new checkers or bug fixes when possible.
4. Don't refactor surrounding code unless that's the point of the PR.

## Project structure

```
src/
  cli.ts              # CLI entry point (commander)
  config.ts           # Project/scaffold root detection
  drift/
    claims.ts         # Extract claims from markdown files
    checkers/         # Individual drift checkers
    scoring.ts        # Score computation
    index.ts          # Orchestrates drift check
  scanner/            # Codebase pre-scanner (used by mex init)
  sync/               # AI-targeted sync (brief builder + interactive loop)
  reporter.ts         # Terminal output formatting
test/                 # Vitest tests
```

## Adding a drift checker

New checkers are the most newcomer-friendly contribution. A checker is a small function that inspects scaffold files (or extracted claims) and returns `DriftIssue[]`. There are 11 existing checkers in `src/drift/checkers/` — pick the closest as a template.

1. **Create `src/drift/checkers/<name>.ts`.** There are two shapes:
   - **Claim-based** — operates on extracted claims, e.g. `checkPaths(claims, projectRoot, scaffoldRoot)` in `path.ts`.
   - **Structural** — operates on the scaffold directly, e.g. `checkIndexSync(projectRoot, scaffoldRoot)` in `index-sync.ts`.

   Return a `DriftIssue[]`:
   ```ts
   {
     code,                        // an IssueCode (see step 2)
     severity,                    // "error" | "warning" | "info"
     file,                        // scaffold file the issue is in
     line,                        // number | null
     message,
     claim?,                      // the claim that triggered it, if any
   }
   ```
2. **Add your `code` to the `IssueCode` union in `src/types.ts`.** It's a closed union — the build fails until your code is listed there.
3. **Register the checker in `src/drift/index.ts`:** import it, invoke it in the matching block (the per-file loop for per-file checks, or the claim/structural sections), and push its result count to `checkerIssueCounts`.
4. **Add tests to `test/checkers.test.ts`** — cover both a triggering case and a clean case.
5. **Run `npm run typecheck && npm test && npm run build`** before opening the PR.

## Reporting bugs

Open an issue using the bug report template. Include the output of `mex check --json` if relevant.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
