---
name: patterns
description: Guide to creating and maintaining project-specific patterns without duplicating existing guidance.
last_updated: 2026-09-06
---

# Patterns

This folder contains task-specific guidance — the things you would tell your agent if you were sitting next to it. Not generic instructions. Project-specific accumulated wisdom.

## How patterns get created

**During setup:** After the context files are populated, a fresh repository seeds 2-3 high-value patterns. An existing repository audits its pattern corpus first and uses 3-5 only as a seed target when no substantive patterns exist. Any addition must cover a genuine project-specific gap.

**Over time:** You or your agent add patterns as they emerge from real work — when something breaks, when a task has a non-obvious gotcha, when you've explained the same thing twice.

## What belongs here

A pattern file is worth creating when:
- A task type is common in this project and has a repeatable workflow
- There are integration gotchas between components that aren't obvious from code
- Something broke and you want to prevent it from breaking the same way again
- A verify checklist specific to one type of task would catch mistakes early

## When to skip a pattern

Audit the existing pattern and index before creating anything. Update the
matching pattern when the task is already covered; create a new one only when:
- The workflow recurs and has project-specific steps or failure modes
- The guidance is not already concrete in `context/conventions.md`
- No existing pattern covers the same task under a different name

An overlapping pattern fragments the operating contract. Prefer one well-routed,
evidence-backed pattern over multiple near-duplicates.

## Format

The examples below use the pre-Wiki grounding shape. In migrated files, keep
groundings under `mex.grounds_to`. Use graph-produced fingerprints and retain
captured `bodyHash` baselines; a review date alone does not verify a grounding.

### Single-task pattern (one file = one task)

```markdown
---
name: [pattern-name]
description: [one line — what this pattern covers and when to use it]
triggers:
  - "[keyword that should trigger loading this file]"
edges:
  - target: "[related file path, e.g. context/conventions.md]"
    condition: "[when to follow this edge]"
grounds_to:
  - node: "function:<tier-1-id>"
    fingerprint: "mh2:64:<base64url-fingerprint>"
last_updated: [YYYY-MM-DD]
---

# [Pattern Name]

## Context
[What to load or know before starting this task type]

[Anchor concrete symbols in prose, e.g. [`someFunction()`](mex://function:<tier-1-id>).
Read the broad task neighborhood, but ground only nodes that embody this pattern.]

## Steps
[The workflow — what to do, in what order]

## Gotchas
[The things that go wrong. What to watch out for.]

## Verify
[Checklist to run after completing this task type]

## Debug
[What to check when this task type breaks]

## Update Scaffold
- [ ] Update `.mex/ROUTER.md` "Current Project State" if what's working/not built has changed
- [ ] Update any `.mex/context/` files that are now out of date
- [ ] If this is a new task type without a pattern, create one in `.mex/patterns/` and add to `INDEX.md`
```

### Multi-section pattern (one file = multiple related tasks)

Use this when tasks share context but differ in steps. Each task gets its own
`## Task: ...` heading with sub-sections. The Context section is shared at the top.
Point the index entry at the task anchor, for example `[file.md#task-name]`.

```markdown
---
name: [pattern-name]
description: [one line — what this pattern file covers]
triggers:
  - "[keyword]"
edges:
  - target: "[related file path]"
    condition: "[when to follow this edge]"
grounds_to:
  - node: "function:<tier-1-id>"
    fingerprint: "mh2:64:<base64url-fingerprint>"
last_updated: [YYYY-MM-DD]
---

# [Pattern Name]

## Context
[Shared context for all tasks in this file]

[Anchor concrete symbols in prose, e.g. [`someFunction()`](mex://function:<tier-1-id>).
Ground only the nodes that embody the documented behavior.]

## Task: [First Task Name]

### Steps
[...]

### Gotchas
[...]

### Verify
[...]

## Task: [Second Task Name]

### Steps
[...]

## Update Scaffold
- [ ] Update `.mex/ROUTER.md` "Current Project State" if what's working/not built has changed
- [ ] Update any `.mex/context/` files that are now out of date
- [ ] If this is a new task type without a pattern, create one in `.mex/patterns/` and add to `INDEX.md`
```

Do NOT combine unrelated tasks into one file just to reduce file count.
Only group tasks that genuinely share context.

## How many patterns to generate

After the initial seed, do not use a fixed number. Consider an additional
pattern only for an uncovered, high-value task in these areas:

- Each major task type a developer does repeatedly in this project
- Each external dependency with non-obvious integration gotchas
- Each major failure boundary in the architecture flow

For a simple project this may be 3-4 files. For a complex project this may be 10-15.
Do not cap based on a number — cap based on whether the pattern adds real value.

## Pattern categories

Walk through each category below. For each one, check the relevant context files
and existing patterns for gaps; add only guidance justified by recurring work.

### Category 1 — Common task patterns

The repeatable tasks in this project. What does a developer do most often?

Derive from: `context/architecture.md` (what are the major components?) and
`context/conventions.md` (what patterns exist for extending them?)

Examples by project type:
- API: "add new endpoint", "add new model/entity", "add auth to a route"
- Frontend: "add new page/route", "add new component", "add form with validation"
- CLI: "add new command", "add new flag/option"
- Pipeline: "add new pipeline stage", "add new data source"
- SaaS: "add payment flow", "add user-facing feature", "add admin operation"

### Category 2 — Integration patterns

How to work with the external dependencies in this project.

Every entry in `context/stack.md` "Key Libraries" or `context/architecture.md`
"External Dependencies" that has non-obvious setup, gotchas, or failure modes
is a candidate for a pattern if existing guidance does not cover it. These are
the most dangerous areas — the agent will
confidently write integration code that looks right but misses project-specific
configuration, error handling, or rate limiting.

Examples: "calling the payments API", "running database migrations",
"adding a new third-party service client", "configuring auth provider"

### Category 3 — Debug/diagnosis patterns

When something breaks, where do you look?

Derive from the architecture flow — each boundary between components is a
potential failure point. Add debug guidance to the matching pattern before
creating a separate file.

Examples: "debug webhook failures", "debug pipeline stage failures",
"diagnose auth/permission issues", "debug background job failures"

### Category 4 — Deploy/release patterns

Only generate if `context/setup.md` reveals non-trivial deployment.

Examples: "deploy to staging", "rollback a release", "update environment config",
"run database migration in production"
