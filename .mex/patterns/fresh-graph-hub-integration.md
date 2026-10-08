---
name: fresh-graph-hub-integration
description: Connect graph reads and maintenance to the Project Hub without mixed snapshots, implicit writes, reranking, or private-data leakage.
triggers:
  - "Hub graph integration"
  - "Code workspace"
  - "graph Search"
  - "graph Hub job"
edges:
  - target: "patterns/safe-graph-snapshot-evolution.md"
    condition: "when changing freshness, graph storage, source binding, or recovery"
  - target: "patterns/secure-local-project-hub.md"
    condition: "when changing Hub routes, sessions, safe projections, SSE, or jobs"
  - target: "context/architecture.md"
    condition: "when reviewing the current Graph-to-Hub architecture and boundaries"
last_updated: 2026-10-08
mex:
  id: mx_01M1M0CJKZF3ABC1PQREMA2HYR
  type: pattern
  status: promoted
  revision: 5
  title: fresh-graph-hub-integration
  grounds_to:
    - node: function:9099fdd7e5562f7507cc7e80a6d67f1e
      fingerprint: mh:64:7b226d696e68617368223a5b3338343339353539392c3237373830313739312c3336343837333436342c3133333736323339322c3130343134353832392c3137333839303837342c32303233313037332c3136343636383233302c3230373336363633382c39343130363139302c31323737373330382c3234313339333036342c36373436383937392c34323033363635302c3130323430373533322c3432393332353934342c3335393738343539302c3431353233383433382c3332383330363734342c37393036383735302c3235363930313935312c3136313037363637322c31333237323838382c3133363132393437332c38373234323032382c32363630383036312c38393131383238382c33333034343436332c38303931323832392c35323135393631352c31313636313734322c3130353438343630372c3133393836373033372c363938343133322c34313937383934302c3335313637383438312c3336353532303338352c38373437363636392c3131323031323936302c33393835363239302c3136333033393237392c31353539383738382c3134323433393336332c36313331363735352c3133353934303338382c36393336313532312c3330383034373531392c3133323433333931312c3137353937373239322c3134323935373036382c3231303439323636322c33393833373439372c33333333333239362c31383234373139322c3237313937323631392c3130353330383037312c35323732302c34383834353436352c3235303434323137372c32323931323839392c3233383733383337392c3337333435333133382c34313838363236372c3438343631373038335d2c226e65696768626f7273223a5b2266756e6374696f6e3a3131383032343863656464343931646239623666383631323833633763393636222c2266756e6374696f6e3a3138383832306166333166306437346336353138663639323666353539383737222c2266756e6374696f6e3a3163623830396337356539346633346638666264613730373635363138656439222c2266756e6374696f6e3a3330323137343238636635393161313032643432616466643432373137353937222c2266756e6374696f6e3a3338396666383663356266363134343636326133376137333933343733353766222c2266756e6374696f6e3a3563623232363335316564333266336634623032353664393130383263396562222c2266756e6374696f6e3a3566646433323864346239316539313933363334306536663566643263303837222c2266756e6374696f6e3a3732303565313864303639346634326662323835316164663539303062373664222c2266756e6374696f6e3a3735666137366562313262636166653130396233353566663335333466336432222c2266756e6374696f6e3a6138313535326332616431626336326530366633323437366236656430326433222c2266756e6374696f6e3a6336376161353630383132623862393439343731376437623931376464623965222c2266756e6374696f6e3a6436303832383431363761393765376234323766313232373265373962656130222c2266756e6374696f6e3a6661633464663932326238313736373730643730616538386532313535353561225d2c22746f6b656e436f756e74223a32397d
      bodyHash: bd58f511f859c501afa8b299036c4a5c04abeb00617c5cb67b3c7f7705ddb50d
    - node: function:188820af31f0d74c6518f6926f559877
      fingerprint: mh:64:7b226d696e68617368223a5b373433353431352c32303837323537362c393637323936362c33353634353436352c33323835393138332c33323130333633352c323731343330352c35363734313536392c343530303331372c33303830333437372c31323737373330382c37333733383531322c36373436383937392c34303433393538372c32353330363039302c35393637383033382c31383430383836372c33313537383431312c3131393634363539362c34303734313035372c32373738313639332c32343833313333342c31313832313139322c363132313633372c38373234323032382c32363630383036312c38303633303233372c33383832333435302c33353938393237362c35323135393631352c34393838343935362c393035313332372c31363630343834302c34323334313735352c34313937383934302c33333238393338352c32393236363632382c393837393030332c32393138303039332c39373030313335322c36303334363735342c31353539383738382c383636373430332c32313037393237362c31343137383630322c34333036333636372c31383833373332382c343837343537302c38333939353237372c33313234353233352c393934393334312c32363039333835392c31393132353135312c31383234373139322c34393738303838392c343739383336372c35323732302c37383436363333302c333531303033312c33313435363331372c32343134303533392c31343233393535322c37363837363831382c38393633303336345d2c226e65696768626f7273223a5b2266756e6374696f6e3a3037316334616535303764333136353432646261646431333666343463643064222c2266756e6374696f6e3a3136663131303861333439653062396631363531303534363431346166316566222c2266756e6374696f6e3a3733343632383439386531363566303135636335393536343035656433396638222c2266756e6374696f6e3a3737663030643834313835613033333638386135323130346339363131343834222c2266756e6374696f6e3a3738633134613135323539386330306365313466363562383363663738373062222c2266756e6374696f6e3a3739613661336335623462623261343930613433616563646162613364613533222c2266756e6374696f6e3a3766353665353264633034643164616435663231336332316565306332376539222c2266756e6374696f6e3a3839343866633966626535366631396161333262323630363537303730313139222c2266756e6374696f6e3a3930393966646437653535363266373530376363376538306136643637663165222c2266756e6374696f6e3a6361383862343565353837333233383830623038663839643261666663626265222c2266756e6374696f6e3a6437656437303063323961396164383835646237636561346230623936616362222c2266756e6374696f6e3a6530643230663433336466653034386263303031656366346533643363316261222c2266756e6374696f6e3a6563663166623435616332393130643032626337386636663736316330313435222c2266756e6374696f6e3a6635646636333436633338326532383637636466363739353030303838346262222c226d6574686f643a3234396630326630323666333331616664316662313433326265323738303930222c226d6574686f643a3237393531623036343835636563636566313037396238373062396364393566222c226d6574686f643a3432613635353630333762633731656539363962333638373636316266646261225d2c22746f6b656e436f756e74223a3336317d
      bodyHash: a76089b6ddc3bee9989562c0d5b5b0824d671d8dff9c868dd74640ce486a8e92
  relations:
    - type: related_to
      target: mx_01M1M0CJP81C590FCKTSN5HA3Q
      note: when changing freshness, graph storage, source binding, or recovery
    - type: related_to
      target: mx_01M1M0CJQ2BSV71G1C7TXZD9RH
      note: when changing Hub routes, sessions, safe projections, SSE, or jobs
    - type: related_to
      target: mx_01M1M0CJ5C5XQV0HM5VM787WQS
      note: when reviewing the current Graph-to-Hub architecture and boundaries
---

# Fresh Graph Hub Integration

## Context

The Hub composition in
[`runHubCommand()`](mex://function:188820af31f0d74c6518f6926f559877)
is a consumer of the internal `GraphPort`, not another graph engine.
Graph reads may return source only after proving that indexed facts, the
published snapshot, and the exact live source bytes describe one repository
observation. Graph maintenance is a separate, explicit user action. The Hub
must not open graph SQLite directly, shell out to `mex graph`, fuse rankings,
or make Wiki availability appear real.

## Steps

1. Bind one package-private repository adapter through
   [`createRepositoryGraphPort()`](mex://function:9099fdd7e5562f7507cc7e80a6d67f1e).
   Implement the frozen `GraphPort` by calling Lane A modules directly; do not add a package-
   root export, raw SQLite callback, or public CLI subprocess. Production Hub
   maintenance selects Lane A's private candidate process; read paths retain
   their existing immutable-session contract.
2. Route every graph-derived response through the complete freshness handshake:
   inspect a stable `fresh` graph, adopt one inode-bound immutable SQLite
   session, read graph facts and hash-matched contained source, build the whole
   bounded response in memory, revalidate database/snapshot/source freshness,
   and only then release it. Discard the complete response on any final mismatch.
3. Batch facts that must agree. Search symbols and sources through one
   `searchBundle()` session; assemble symbol identity, source, and the selected
   callers/callees/impact view through one `readSymbolWorkspace()` session.
4. Preserve engine order and scores. Keep Wiki, symbol, and source groups
   separate, with independent cursors and group-local cursor failures. Never
   rerank graph output or fuse scores across domains.
5. Bind each canonical base64url cursor to its operation, snapshot hash,
   normalized request (including limits and workspace view), and offset. Treat
   a request mismatch as `VALIDATION_FAILED` and a snapshot mismatch as
   `REVISION_CONFLICT`. Keep normal pagination separate from safety truncation.
6. Project only allowlisted fields into private Hub contracts. Bound source,
   paths, diagnostics, matched terms, relations, impact, and the serialized
   response. Map internal failures to stable MEX Problem Details without raw
   SQLite, Git, filesystem, recovery-path, stderr, or stack information.
7. Derive graph job eligibility from the current structured Health observation,
   then revalidate it immediately before durable job creation. For a non-fresh
   graph, a missing or unsafe remediation command is not an enabled control; a
   structurally fresh graph may explicitly allow both operations.
8. Run refresh/rebuild only through injected executors. Pass the job
   `AbortSignal` into Lane A, persist only fixed phases and trustworthy numeric
   counts, retain the Hub generation/lease checks, and let Lane A's cross-process
   maintenance lock arbitrate Hub and CLI writers. Rebuild requires the browser
   confirmation step; neither operation runs during an ordinary read.
   The parent owns the lease, candidate validation, publication and rollback.
   The private child only constructs the candidate. Wait for process closure
   before cleanup, terminate disconnected/cancelled children, and use a parent
   lifeline independent of the busy compiler thread. Keep the public API fixed.
9. Derive Wiki availability independently from the registered adapter and its
   current health. Keep unavailable states honest, and never fill Graph or Wiki
   gaps with production fixtures.

## Gotchas

- Existing broad entities need an explicit knowledge upgrade, not a setup
  rerun. `mex wiki upgrade` is read-only by default and caps its agent review
  batch at 50 grounded non-Fact entities. `--apply` uses the same agent chooser
  as sync or emits a copyable prompt when no CLI is installed. Fresh-graph and
  candidate-drift preflight run before an agent starts. Preserve parent ids and
  inbound references; semantic claim splitting needs review. Successful agent
  exit is not evidence that every candidate is granular; rebuild, check and
  review the diff without an automatic Git operation.

- Splitting grounded claims into section entities does not create canonical
  relationships. `mex wiki link-sections` previews a bounded structural repair;
  `--apply` records `refines` links to existing enclosing entities through the
  ordinary atomic operation batch. It preserves claim bodies and groundings,
  skips read-only, archived and Spec/Team records, and refuses duplicate ids.
  The bounded Hub overview reserves at most 25 places for authored `refines`
  targets omitted by its initial page, so parents remain visible without
  raising the 100-node or 500-edge output caps. Semantic dependencies still
  require evidence and are never inferred from keywords or shared symbols.

- Group repeated Health messages by safe text and severity in the browser, with
  occurrence counts and expandable code/path details. Keep individual diagnostics
  in the API, its existing bounds, and the underlying health assessment unchanged.
- A fresh status observed before a request is not a freshness proof for its
  response. Final revalidation is mandatory, including after source reads.
- An immutable SQLite handle still needs inode, sidecar, and snapshot binding.
  Atomic database replacement and WAL activity must fail visibly.
- Source must come from one contained, fd-stable buffer whose decoded hash
  matches the indexed row. Never pair an old declaration with newly read text.
- A group-specific bad cursor may fail only that Search group, but final
  freshness invalidation invalidates both graph groups and returns no partial data.
- `nextCursor` means another normal page exists; `truncated` means a safety or
  content bound omitted data. They are not interchangeable.
- Health capability is structural. A missing index can still expose a safe
  rebuild operation, while writer activity or an observation race exposes no
  repair control.
- Job progress messages can contain paths or source details. Persist phase and
  numeric counts only; discard the message.
- Graph counts describe parsed files. Keep persisted progress monotonic, label
  those counts explicitly, and show a numeric bar only during parsing. The
  final validation/publication phases do not inherit a 100% completion claim.
- Process isolation releases the child's working set when it exits; it is not
  a peak RAM quota. Parent status inspections, copies and final publication
  still include synchronous work. Measure actual HTTP/cancel latency as well
  as aggregate resources. Fatal parent death stops the writer via its lifeline
  but may leave private temporary artifacts; do not delete by a guessed prefix.
- Successful graph maintenance invalidates cached Search, Code, Health, Jobs,
  Home, Overview, and capability queries. It does not authorize automatic
  maintenance later.

## Verify

- [ ] Search and Code use one initial and one final freshness observation and
      return no partial response after database, snapshot, source, WAL, or ABA races
- [ ] Symbol/source ranking and relation ordering match the engine exactly
- [ ] Cursor operation, request, limit, view, and snapshot binding are covered
- [ ] Missing, stale, rebuild-required, corrupt, degraded, and interrupted
      states map to stable safe errors
- [ ] Source, relation, impact, diagnostic, cursor, and 1 MiB response bounds pass
- [ ] Host/session protection covers reads; Origin, JSON, and CSRF protect jobs
- [ ] Refresh/rebuild contention, cancellation, late progress, restart, and
      shutdown preserve the last trustworthy graph and never mutate source
- [ ] Read-only endpoints leave Graph/Wiki files, Git, worktree, Activity, and
      local state byte- and mtime-identical
- [ ] Packed Search/Code/Health and real refresh/rebuild jobs pass without public
      declaration leaks or production fixtures
- [ ] Graph protocol goldens, evaluator tests, TUI regressions, typechecks,
      browser accessibility, package smoke, and `git diff --check` pass

## Debug

First classify the failing boundary: request validation, current graph status,
immutable-session adoption, indexed source binding, final freshness, safe Hub
projection, durable job ownership, or Lane A maintenance. Preserve the stable
MEX code and reproduce the exact boundary. Do not fix freshness failures by
retrying inside an ordinary read or by returning the already-buffered subset.

## Update Scaffold

- [ ] Update `.mex/ROUTER.md` when Graph or Wiki Checkpoint 2 capability changes
- [ ] Update `docs/design/hub-graph-integration.md` when a bound, error, or
      freshness/job invariant changes
- [ ] Keep `src/index.ts`, graph protocol output, ranking, and `mex tui` unchanged
      unless a separate public-boundary change explicitly owns them
