# Patterns

This folder contains task-specific guidance — the things you would tell your agent if you were sitting next to it. Not generic instructions. Project-specific accumulated wisdom.

## How patterns get created

**During setup:** After the context/ files are populated, the agent generates starter patterns based on the project's actual stack, architecture, and conventions. These are stack-specific — a Flask API project gets different patterns than a React SPA or a CLI tool.

**Over time:** You or your agent add patterns as they emerge from real work — when something breaks, when a task has a non-obvious gotcha, when you've explained the same thing twice.

## What belongs here

A pattern file is worth creating when:
- A task type is common in this project and has a repeatable workflow
- There are integration gotchas between components that aren't obvious from code
- Something broke and you want to prevent it from breaking the same way again
- A verify checklist specific to one type of task would catch mistakes early

## When to skip a pattern

Default to generating a pattern. Only skip if:
- The exact same guidance is already in `context/conventions.md` with concrete examples
- The task truly has no project-specific gotchas (e.g. "how to write a for loop")

If in doubt, generate the pattern. A pattern that turns out to be obvious costs nothing. A missing pattern costs a broken codebase.

## Format

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
last_updated: [YYYY-MM-DD]
---

# [Pattern Name]

## Context
[What to load or know before starting this task type]

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

```markdown
---
name: [pattern-name]
description: [one line — what this pattern file covers]
triggers:
  - "[keyword]"
edges:
  - target: "[related file path]"
    condition: "[when to follow this edge]"
last_updated: [YYYY-MM-DD]
---

# [Pattern Name]

## Context
[Shared context for all tasks in this file]

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

Do not use a fixed number. Generate one pattern per:
- Each major task type a developer does repeatedly in this project
- Each external dependency with non-obvious integration gotchas
- Each major failure boundary in the architecture flow

For a simple project this may be 3-4 files. For a complex project this may be 10-15.
Do not cap based on a number — cap based on whether the pattern adds real value.

## Pattern categories

Walk through each category below. For each one, check the relevant context files
and generate patterns for everything that applies to this project.

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
deserves a pattern. These are the most dangerous areas — the agent will
confidently write integration code that looks right but misses project-specific
configuration, error handling, or rate limiting.

Examples: "calling the payments API", "running database migrations",
"adding a new third-party service client", "configuring auth provider"

### Category 3 — Debug/diagnosis patterns

When something breaks, where do you look?

Derive from the architecture flow — each boundary between components is a
potential failure point. One debug pattern per major boundary.

Examples: "debug webhook failures", "debug pipeline stage failures",
"diagnose auth/permission issues", "debug background job failures"

### Category 4 — Deploy/release patterns

Only generate if `context/setup.md` reveals non-trivial deployment.

Examples: "deploy to staging", "rollback a release", "update environment config",
"run database migration in production"
