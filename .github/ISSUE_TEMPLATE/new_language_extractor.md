---
name: New language extractor
about: Propose a bounded Tree-sitter language extractor for the code-graph preview
title: '[Language] Add code-graph extractor'
labels: 'code-graph, developer-preview, language-support, tree-sitter'
assignees: ''

---

> Target branch: `code-graph-preview`

## Language

- Language:
- File extensions:
- Tree-sitter grammar repository:
- Grammar version or commit:
- Grammar license:

## Scope

Describe the declarations, references, and language constructs this first extractor should support.

### Expected nodes

List the graph node kinds the fixture should produce.

### Expected edges

List the graph relationships the fixture should prove.

## Required proof

- [ ] I have read [Extending the code graph](https://github.com/mex-memory/mex/blob/code-graph-preview/docs/extractors.md)
- [ ] The language exists in the shared `Language` vocabulary, or I have called out the required addition
- [ ] The extractor will use the frozen `LanguageExtractor` interface
- [ ] A compatible grammar WASM file will be vendored and registered
- [ ] File extensions and the extractor will be registered
- [ ] A representative fixture will be added
- [ ] Focused tests will assert node and edge shape
- [ ] `npm run typecheck`, `npm test`, and `npm run build` will pass
- [ ] No identity, reconciliation, schema, or drift-semantics changes are included

## Blocked by

List prerequisite issues or pull requests, or write `None`.

## Additional context

Include grammar caveats, syntax intentionally deferred, or maintenance considerations.
