---
name: dependency-manifest-discovery
description: Review recursive dependency manifest discovery without changing parser semantics.
last_updated: 2026-10-26
grounds_to: []
---

# Dependency Manifest Discovery

## Context
Issue #206 and PR #250 cover discovery in `src/drift/checkers/dependency.ts`.
Read the manifest loader and first-match version lookup together.

## Steps
1. Reproduce nested JavaScript and Python declarations through `checkDependencies`.
2. Preserve root package.json, then root pyproject.toml precedence; order nested paths deterministically.
3. Exclude installed dependencies, Git metadata, and file/directory symlinks.
4. Bound discovery, manifest count, individual bytes, and total bytes. Abstain when discovery is incomplete.
5. Distinguish manifest completeness from claim ecosystem. An unread Python manifest makes Python and unlabelled missing-name claims uncertain, while explicitly identified npm claims remain checkable. Preserve explicit enclosing-heading evidence through neutral subsections, clear it for ambiguous headings, and never infer an ecosystem from a familiar package name.

## Gotchas
Reading all JavaScript before Python changes root Python version precedence.
Glob matches may include symlink files whose contents belong outside the project.
Same-spelled npm and Python packages are distinct. Restrict identified version
claims to their ecosystem and avoid cross-file conflicts between explicitly
different ecosystems. Unlabelled claims must still compare with identified
claims when only one ecosystem is named for that package.
Recognize whole heading labels with neutral dependency terms. Bare `Node` is
not Node.js evidence. Unknown qualifiers (including unsupported languages) clear
an enclosing ecosystem, so a mixed JavaScript/Rust section cannot inherit npm.
When both ecosystems are identified for a name, compare each identified group
independently. Keep an unlabelled version visible when it matches neither
candidate; do not invent a conflict when unlabelled versions match different
known candidates. Check all visit orders for the incompatible-version case.

## Verify
Run `test/checkers.test.ts`, `test/dependency-discovery.test.ts`,
`test/dependency-ecosystems.test.ts`, `test/claims.test.ts`, public-interface
checks, typecheck, and diff checks. The optional public `Claim.ecosystem` field
is an additive interface change; follow `COMPATIBILITY.md` when releasing it.
Run final typecheck after the root test suite: its built CLI test rebuilds the
contract declarations. Loopback/process tests need permissions for those host
operations; distinguish sandbox refusals from code failures before changing code.
The local graph was unavailable during this review; no graph fingerprints were invented.
