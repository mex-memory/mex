---
name: conventions
description: How code is written in this project — naming, structure, patterns, and style. Load when writing new code or reviewing existing code.
triggers:
  - "convention"
  - "pattern"
  - "naming"
  - "style"
  - "how should I"
  - "what's the right way"
edges:
  - target: context/architecture.md
    condition: when a convention depends on understanding the system structure
  - target: context/stack.md
    condition: when a convention depends on a runtime, library, or test tool
  - target: patterns/contract-first-external-adapter.md
    condition: when defining or implementing an independently owned consumer boundary
  - target: patterns/durable-change-signal.md
    condition: when adding a value that answers whether documented code changed
# Add only nodes that embody the documented convention; do not ground examples broadly.
# grounds_to:
#   - node: "function:<tier-1-id>"
#     fingerprint: "mh2:64:<base64url>"
grounds_to: []
last_updated: 2026-09-06
mex:
  id: mx_01M1M0CJ9460AT00V8TH0QCKAC
  type: convention
  status: promoted
  revision: 5
  title: conventions
  relations:
    - type: related_to
      target: mx_01M1M0CJ5C5XQV0HM5VM787WQS
      note: when a convention depends on understanding the system structure
    - type: related_to
      target: mx_01M1M0CJH1XW1V1FRGAGMWFXD6
      note: when a convention depends on a runtime, library, or test tool
    - type: related_to
      target: mx_01M1M0CJHQ2W47KM6K176ZYYPA
      note: when defining or implementing an independently owned consumer boundary
    - type: related_to
      target: mx_01M1M0CJK5ZTSHCDDWB3NTSEBF
      note: when adding a value that answers whether documented code changed
---

# Conventions

<!-- mex:entity
id: mx_01M1M0CJ8E6KNBAMXBK7GBCGPM
type: convention
status: promoted
revision: 1
-->
## Naming

- TypeScript modules generally use descriptive kebab-case filenames; Hub page and component modules also use PascalCase. Directory names describe the owned domain or boundary.
- Functions and variables use camelCase, usually verb-first for operations; classes, interfaces, and type aliases use PascalCase.
- Exported constants and closed contract values use descriptive uppercase snake case; SQLite columns and serialized on-disk keys follow their explicit schema rather than being renamed at adapters.
- Tests use `*.test.ts`/`*.test.tsx`, colocated with the owned module, in adjacent `__tests__/`, or in root `test/` for cross-module/public behavior.

<!-- mex:entity
id: mx_01M1M0CJ7QBQSRTSBWQTPSR3R8
type: convention
status: promoted
revision: 1
-->
## Structure

- `src/index.ts` is the public npm compatibility boundary. Everything not re-exported there is internal even when TypeScript exports it from a deep module.
- Root `src/` owns the CLI and local engines; `packages/hub-contracts` owns shared private Hub shapes; `packages/hub-web` owns the browser application.
- Put domain behavior with its domain (`graph`, `wiki`, `team`, `hub`); keep CLI builders/parsers, application services, repository adapters, and storage codecs as distinct layers.
- Canonical project/team knowledge is Markdown or JSONL under `.mex/`; Graph/Wiki databases and `.mex/local/` are generated or checkout-local and must remain ignored.
- Use adjacent focused tests for module invariants, consumer-owned conformance suites for ports, root integration tests for boundaries, and Playwright only for browser behavior.

<!-- mex:entity
id: mx_01M1M0CJ6XGNARCADMW3ABZPJT
type: convention
status: promoted
revision: 1
-->
## Patterns

- **Read paths are immutable.** Inspect through read-only/immutable sessions and return stable structured errors; creation, migration, repair, refresh, and rebuild belong to explicit write paths.
- **Preview before canonical mutation.** Validate a closed request, emit an exact signed/revision-bound preview, then apply only that reviewed envelope after revalidation. Keep Git publication separate.
- **Bound every layer.** Cap corpus scans, bytes, rows, diagnostics, cursors, source bodies, subscribers, jobs, and serialized responses—not only the returned page size.
- **Project through allowlists.** Do not serialize storage rows, errors, Git output, filesystem details, prompts, or private metadata directly into CLI/Hub responses.
- **Preserve the last trustworthy state.** Build maintenance candidates separately, revalidate all authority and provenance at publication, and atomically replace only after success.

<!-- mex:entity
id: mx_01M1M0CJ65DM25FSRADTNKX2D3
type: convention
status: promoted
revision: 1
-->
## Verify Checklist

Before presenting a change:

- [ ] The public `src/index.ts` surface and emitted declarations changed only if compatibility work explicitly requires it.
- [ ] Ordinary reads remain non-mutating; writes have explicit authority, containment, revision, and failure-atomicity checks.
- [ ] Inputs, scans, output, diagnostics, and retained local state remain deterministically bounded.
- [ ] Focused tests for the changed boundary pass, followed by `npm run typecheck`; run `npm test` without a concurrent build when full coverage is warranted.
- [ ] Run `npm run build` for packaging/Hub/asset changes and `npm run eval:test` for graph evaluator or protocol changes.
- [ ] `git diff --check` passes and only intended tracked paths changed; generated `.mex/*.db*`, `.mex/local/`, `dist/`, and unrelated worktree files remain unstaged.
- [ ] Graph/Wiki protocol shapes, stable error codes, ordering, cursors, and non-mutation contracts remain covered when affected.
