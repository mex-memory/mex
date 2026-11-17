# Read-only 0.8 upgrade inputs

`src/upgrade/legacy-reader.ts` supplies `readLegacyScaffold(projectRoot)` for
the 0.8-to-0.9 migration. This first layer reads inputs only. It does not expose
a command, convert entries, delete caches, rewrite instructions or publish a
change. Those operations belong to the following upgrade stages.

The result preserves exact UTF-8 text (including BOM and CRLF), byte hashes,
source paths, canonical Wiki entities and their authored grounding baselines.
Root-level groundings without a file-level entity remain unattributed. Log
records retain their original fields and source lines. The reader never calls
an old verification timestamp a current check, and never supplies a new baseline.

It reads `.mex/config.json`, scaffold Markdown, root `AGENTS.md` and `CLAUDE.md`,
and `.mex/events/decisions.jsonl`. Configured Wiki exclusions remain excluded.
Team-owned Markdown, including Inbox proposals and Relays, is returned separately
for preservation, without interpreting it as knowledge. Local files, saved
diagrams, evaluation output and new learned entries are outside this reader.
Graph/Wiki databases and their sidecars are never opened, even for status checks.

Malformed metadata, duplicate identities, damaged log rows, unreadable sources,
redirected paths and safety limits produce bounded code/path diagnostics. Source
prose and raw filesystem errors do not enter those diagnostics. Readable material
remains available for inspection, but `complete: false` must block conversion.
Informational codec diagnostics do not make an otherwise complete read partial.
Unlike the index reader, upgrade refuses malformed root `grounds_to` values
instead of silently dropping their evidence from a complete observation.

Every read uses a regular-file descriptor, rejects links/junctions and parent
redirects, bounds allocation and total retained bytes, and rechecks file and
directory identities. A final verification rejects modifications, replacements,
directory additions and newly appearing optional inputs during the observation.
Directory contents are re-enumerated and compared under a separate bounded
verification budget because Windows can defer directory timestamp changes.
File reads also compare a second descriptor pass against the captured bytes,
and final verification rechecks source hashes under its own corpus bound. This
detects same-size edits when Windows defers file timestamps until handle close.
Consumers must still revalidate source hashes before applying a later preview;
this observation is not a durable lock on the user's files.

## Retention when the old engine is removed

Keep the transitive pure Markdown/model codec closure reached from
`wiki/markdown/contract.ts`, plus `paths.ts`, `wiki/index/discover.ts` (the legacy
glob matcher) and its `corpus-policy.ts` dependency, and the pure Graph fingerprint
codec (`graph/fingerprint.ts`, `graph/config.ts`, `graph/reconcile.ts` and its
error definitions). The
Markdown grounding-store merger imports that codec directly rather than the
Graph adapter, whose re-export loaded stores. These modules do not open a
database, invoke the Wiki engine, initialise a store or access machine state.
`legacy-boundary.test.ts` checks this boundary recursively. The compatibility
reader must survive removal of the old engine, CLI, operations and migration
services in release-04. Reusing this decoder preserves its existing metadata,
heading-binding, conflict-marker and range semantics instead of creating a
second interpretation of 0.8 files.

The first-part tests cover the existing eight-document Wiki fixture scaffold,
exact-byte non-mutation, original provenance/groundings, malformed input and
filesystem safety. The Hono/novu/MEX upgrade gate and three-OS install/uninstall
qualification remain later stages; reader tests alone cannot satisfy them.
