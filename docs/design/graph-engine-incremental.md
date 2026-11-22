# Incremental resolution in the Rust graph engine

`refresh` and `serve` use the same planner against the current publication.
A compatible base and its current overlay supply the previous resolution.
The candidate is still one overlay over the canonical base. The engine
copies retained overlay rows into the candidate and the parent publishes it
under the existing writer lease after validating the complete source snapshot.
The writer copies the previously shadowed state even when the current edit
has few dependencies. The contentless source index for those paths is
recreated from verified source without decoding their resolver facts.

## One edit

1. Extract the added and modified files. A private per-origin record stores
   a hash of the resolver inputs with positions removed, a hash of the
   declaration and binding surface, and the original site positions. It also
   stores the projected relationships before the SQL writer deduplicates them.
2. When the resolver inputs agree and old and new coordinates form a
   bijection, translate the saved sites. Rebuild only the edited file's
   declarations, fingerprints, diagnostics and source search index. At
   identical sites the writer can copy the outgoing rows and digest directly.
   If a site correspondence is ambiguous, resolve that origin again.
3. For a local reference change, resolve the edited origin. A declaration,
   export, import or other effective surface change also invalidates the
   reverse closure of recorded resolution reads. A file used by a resolver
   is decoded when the resolver first needs it. `refresh` uses the disk
   facts cache and extracts a cache miss from the verified source. `serve`
   uses pinned compressed facts, an 8 MiB decompression cache and up to
   1,024 consulted files within a 64 MiB estimated decoded budget. Each
   edit owns its resolver indexes and projected rows. A one-shot refresh
   can retain 64 MiB of decompressed blocks for that job.
4. Compare the new outgoing projection digest with the previous digest in
   public-ID space. Projected relationships that agree need no public row
   replacements. Save changed resolver reads even if their public rows
   agree, so the next edit follows the current dependencies.

The private tables are keyed by the file containing the written site.
The public v5 tables still own edges by their source node. In ECMAScript
a callback relationship can belong to the callee's file even though its
argument is written in a caller. The writer replaces that origin's
contribution and combines it with retained callback contributions in
checkout path order. It retains sites that collide on the SQL edge key
so removing the winning site exposes the same next site a cold build
would choose. A callee whose outgoing rows changed gets a new digest.
The call-pair delta also identifies files whose fingerprint neighbours
change. The engine copies their declarations and sketches and recreates
their contentless FTS rows from node columns and hash-verified source.
Warm publication inherits filesystem observations from a base captured in
the same checkout and records changed or missing stamps in the overlay.
Continuity looks for aliases of vanished nodes on shadowed paths. It checks
qualified names, signatures, body hashes and fingerprints in the usual
order. A fingerprint match can require a streaming sketch scan.

## Private storage

- Base file identities come from `files.id`. An overlay allocates IDs above
  `2^40` for new paths in `resolution_paths` and carries that dictionary across
  publications, including deleted paths. Overlay node allocation likewise
  carries a high-water mark. Retained projections can keep their integer
  endpoints across an edit, a deletion and a later addition.
- The resolver records file and import ordinals in memory. It interns other
  lookups once per distinct key and records the reads behind cached export
  results. `resolution_names` stores distinct spellings. `resolution_keys`
  assigns IDs to tuples of lookup kind, file ID and name ID. A module probe
  names its importing file and specifier separately. A path probe can use
  an existing file ID or intern a spelling for a missing path.
- `resolution_reads` has one row per origin with reads. The low bit of each
  encoded ID distinguishes a file from a lookup. The row stores the sorted,
  unique IDs as unsigned varint deltas. Surface and topology edits decode
  the visible rows into a reverse index for the candidate. A surface-only
  change keeps file, type, heritage and dispatch readers in the index.
  Topology edits also load module and path probes. Append, prepend and local
  reference edits can skip the index. Framework detection uses its own small
  table because it is checked on every edit.
- `resolution_inputs` holds the origin header. In a base it locates the
  origin's slice of a Zstandard frame. Small records share frames of up to
  64 KiB of uncompressed data. Larger records get their own frame. The
  compressed stream is split into SQLite rows with 64 bytes of page headroom
  per block. Bases under 4,096 nodes use 2 KiB pages. Larger bases use 4 KiB.
  An overlay keeps each of its updated origins as an independent compressed
  record, so it can carry retained rows with SQL. A null overlay record
  masks the previous projection and the origin's dependency rows.
- `resolution_callbacks`, `resolution_heritage` and `resolution_types` use
  integer owner, origin or name keys. Relationship projections use graph
  node keys. The outgoing digest compares binary public identities, edge
  fields and cross-file site paths across builds. Base writes stream the
  projection and public rows together and defer the owners of incoming
  callbacks until all their sites are known.

## Dependency rules

- **TypeScript and JavaScript.** Each origin records the file facts it
  consulted through explicit imports, named and star re-exports, `export =`,
  and CommonJS. File-local bindings and the type and value lanes determine
  the declaration candidates. Duplicate declarations within a file can
  change a unique result to an ambiguous one. Cross-file declaration
  lookup in the native resolver follows module links. A topology change
  compares recorded import and require lookups in the old and new module
  indexes, including misses and ambiguous matches. Interface dispatch uses
  reverse heritage from retained origins
  plus new heritage from the selected origins. A change affecting a
  heritage declaration can add an implementation without a previous edge,
  so the planner revisits interface dispatch sites in that case. Contextual
  `this`, inferred return values and proven callback-parameter invocations
  can cross file boundaries. The declaration surface comparison retains
  those effects. It retains the complete input arena for files with
  contextual-call evidence, so edits there can conservatively invalidate
  their readers.
- **Python.** Record reads through module imports, package re-exports and
  inherited declarations. Relative lookups record the tried module and
  `__init__.py` paths. Changes to package topology compare the old and new
  dotted-name maps, including names that become unique or ambiguous.
- **Rust.** Record candidate paths and opened files while following
  `mod`, `use`, `pub use`, and crate, parent and workspace roots.
  Track workspace crate names even on misses so adding a library can
  change a previously unresolved reference.
- **C#.** Follow lexical declarations, enclosing namespaces and using
  directives. A cross-file type lookup records the name even on a miss.
  The private type index loads only the candidate files. Changes to old
  or new type-name buckets invalidate the readers of those names.
- **Frameworks.** Route declarations and local handler links follow
  the edited file's markers. Named ECMAScript handler imports use the
  same module and export dependencies as language references. A change
  in enabled frameworks can activate markers in unrelated files, so it
  requires complete resolution.

## Fallbacks

An exact resolver-configuration change or framework activation change
requires complete resolution. A standalone refresh without a complete
captured hash observation reads every file and resolves the corpus. It
can reuse extraction cache entries whose source hashes match. The
resident process runs complete resolution and edits that select more than
192 origins or touch more than 8 MiB of source inputs in a short-lived
refresh worker. The worker uses the same planner for a large delta, keeping
the resolver's temporary decoded corpus out of the resident heap. The
published results are adopted only after the parent accepts the new overlay.

The private record format is versioned independently of schema v5 and the
JSONL protocol. An older base takes the existing incompatible-base build
path. Cache misses and corrupt facts-cache records use verified extraction.
Invalid private projection records fail the candidate and leave the last
publication available. A lost source proof triggers contained discovery
and retries with a complete source observation. An oversized overlay,
stale publication or stopped session uses normal refresh. An overlay
that still exceeds the publication limit requires a new base.
