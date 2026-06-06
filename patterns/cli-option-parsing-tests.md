---
name: cli-option-parsing-tests
description: Add or update Commander option parsing tests without invoking the real CLI entrypoint.
triggers:
  - "cli test"
  - "commander"
  - "option parsing"
  - "parseAsync"
edges:
  - target: "context/conventions.md"
    condition: "when adding or naming tests"
last_updated: 2026-05-21
---

# CLI Option Parsing Tests

## Context
`src/cli.ts` auto-parses only when invoked as the main script (`import.meta.url === pathToFileURL(process.argv[1]).href`). Do not import its `program` object in tests. If parser helpers must be imported from `src/cli.ts`, set `process.argv[1]` to a non-matching path during the dynamic import and suppress console output so the guard stays false.

## Steps
1. Export narrow parser helpers from `src/cli.ts` when direct unit coverage is needed.
2. Build a fresh `Command` in the test file for the command under test.
3. Mirror the production command wiring closely, but inject a test config and mock dynamic handler imports such as `../src/events.js`.
4. Use `parseAsync(["node", "mex", ...])` to exercise Commander parsing in-process.

## Gotchas
- Commander wraps `InvalidArgumentError` from custom parsers as a `CommanderError` during `parseAsync` when `exitOverride()` is enabled.
- Repeatable options need the same accumulator callback and default value as production code.
- Handler-level validation can still be tested with mocked handlers that reject, while keeping tests disk-free.

## Verify
- [ ] Direct parser tests cover accepted and rejected values.
- [ ] CLI fixture tests assert the exact options passed to the mocked handler.
- [ ] Invalid parser input asserts `commander.invalidArgument` or the useful message.
- [ ] Run `npm run typecheck` and `npm test`.

## Debug
If a CLI test unexpectedly exits or prints help, confirm the fixture uses `exitOverride()` and `configureOutput()`, and that `src/cli.ts` was not statically imported.

## Update Scaffold
- [ ] Update `.mex/ROUTER.md` "Current Project State" if what's working/not built has changed
- [ ] Update any `.mex/context/` files that are now out of date
- [ ] If this is a new task type without a pattern, create one in `.mex/patterns/` and add to `INDEX.md`
