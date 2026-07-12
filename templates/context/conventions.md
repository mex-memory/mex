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
# Add only nodes that embody the documented convention; do not ground examples broadly.
# grounds_to:
#   - node: "function:<tier-1-id>"
#     fingerprint: "mh:64:<hex>"
grounds_to: []
last_updated: [YYYY-MM-DD]
---

# Conventions

<!-- Read broad, ground tight. Anchor concrete symbols while keeping prose readable:
```markdown
[`someFunction()`](mex://function:<tier-1-id>)
```
-->

## Naming
<!-- How things are named in this codebase.
     Cover: files, functions, variables, classes, database tables/columns — whichever are non-obvious.
     Only include conventions that are actually enforced, not aspirational.
     Minimum 3 items. If you cannot find 3, write "[TO DETERMINE]" — do not pad with generic advice.
     Length: 3-7 items.
     Example:
     - Files: kebab-case (`user-profile.ts`, not `UserProfile.ts`)
     - Functions: camelCase, verb-first (`getUserById`, not `userById`)
     - Database columns: snake_case (`created_at`, not `createdAt`) -->

## Structure
<!-- How code is organised within files and across the codebase.
     Cover the things the agent is most likely to get wrong.
     Minimum 3 items. If you cannot find 3, write "[TO DETERMINE]" — do not pad with generic advice.
     Length: 3-7 items.
     Example:
     - Business logic lives in services/, never in route handlers
     - Each service file exports a single class
     - Tests live next to the file they test (`user.service.ts` → `user.service.test.ts`) -->

## Patterns
<!-- Recurring code patterns that must be followed consistently.
     Include concrete before/after examples for the most important ones.
     Minimum 2 patterns. If you cannot find 2, write "[TO DETERMINE]".
     Length: 2-5 patterns with examples.
     Example:
     Always use the Result type for error handling — never throw from the service layer:
     ```
     // Correct
     return { success: true, data: user }
     return { success: false, error: 'User not found' }

     // Wrong
     throw new Error('User not found')
     ``` -->

## Verify Checklist
<!-- A short checklist the agent runs against any code it writes in this project.
     These are the things most likely to go wrong based on this specific codebase.
     The agent should explicitly check each item before presenting output.
     Minimum 4 items. If you cannot find 4, write "[TO DETERMINE]".
     Length: 4-8 items.
     Example:
     Before presenting any code:
     - [ ] Business logic is not in route handlers
     - [ ] All database access goes through the repository layer
     - [ ] Error handling uses the Result type, not exceptions
     - [ ] New files follow the naming convention above -->
