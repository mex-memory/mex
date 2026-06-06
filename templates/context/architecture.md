---
name: architecture
description: How the major pieces of this project connect and flow. Load when working on system design, integrations, or understanding how components interact.
triggers:
  - "architecture"
  - "system design"
  - "how does X connect to Y"
  - "integration"
  - "flow"
edges:
  - target: context/stack.md
    condition: when specific technology details are needed
  - target: context/decisions.md
    condition: when understanding why the architecture is structured this way
last_updated: [YYYY-MM-DD]
---

# Architecture

## System Overview
<!-- Describe how the major pieces connect.
     Focus on FLOW not technology — how does a request/action move through the system?
     Use the actual names of components, services, and modules from this codebase.
     Format: a simple text flow diagram or short prose description.
     Length: 5-15 lines. Minimum 5 lines. Should be readable in 30 seconds.
     Example:
     "Request comes in via Express router → validated by middleware →
     passed to service layer → service calls repository for data →
     repository queries PostgreSQL → result returned up the chain →
     formatted by serializer → sent as JSON response." -->

## Key Components
<!-- List the major components, modules, or services in this project.
     For each: name, what it does, what it depends on.
     Only include components that are non-obvious or have important constraints.
     Minimum 3 components. If you cannot identify 3, write "[TO DETERMINE]" as a placeholder.
     Length: 1-2 lines per component.
     Example:
     - **AuthService** — handles all authentication logic, depends on UserRepository and JWTLib
     - **EventBus** — async communication between services, all side effects go through here -->

## External Dependencies
<!-- Third-party services, APIs, or databases this project connects to.
     For each: what it is, what we use it for, any important constraints.
     Minimum 3 items. If you cannot find 3, write "[TO DETERMINE]" as a placeholder.
     Length: 1-2 lines per dependency.
     Example:
     - **PostgreSQL** — primary database, all writes go through the repository layer only
     - **SendGrid** — transactional email, use the EmailService wrapper, never call directly -->

## What Does NOT Exist Here
<!-- Explicit boundaries — what is deliberately outside this system.
     This prevents the agent from building things that belong elsewhere or making wrong assumptions.
     Minimum 2 items. If you cannot find 2, write "[TO DETERMINE]" as a placeholder.
     Length: 2-5 items.
     Example:
     - No background job processing — that lives in the worker service (separate repo)
     - No file storage — we use S3 directly, no abstraction layer -->
