---
name: dependency-manifest-discovery
description: Review recursive dependency manifest discovery without changing parser semantics.
last_updated: 2026-10-11
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

## Gotchas
Reading all JavaScript before Python changes root Python version precedence.
Glob matches may include symlink files whose contents belong outside the project.

## Verify
Run `test/checkers.test.ts`, `test/dependency-discovery.test.ts`, typecheck, and diff checks.
The local graph was unavailable during this review; no graph fingerprints were invented.
