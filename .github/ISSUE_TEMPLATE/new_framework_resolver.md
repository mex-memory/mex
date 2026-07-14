---
name: New framework resolver
about: Propose framework-specific graph relationships for the developer preview
title: '[Framework] Add code-graph resolver'
labels: 'code-graph, developer-preview'
assignees: ''

---

> Target branch: `code-graph-preview`

## Framework

- Framework:
- Supported language or languages:
- Detection evidence, such as a package or project file:
- Required language extractor PR:

## Missing graph relationship

Describe the framework behavior that a plain AST extractor cannot connect.

### Expected nodes or references

List any framework-specific nodes or unresolved references the fixture should produce.

### Expected resolved edges

Describe the source-to-target relationship and the confidence conditions for binding it.

## Required proof

- [ ] I have read [Extending the code graph](https://github.com/mex-memory/mex/blob/code-graph-preview/docs/extractors.md)
- [ ] The required language extractor is already merged into `code-graph-preview`
- [ ] The resolver will use the frozen `FrameworkResolver` interface
- [ ] Positive and negative framework detection will be tested
- [ ] A minimal framework fixture will be added
- [ ] Resolution and ambiguous/missing-target behavior will be tested
- [ ] The resolver will be registered in the framework registry
- [ ] `npm run typecheck`, `npm test`, and `npm run build` will pass
- [ ] No identity, reconciliation, schema, or drift-semantics changes are included

## Blocked by

List prerequisite issues or pull requests. Do not mark the issue available while its language extractor is unmerged.

## Additional context

Include framework versions, intentionally deferred patterns, or likely false-positive cases.
