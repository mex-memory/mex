---
name: safe-graph-snapshot-evolution
description: Evolve graph indexing or freshness checks without publishing mixed facts, mutating reads, or losing the last trustworthy snapshot.
triggers:
  - "graph freshness"
  - "graph snapshot"
  - "graph indexing"
  - "graph recovery"
  - "SQLite graph"
edges:
  - target: "context/architecture.md"
    condition: "when changing the graph data plane or its consumers"
  - target: "context/conventions.md"
    condition: "when verifying a graph implementation change"
last_updated: 2026-10-10
mex:
  id: mx_01M1M0CJP81C590FCKTSN5HA3Q
  type: pattern
  status: promoted
  revision: 5
  title: safe-graph-snapshot-evolution
  grounds_to:
    - node: function:57e8797d70bfb28e3f0bb1d6e065a84b
      fingerprint: mh:64:7b226d696e68617368223a5b373433353431352c36383630383839382c3336343837333436342c3131313135363738322c3136303437383930372c35303239383534342c34343538363335392c31303638333430312c3132343432393032322c37343135313833362c3139313636343038302c3130393433363132302c36373436383937392c34393439313531312c38393637343631332c3231373938373535332c3339363239323334392c3136303339393132332c3233343534373238362c3539303238323939372c3433313434303631362c3133373736333436352c31313832313139322c363132313633372c38373234323032382c32363630383036312c3337303939303235392c37363031323737322c383932353634382c35323135393631352c37303130313637302c35303830363936322c33343735363730342c3432353432363237352c34313937383934302c3137323331303738322c37343339313430312c34373532373330342c3137383030313031332c34343137383331332c32363538313039382c35313437353533322c3134323433393336332c32313037393237362c31343137383630322c36393336313532312c37323334313033332c3136303334303138382c3335303935373134392c3331303135373337312c3230323338303532302c34363338343235342c3138383132353538382c31383234373139322c3232393935393733372c3232303332313535312c34353431373034352c39363939383431372c3137393134303431382c36353339353031312c39363336343330342c3136383839343834372c3131383936363032372c31363630313236315d2c226e65696768626f7273223a5b2266756e6374696f6e3a3232356238393639303266623765626136396330373862336264653665653133222c2266756e6374696f6e3a3661313066666631336537646231653966346438653365353961616633376139222c2266756e6374696f6e3a3666336464356162303564613464313431306139353935353938656666653865222c2266756e6374696f6e3a3765303639626665656232393866316437373333636335396434643362356264222c2266756e6374696f6e3a3832373364613165326563653830333130336535663965613766303562613439222c2266756e6374696f6e3a3938373536646437643162336136663138363038386339316438323366336163222c2266756e6374696f6e3a6137376136356561336231613138303266656261333635373937346134656662222c2266756e6374696f6e3a6139313036386263306235333031613762633236363435326330373131643630222c2266756e6374696f6e3a6261383761323638333461383134393634396566616638323031393032376134222c2266756e6374696f6e3a6332346131623938383762336137626136303338336562666338346530303934222c2266756e6374696f6e3a6430393031653565393031663964316236383066666436353666663139383862222c2266756e6374696f6e3a6539376637656161323533636631376363396461663062663432313531383965222c2266756e6374696f6e3a6561363838323362356361313962613863663939333330323231613635346666222c2266756e6374696f6e3a6632653366396338303765393338363239353431346262323730653362323235222c2266756e6374696f6e3a6639653132656562353337626433383734636232626462626435616139666636222c2266756e6374696f6e3a6665353431376338376131323261333465323236653166643136663631376566222c2266756e6374696f6e3a6666313138653636656264636139373333363564623262346466643032383237222c226d6574686f643a3730326666393635353436356661633663636530666135393433623466333363225d2c22746f6b656e436f756e74223a32387d
      bodyHash: bd13d365285d1e05e5422a73b8025d664b72b7bc4f52ea3cd24812c8596a5066
    - node: function:55ee332a5454ec1e1c91f575920b6563
      fingerprint: mh:64:7b226d696e68617368223a5b373433353431352c3130343436363733342c3336343837333436342c3133363332343137332c3130343134353832392c3131383638333235392c323731343330352c3136343636383233302c3133343935393238372c353336313837332c3136323232313932342c3232333239313239362c36373436383937392c34323033363635302c32353330363039302c35393637383033382c3133363635363236332c37373133363833342c3233343534373238362c3138383135303035352c38383932353139342c35303634363136322c31313832313139322c363132313633372c38373234323032382c32363630383036312c38393131383238382c33333034343436332c34373630313239322c35323135393631352c31313636313734322c35303830363936322c31373536313039372c3136393737323433332c34313937383934302c3133343734313535372c3336353532303338352c3134303736303137382c36333335343232312c34343137383331332c3136333033393237392c31353539383738382c3134323433393336332c32313037393237362c3231343339323538312c36393336313532312c39353730323135312c34313635363636302c3134383537333239372c3134323935373036382c393934393334312c33393833373439372c35383939343335352c31383234373139322c34393738303838392c3130353330383037312c35323732302c39363939383431372c363030333533302c32323931323839392c37353036383636342c31343233393535322c33383337343331332c38393633303336345d2c226e65696768626f7273223a5b2266756e6374696f6e3a3039626234383032316461343437343331313639396336636630333337616139222c2266756e6374696f6e3a3136386238386439643635643362356564616664373437383435383537363232222c2266756e6374696f6e3a3538343664393539623238376161396632303334633039303435373836626339222c2266756e6374696f6e3a3666353335353963633837623362356631393937653135396630373533323166222c2266756e6374696f6e3a3930353533343766393137636166383732316132663664346531386263633961222c2266756e6374696f6e3a3933336664623665326330306237393939663564333030326535343835343330222c2266756e6374696f6e3a6137376136356561336231613138303266656261333635373937346134656662222c2266756e6374696f6e3a6235626162333434333237336563613661303233393466616664653062636439222c2266756e6374696f6e3a6237656633643331306335626166356162623865326436663034643662636439222c2266756e6374696f6e3a6439333161373761383563643565306533333238643166333065636437633834222c2266756e6374696f6e3a6537396565663365396163363036386136353630623034396635653561633632222c2266756e6374696f6e3a6638393763383764623335613039313933306530663738623164383466393836225d2c22746f6b656e436f756e74223a35377d
      bodyHash: 8c722ebc5e851263b4d200560cbd807b882d43aac9cc30f3a3b5652b68f4bf8c
  relations:
    - type: related_to
      target: mx_01M1M0CJ5C5XQV0HM5VM787WQS
      note: when changing the graph data plane or its consumers
    - type: related_to
      target: mx_01M1M0CJ9460AT00V8TH0QCKAC
      note: when verifying a graph implementation change
---

# Safe Graph Snapshot Evolution

## Context

The graph database is a query surface and a derived grounding lookup/cache;
tracked Markdown `bodyHash` values are the canonical grounding change baseline.
A graph that is internally valid but represents mixed source, config, Git, or
compiler observations is not trustworthy. Ordinary inspection must also remain
read-only: SQLite recovery, schema repair, indexing, and grounding writes belong
only to explicit maintenance workflows.

## Steps

1. Define source extensions, ignore rules, config inputs, grammar identity, and
   extractor/resolver versions in one corpus policy shared by indexing and
   freshness inspection.
2. Discover source and config inputs through repository-contained canonical
   paths. Bind each read to a regular-file descriptor and verify the original
   path still resolves to the same inode after the read.
3. Make parsers and compiler extraction consume the captured bytes. Do not let
   a downstream compiler host silently re-read live source or config files.
4. Revalidate Git coordinates, the exact source corpus, config inputs, and any
   additional semantic inputs at the final boundary before publication.
5. Persist a versioned provenance snapshot in the same transaction as graph
   facts. A failed stage, parse, invariant check, or publication race must not
   advance snapshot metadata.
6. Inspect through
   [`inspectGraphStatus()`](mex://function:57e8797d70bfb28e3f0bb1d6e065a84b)
   with raw read-only/immutable SQLite access only after checking WAL,
   rollback-journal, containment, and file identity. Validate every schema
   object and data shape required by graph readers before reporting `fresh`.
7. Preserve the prior trustworthy graph when
   [`rebuildGraph()`](mex://function:55ee332a5454ec1e1c91f575920b6563)
   prepares an explicit candidate that is
   incomplete or failed. Build under a repository-scoped owner-token lock,
   validate a same-directory candidate, revalidate the live database, and only
   then publish by atomic rename. Surface failure rather than printing a
   successful no-op summary.
8. Guard graph-derived reads for their complete use window. If the database or
   selected path changes, discard the whole batch of derived findings. Bind any
   returned live source to one contained fd-stable byte buffer whose decoded
   hash matches the indexed row, so an A→B→A edit cannot escape validation.
9. Keep retrieval ranking and protocol-v3 record shapes untouched unless the
   task explicitly changes that public boundary; rerun the exact JSONL goldens.
10. Normalize evaluator provenance field-by-field. Exclude only explicitly
    operational snapshot fields; malformed or future snapshot shapes must fail
    closed instead of disappearing from the semantic graph hash.
11. Use `upsertFingerprintsInOwnedTransaction(db, entries)` only where the caller
    owns complete publication rollback and lets every failure reach it. Keep
    `FingerprintStore.upsert` and `upsertMany` independently atomic even if an
    enclosing caller catches a failure and continues. Preserve duplicate
    last-entry behavior, stable references, aliases, constraints, and untouched
    rows. Graph publication never accepts a new Markdown grounding baseline.
12. Reuse only a fixed, owned set of synchronous storage statements on their
    original connection. Keep dynamic queries and caller-owned iterators
    independent; a generic global SQL cache can reuse an active iterator or
    retain closed databases. Fingerprint point reads use weak connection
    ownership; GraphStore hot statements belong to the store instance.

## Gotchas

- Size and mtime are hints, not content identity. Same-size edits can restore an
  mtime and still require reindexing.
- An immutable SQLite connection assumes its file never changes. A clean probe
  before opening is insufficient; revalidate around and after graph use.
- A live WAL may contain the current schema while the main file looks stale or
  corrupt. Treat writer activity as transient/degraded, never durable damage.
- `PRAGMA quick_check` does not prove application compatibility. FTS shadow
  tables, fingerprint JSON, LSH bands, ownership, and dangling references need
  explicit invariants.
- A schema version integer is not lineage proof. When independently developed
  stores reused version 3, migration had to inspect the complete compact
  fingerprint/LSH and generalized-grounding shapes before choosing a lossless
  v4 path. Partial or ambiguous shapes require rebuild rather than inference.
- Source bytes can change A→B→A while a compiler runs. Final source hashing alone
  cannot detect facts extracted from B; extraction must be bound to A.
- Graph diagnostics and remediation commands must be truthful. Do not recommend
  a command for a state it cannot safely repair.
- A bounded limit is not one kind of thing. A **per-file** ceiling means one
  file cannot be parsed and every other file still can, so it must skip and
  report; a **corpus-wide** ceiling means the run has no honest partial answer
  and must abort. Conflating them lets one pathological file take a whole
  repository's graph with it. Classify the breach, never the fact of one.
- Do the skipping at the single discovery seam. Indexing, publication
  verification, sync's corpus comparison and freshness inspection must all agree
  about which files exist, or a file skipped by one and expected by another
  makes the index permanently unable to read `fresh`.
- Never infer which limit was breached by comparing byte values. Two limits can
  hold the same number, and then the comparison silently reports the wrong one
  forever. Pass the limit's name.
- A containment guard has two separable decisions: whether to decline, and what
  declining does. Read paths already treated an out-of-root source as a soft
  miss while config paths threw on the identical condition — an inconsistency
  inside one class that cost whole repositories their graph. An existence probe
  is not a read request: the honest answer for a path we will not read is
  "absent", recorded as a diagnostic so the degradation is visible.
- Report a declined out-of-root path by dependency specifier, not absolutely.
  The compiler resolves a bare specifier by walking every ancestor directory, so
  one unresolvable name yields a dozen near-identical entries carrying absolute
  paths from outside the repository into product output.
- Any per-repository discovery input — a configured ignore list included — must
  enter the corpus policy hash, or changing it leaves a stale index silently
  describing files that are no longer in the corpus. Hash to the existing
  constant when nothing is configured, so existing indexes stay valid.
- A freshness input is not one kind of thing. Engine identity — schema,
  compiler, extractor, resolver, grammar, corpus policy — says the store was
  written by code that is gone, and must fail closed. Config content says the
  build inputs moved under a store that still describes its source exactly.
  Folding both into one hash means the second is served the punishment of the
  first, and a dependency bump takes every structural read with it.
- Prove identity by reconstruction, not by a new stored field. Re-folding the
  current inputs with a store's recorded config hash classifies stores written
  before the check existed — which are exactly the stores that need it — and
  covers inputs no snapshot records at all.
- Separate the race check from the freshness check inside one validation. Two
  observations disagreeing with each other is a race; either of them disagreeing
  with the stored snapshot is the question the caller already answered. Mixing
  them reports a race that did not happen and refuses a read that was safe.
- A degraded answer must say which half of itself is degraded. Definitions,
  containment and verified source bytes survive a config change; anything
  reached by following an edge does not. Labelling everything is honest but
  wastes a trustworthy answer; labelling nothing is a lie.
- Wiki grounding admits only parse-only degradation through its own snapshot
  bridge. Exact nodes and fingerprints must come from files recorded as fully
  parsed; source or configuration drift still refuses. Do not reconcile a
  missing target against an incomplete corpus or infer that it is gone. Carry
  the bounded incomplete-file reason through reads and rejected writes, and
  retain the complete final snapshot/source revalidation before publication.
  Test real Wiki apply for healthy and partial files plus source/config drift;
  do not relax the general GraphPort gate to make grounding work.
- Commit output under the class it was labelled with. If the store changes class
  between opening and output, discard the response rather than relabelling it —
  the records were built under a claim they no longer earn.
- Do not unify two gates by giving both the stricter one. Scope tolerates
  drifted source because it re-admits a moved file as text-only evidence; the
  targeted commands cannot, because they return exact node coordinates. One
  vocabulary and one classifier is the unification; one tolerance is a
  regression wearing its clothes.
- `degraded` is not `unusable`, and conflating them costs a repository its
  graph twice over. A candidate whose only fault is a file the policy skipped
  must publish, or the skip path produces a candidate the publish gate throws
  away; a store with a partial parse must read, or one unparseable file answers
  nothing. Enumerate which shortfalls are known, bounded and reportable, and
  admit exactly those.
- Adding a diagnostic code is half the change. Every allowlist that enumerates
  codes — publication, repair, refusal ranking — has to learn it in the same
  commit, or the new code silently means "refuse".
- Serving around a gap requires the gap's *complete* extent. Excluding drifted
  files is only safe while the drifted list is exhaustive, so bind it to the
  ceiling that truncates the list and refuse past it. A partial exclusion set is
  worse than refusing outright.
- Distinguish out-of-date from incomplete when labelling. Drifted config makes
  resolved edges untrustworthy; an unfinished parse makes the answer smaller
  while everything in it stays true. One label for both teaches the reader to
  ignore the label.
- Hash a config input by what it changes, not by its bytes — and fail towards
  over-invalidation. A version bump or a reindent invalidating an index is
  noise; a resolution-affecting field missing from the projection is a stale
  index reading as current with no label at all.
- A re-resolved path comparison is a name check, not an identity check. On a
  case-insensitive volume the same file can come back spelled differently — a
  path routed through the TypeScript compiler host arrives lowercased — and a
  byte comparison then rejects a file whose device, inode, size and timestamps
  all match.
- Wall-clock status timings vary by machine and process-start overhead. Keep
  the benchmark non-gating, record its environment, and protect correctness
  with deterministic race, non-mutation, and bounded-work tests.
- An active outer transaction does not establish rollback ownership. Omitting
  the nested fingerprint savepoint is safe only for the explicit full-publisher
  path. A failed multi-value bucket statement may have written a partial prefix;
  standalone writes must restore the entire batch before returning an error.
- Construction in a child process does not transfer the parent's maintenance
  lease or publication authority. Wait for child `close` before candidate or
  workspace cleanup and recheck directory identity, including full-width
  device/inode values. A parent-lifetime pipe can stop a busy child after parent
  death; it cannot run cleanup in a parent killed by `SIGKILL`.

## Verify

- [ ] Added, modified, deleted, same-size/restored-mtime, branch, config,
      grammar, extractor, and policy drift cases are deterministic.
- [ ] Active/unreadable WAL and rollback journals never produce `fresh` or a
      false corruption diagnosis.
- [ ] Missing, legacy, newer, malformed, and structurally corrupt schemas have
      accurate diagnostics and safe remediation.
- [ ] Every recognized historical lineage and complete hybrid migrates through
      a locked candidate; partial hybrids fail without changing prior bytes.
- [ ] Source/config symlink escape, retarget, atomic replacement, and ABA tests
      preserve the prior snapshot.
- [ ] Failed parse/stage/publication tests preserve prior facts and metadata.
- [ ] Fingerprint foreign-key and partial bucket failures restore complete
      batches when caught inside an outer transaction; publisher failures roll
      back all graph facts. Duplicate/ref/alias output remains identical.
- [ ] Reused statements remain correct after rollback and while independent
      iterators are active; closing one connection never affects another.
- [ ] Candidate replacement, candidate WAL, rollback, maintenance-lock, and
      first-publication failure tests leave either the prior graph or no graph.
- [ ] Ordinary check, doctor, dashboard, and status paths do not change graph
      bytes, sidecars, metadata, or directory mtimes.
- [ ] `get`, `query`, and `impact` return no partial records when freshness,
      source identity, sidecars, or the selected database change mid-read.
- [ ] `npm run typecheck`, `npm test`, `npm run eval:test`, and `npm run build`
      pass, along with protocol-v3 goldens and `git diff --check`.
- [ ] Only intended paths are staged; generated graph databases and unrelated
      working-tree files remain excluded.

## Debug

First separate transient writer activity from durable corruption. Compare the
persisted snapshot, exact `files(path, content_hash)` rows, current corpus and
config hashes, Git observations, and required reader invariants. When a race
test fails, verify which layer re-read the filesystem after secure discovery;
fix that boundary instead of adding timing delays.

## Update Scaffold

The 2026-09-09 update records the owned-transaction and statement-lifetime
contracts from the branch implementation. Existing `grounds_to` fingerprints and
`bodyHash` values are retained unchanged; this upkeep does not authorize baseline
renewal. See `docs/design/code-graph-performance-implementation.md` for evidence
and remaining process/memory limits.

- [ ] Update `.mex/ROUTER.md` when freshness, refresh, or recovery capabilities
      move from "Not Built" to "Working".
- [ ] Add new graph failure modes to this pattern after they are reproduced and
      covered by a deterministic regression.
