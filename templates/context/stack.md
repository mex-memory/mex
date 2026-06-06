---
name: stack
description: Technology stack, library choices, and the reasoning behind them. Load when working with specific technologies or making decisions about libraries and tools.
triggers:
  - "library"
  - "package"
  - "dependency"
  - "which tool"
  - "technology"
edges:
  - target: context/decisions.md
    condition: when the reasoning behind a tech choice is needed
  - target: context/conventions.md
    condition: when understanding how to use a technology in this codebase
last_updated: [YYYY-MM-DD]
---

# Stack

## Core Technologies
<!-- List the primary language, framework, and runtime.
     For each: version if it matters, any important configuration.
     Minimum 3 items. If you cannot find 3, write "[TO DETERMINE]".
     Length: 3-7 items.
     Example:
     - **Python 3.11** — primary language
     - **FastAPI** — web framework, async by default
     - **PostgreSQL 15** — primary database -->

## Key Libraries
<!-- Libraries that are central to how this project works.
     Only include libraries where the agent needs to know: we use THIS, not the alternative.
     Include the reason over alternatives where it matters.
     Minimum 3 items. If you cannot find 3, write "[TO DETERMINE]".
     Length: 3-10 items.
     Example:
     - **SQLAlchemy** (not raw psycopg2) — ORM for all database access
     - **Pydantic v2** — data validation and serialisation, used everywhere
     - **pytest** (not unittest) — all tests use pytest style -->

## What We Deliberately Do NOT Use
<!-- Technologies or patterns explicitly avoided in this project, and why.
     This prevents the agent from introducing unwanted dependencies.
     Minimum 2 items. If you cannot find 2, write "[TO DETERMINE]".
     Length: 2-5 items.
     Example:
     - No ORM for raw analytics queries — use psycopg2 directly for performance
     - No Redux — state management is local, context API only
     - No class components — hooks only -->

## Version Constraints
<!-- Only fill this if there are important version-specific things to know.
     Leave empty if there are no meaningful version constraints.
     Example: "We are on React 17, not 18 — concurrent features are not available." -->
