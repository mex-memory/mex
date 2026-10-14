---
name: secure-local-project-hub
description: Safe workflow for loopback-only Hub APIs, browser sessions, packaged assets, and explicit local jobs.
triggers:
  - "Project Hub"
  - "Hub API"
  - "Hub job"
  - "browser session"
edges:
  - target: "patterns/local-first-team-state.md"
    condition: "when persisting a Hub job or migrating team.db"
  - target: "context/architecture.md"
    condition: "when wiring a real Graph or Wiki adapter"
last_updated: 2026-10-09
mex:
  id: mx_01M1M0CJQ2BSV71G1C7TXZD9RH
  type: pattern
  status: promoted
  revision: 11
  title: secure-local-project-hub
  grounds_to:
    - node: function:188820af31f0d74c6518f6926f559877
      fingerprint: mh:64:7b226d696e68617368223a5b373433353431352c32303837323537362c393637323936362c33353634353436352c33323835393138332c33323130333633352c323731343330352c35363734313536392c343530303331372c33303830333437372c31323737373330382c37333733383531322c36373436383937392c34303433393538372c32353330363039302c35393637383033382c31383430383836372c33313537383431312c3131393634363539362c34303734313035372c32373738313639332c32343833313333342c31313832313139322c363132313633372c38373234323032382c32363630383036312c38303633303233372c33383832333435302c33353938393237362c35323135393631352c34393838343935362c393035313332372c31363630343834302c34323334313735352c34313937383934302c33333238393338352c32393236363632382c393837393030332c32393138303039332c39373030313335322c36303334363735342c31353539383738382c383636373430332c32313037393237362c31343137383630322c34333036333636372c31383833373332382c343837343537302c38333939353237372c33313234353233352c393934393334312c32363039333835392c31393132353135312c31383234373139322c34393738303838392c343739383336372c35323732302c37383436363333302c333531303033312c33313435363331372c32343134303533392c31343233393535322c37363837363831382c38393633303336345d2c226e65696768626f7273223a5b2266756e6374696f6e3a3037316334616535303764333136353432646261646431333666343463643064222c2266756e6374696f6e3a3136663131303861333439653062396631363531303534363431346166316566222c2266756e6374696f6e3a3733343632383439386531363566303135636335393536343035656433396638222c2266756e6374696f6e3a3737663030643834313835613033333638386135323130346339363131343834222c2266756e6374696f6e3a3738633134613135323539386330306365313466363562383363663738373062222c2266756e6374696f6e3a3739613661336335623462623261343930613433616563646162613364613533222c2266756e6374696f6e3a3766353665353264633034643164616435663231336332316565306332376539222c2266756e6374696f6e3a3839343866633966626535366631396161333262323630363537303730313139222c2266756e6374696f6e3a3930393966646437653535363266373530376363376538306136643637663165222c2266756e6374696f6e3a6361383862343565353837333233383830623038663839643261666663626265222c2266756e6374696f6e3a6437656437303063323961396164383835646237636561346230623936616362222c2266756e6374696f6e3a6530643230663433336466653034386263303031656366346533643363316261222c2266756e6374696f6e3a6563663166623435616332393130643032626337386636663736316330313435222c2266756e6374696f6e3a6635646636333436633338326532383637636466363739353030303838346262222c226d6574686f643a3234396630326630323666333331616664316662313433326265323738303930222c226d6574686f643a3237393531623036343835636563636566313037396238373062396364393566222c226d6574686f643a3432613635353630333762633731656539363962333638373636316266646261225d2c22746f6b656e436f756e74223a3336317d
      bodyHash: a76089b6ddc3bee9989562c0d5b5b0824d671d8dff9c868dd74640ce486a8e92
    - node: function:16f1108a349e0b9f16510546414af1ef
      fingerprint: mh:64:7b226d696e68617368223a5b373433353431352c36333731363931342c383238393435362c33353634353436352c383437343439372c31353134323938362c323731343330352c35363734313536392c31313231343030312c353336313837332c31323737373330382c313837333734322c33363432333233312c31363539313035372c32353330363039302c32303930393138372c32303135383230302c3732393035382c373139333232332c333632333835342c39343838322c32333030313132372c363838333432392c31363431303631342c32393838353035362c31383937383634382c313939303833342c31353630373931342c3239313133352c31303332333734382c31313636313734322c32313535363234322c31373536313039372c363938343133322c34313937383934302c3735333136352c33313335333138302c33313334383735312c383338303431362c33353230333730372c34343739373538342c33323134343038382c363733393930352c31303632373234302c31343137383630322c34373337313639322c353934313334382c343837343537302c37313437323831372c333331333935372c393934393334312c34363133333730362c3737353231392c353530313330302c34393738303838392c373936373930382c35323732302c33363530303737372c33353033393935372c343136313837362c32303636333635332c31343233393535322c32363038393638372c31363630313236315d2c226e65696768626f7273223a5b2266756e6374696f6e3a3035376231393362613730363534306131623938633731316332663532326530222c2266756e6374696f6e3a3138383832306166333166306437346336353138663639323666353539383737222c2266756e6374696f6e3a3262316139356264366639376566613436343235653562363261656630626134222c2266756e6374696f6e3a3564303538393532333264396436386263333466656130376530333638363063222c2266756e6374696f6e3a6263616531316330653665343662313237663139623539373332323132656236222c2266756e6374696f6e3a6661633464663932326238313736373730643730616538386532313535353561225d2c22746f6b656e436f756e74223a333435347d
      bodyHash: 8518d6e3ca65c5d4d5ab8b55fc5c7eadafd2b85ddc5ba1ecdf402c1c61e97f29
  relations:
    - type: related_to
      target: mx_01M1M0CJMRWZY5TZCEBSFJPAHT
      note: when persisting a Hub job or migrating team.db
    - type: related_to
      target: mx_01M1M0CJ5C5XQV0HM5VM787WQS
      note: when wiring a real Graph or Wiki adapter
---

# Secure Local Project Hub

## Context

The Project Hub composed by
[`runHubCommand()`](mex://function:188820af31f0d74c6518f6926f559877)
is a local browser control room, not a remotely exposed service.
Its API contracts and web workspace are private implementation boundaries. Hub
reads must be honest and side-effect free; explicit Graph/Wiki maintenance runs
as durable, bounded jobs in `.mex/local/team.db`. Team mutations use signed
preview/apply services.

## Steps

1. Bind the HTTP listener to exactly `127.0.0.1`. Validate the native request
   target before URL normalization and validate Host on every request.
2. Exchange a high-entropy, one-use bootstrap token for a process-memory
   HttpOnly session. Require exact Origin, JSON content type, and CSRF proof for
   every subsequent mutation; never add CORS or proxy trust.
3. Build the private route surface through
   [`createHubApp()`](mex://function:16f1108a349e0b9f16510546414af1ef),
   then parse requests and responses through the shared Zod contracts. Bound
   bodies, cursors, result counts, serialized responses, diagnostics, and SSE
   subscribers. Project internal failures to safe Problem Details.
4. Project repository-backed reads through an allowlist rather than serializing
   storage records directly. Keep pagination state separate from source-scan
   truncation, and retain immutable recorded identity beside mutable display
   resolution.
5. Serve only the built index plus manifest-known hashed assets. Do not join an
   arbitrary URL path to `dist/hub`.
6. Acquire the repository Hub lease before startup reconciliation. Persist only
   allowlisted job phases, numeric progress, terminal summaries, and safe
   problems; never persist prompts, source, diffs, commands, or secrets.
7. Reject unsupported Graph/Wiki actions as unavailable. Mocks belong only to
   development and tests and must be removed by the production build.
8. Close HTTP intake before job shutdown, keep the durable active slot until an
   executor settles, and fail closed when ownership or persistence is uncertain.
9. Build root code before Vite so the final `dist/hub` survives tsup cleanup,
   then verify a clean packed installation can bootstrap and load it.

## Gotchas

- Setup failures need a browser-safe explanation at the producer. Use the
  internal `SetupError.userMessage` contract for expected failures; retain raw
  filesystem, Git, worker, and database diagnostics in `message`/`cause` only.
  Classify maintenance codes and use registry-owned Wiki remediation rather
  than forwarding exception text. Keep both run error fields within 512
  characters, preserve cancellation precedence, and test the real runner's
  failure and retry path as well as mocked error projection.
- WHATWG URL construction normalizes traversal and backslashes; native request
  targets need their own pre-normalization gate.
- A HEAD request may be routed through a GET handler. Reject it before reserving
  an SSE subscriber.
- Authentication at stream creation is insufficient: an SSE stream must close
  at absolute session expiry.
- A second Hub process must not reconcile or release work owned by a live first
  process. Use a token-bound local lease and recover only a provably dead PID.
- Bundlers can rewrite a static `node:sqlite` import. Load it through
  `createRequire(import.meta.url)` and smoke-test the packed CLI.
- Packed setup fixtures that hide agent CLIs must retain directly executable
  Git. On Windows, expose native `git.exe` in its installation directory;
  a `git.cmd` wrapper cannot satisfy a shell-free Git spawn. Preflight Git and
  agent absence with the setup child's exact working directory and environment,
  using an absolute lookup tool so a missing probe cannot imply agent absence.
- Terminal SSE events should close the browser connection immediately; do not
  let `EventSource` reconnect to a finished job. Setup population pause is a
  terminal setup-run status: return the prompt on the run snapshot, then close
  the stream. Hub jobs still persist no prompts.
- New code checkouts stay in setup until population and finalization finish and
  the existing Team authority check accepts the committed scaffold identity.
  Show the Git checkpoint explicitly, with a bounded setup-file diff and a
  separate user-requested local commit action. Preview and apply are authenticated
  POSTs; bind reviewed files, HEAD, branch, and index to one expiring process-local
  revision and revalidate before committing. Scope the candidate to canonical
  setup files and selected agent assets; exclude generated databases, local state,
  and unrelated project files. Preserve unrelated staged entries. Never push.
  Render complete unified diffs as numbered context/addition/deletion rows with
  explicit change markers and counts. Hide only recognized Git bookkeeping;
  preserve file-mode and missing-newline information. Verify hunk counts before
  formatting, mount source rows only for expanded files, and bound formatted
  rows per file and across the review. Keep the exact raw diff available when
  parsing, truncation or rendering limits prevent a complete formatted view.
  Build the exact reviewed tree with an alternate index, create its commit object
  with the reviewed parent and configured identity/signing, then publish through
  a prepared Git ref transaction with the expected old HEAD. Revalidate the
  symbolic branch while Git holds its ref locks; install only the reviewed index
  entries alongside the preserved unrelated entries. Review authorization expires
  after five minutes; cap it at 200 text files, 256 KiB per file, 32,768 diff
  characters per file and 131,072 diff characters in total. Bound review/apply
  operations to 60/120 seconds. Active commit/reference hooks, custom content
  filters, detached HEAD and incomplete reviews retain the manual Git option.
  Return the saved commit receipt even if subsequent Hub promotion fails, so
  retries cannot duplicate a successful commit. If index installation cannot be rolled back
  safely, retain its recovery file and require manual recovery before retrying
  promotion. Promotion replaces
  the app on the existing session and port, and its failure must fail the run.
  Existing committed projects still open Hub with missing disposable indexes
  so Health can offer repair. Agent-memory mode remains separate, even in Git.
  Full Hub returns `CAPABILITY_UNAVAILABLE` for `/api/v1/setup`.
- Do not spawn interactive `mex setup` from Hub. Reuse `runHeadlessSetup()` so
  detect → scaffold → tools → skills → identity → scan → graph → population →
  finalize stay one path. Code-repo without git is a 400; the UI shows `git
  init` and never runs it.
- Browser population owns an asynchronous headless CLI process, a private
  prompt, a bounded deadline, and cancellation of its process tree. Graph
  construction uses an isolated worker. Shutdown waits for setup to settle;
  cancellation during promotion closes newly composed jobs before app swap.
  Keep command construction shared with the terminal adapter and expose only
  fixed, safe failure categories, never raw child diagnostics.
- Claude stream-json and Codex JSONL activity remain a closed vocabulary for
  timing and completion. The explicitly requested setup console has a separate
  projection of visible assistant prose plus fixed, compact tool labels such
  as "Ran a command" and "Read a file". Drop tool arguments, command text, paths,
  and results before transcript retention and delivery; keep prose as the main
  content. Exclude provider user/system message blocks, reasoning, session
  identifiers, usage metadata, and raw diagnostic envelopes. Render prose literally
  with terminal controls removed and recognizable credentials masked; masking
  is best effort, not a guarantee that arbitrary output contains no secrets.
  No transcript content enters telemetry, durable jobs, or canonical knowledge.
- Keep transcript retention process-local and bounded by both UTF-8 text bytes
  (1 MiB) and entry count (2,048), with bounded ingress and 4,096-character
  entries. Send at most 32 entries per cursor page through an authenticated SSE
  endpoint; report lost history on eviction, validate the run identity, honor
  Last-Event-ID, and expire even backpressured streams. Subscriber notifications
  carry no output backlog. Never put the transcript into repeated run snapshots.
  Browser retention is independently bounded, with a limited text/row window,
  literal selectable text, stable scrollback, and explicit Follow latest.
- Allocate a setup transcript identity only after the first retained agent
  output, then announce it on the run snapshot. Starting or checking setup can
  skip the agent entirely; commit checks, manual population, and finalization
  must not fabricate an empty session. Show real startup activity until output
  arrives, and retain actual session history through finalization and commit
  review. Verify both the absent-session path and replay after a page refresh.
- Cap individual provider records, tool correlation, and SSE cadence; discard
  malformed/oversized records and require recognized terminal success. Claude
  partial/final text, Codex cumulative assistant text, and tool lifecycle
  reports require deduplication.
  Cancellation drops pending text flushes and prevents late writes to another
  run. Activity timestamps advance only from real startup/provider reports;
  browser clocks show elapsed/quiet time without API polling or invented percent
  completion. Output-format flags do not require another AI session or change
  the installed CLI's existing authentication configuration.
- Persist setup mode and explicit empty tool choices. Terminal snapshots
  invalidate setup readiness and Hub capabilities; recover stream disconnects
  because promotion can finish before the browser connects to SSE. A confirmed
  completed setup can retry promotion without repeating AI or Graph work.
- Keep SetupPage and its contract lazy. Release guards track its exact `/setup`
  redirect separately from operational routes and enforce a separate setup
  asset allowance without relaxing existing Home or workbench budgets.
- A paginated source can hit its corpus safety bound independently of having a
  next page. Expose these as separate signals; never turn an incomplete scan
  into an exact total or silently mix revision-bound pages.
- Canonical team events may contain metadata and legacy rows may contain cwd,
  trace, or origin fields. Hub read models must omit those fields and bound
  subject/message previews before response validation. Schema-v2 Activity
  workflow/custom origin and optional labels use their closed projections.
- The Overview team-access card POSTs an allowlisted name/email payload (and an
  optional follow-up) from the browser to `https://api.web3forms.com`. CSP
  `connect-src` names that host only; Hub must not proxy repo, path, graph, or
  machine data, and page load must not initiate that request.
- Keep optional Home dialogs and their styles behind an explicit open-on-demand
  import; even shared dialog controls can exceed Home's frozen asset budget.
  Bound external submissions across both the request and response-body read,
  abort on expiry, and release the form for retry or dismissal after failure.

- New read surfaces need successful-job cache invalidation as well as their
  initial query. Context's graph, selected record, and compact code queries all
  refresh after Graph/Wiki maintenance; the Wiki revision can stay unchanged
  while code health or signatures change. Each code projection carries its own
  Graph observation, so do not claim aggregate health across separately observed
  panels is one shared Graph snapshot.

## Verify

- [ ] Host, Origin, CSRF, expiry, traversal, body, response, and SSE bounds pass
- [ ] Hub lease, contention, cancellation, late progress, restart, and retention pass
- [ ] Page loads and local-state reads are non-mutating
- [ ] Repository-backed projections omit raw metadata, trace, and private paths and bound permitted source previews
- [ ] Pagination, revision conflicts, and source truncation remain distinguishable
- [ ] Every route is keyboard reachable and passes automated accessibility checks
- [ ] 1024 and 1440 desktop layouts work; narrower viewports show the guard
- [ ] Production bundles contain no fixture data or external network dependency
- [ ] Packed-install bootstrap and API/UI smoke pass
- [ ] Public library declarations and graph/TUI behavior remain unchanged

## Update Scaffold

- [ ] Update `.mex/ROUTER.md` when a real Hub capability lands
- [ ] Record any new security, packaging, or job-lifecycle trap here
