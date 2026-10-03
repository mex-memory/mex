---
name: local-first-team-state
description: Safe workflow for canonical team Markdown, immutable activity, read-only Git observations, and local SQLite state.
triggers:
  - "team member"
  - "activity event"
  - "Relay handoff"
  - "Catch Up cursor"
  - "local team state"
edges:
  - target: "context/architecture.md"
    condition: "when connecting team state to Hub, Wiki, or graph consumers"
  - target: "context/conventions.md"
    condition: "when changing canonical serialization or validation"
last_updated: 2026-10-02
mex:
  id: mx_01M1M0CJMRWZY5TZCEBSFJPAHT
  type: pattern
  status: promoted
  revision: 10
  title: local-first-team-state
  grounds_to:
    - node: function:ecf1fb45ac2910d02bc78f6f761c0145
      fingerprint: mh:64:7b226d696e68617368223a5b373433353431352c3132323732303938362c34333231363531312c33353634353436352c33363135303535312c3130343838333336322c33363838353338332c33313430343637312c343638333533322c36333931373634362c31323737373330382c32393638323838352c36373436383937392c3939313333352c32353330363039302c37333938383336372c35313135353237332c33313537383431312c34303634393330352c35393938323537352c39343838322c32363737353237332c31313832313139322c363132313633372c33303130303035392c32363630383036312c34373538383437372c34313035303331372c32393337313538392c35323135393631352c323636363836392c32313535363234322c31373536313039372c323137353036332c34313937383934302c35353934333039352c33313335333138302c33313334383735312c33303436323736322c33353230333730372c36303334363735342c31353539383738382c363733393930352c32313037393237362c31393537393830372c33343439363937332c31383833373332382c343837343537302c3131313739383932362c3132353339343330342c393934393334312c323935333738382c33333333333239362c31333038353130352c34393738303838392c343739383336372c35323732302c33373036333434342c31313839303638362c31353736323435352c33383631303733312c31373035323937342c34303538383134372c31363630313236315d2c226e65696768626f7273223a5b2266756e6374696f6e3a3130396366633631303664363562396430353238633531623761366332346461222c2266756e6374696f6e3a3138383832306166333166306437346336353138663639323666353539383737222c2266756e6374696f6e3a3230366131633636613937353965653331633938643161373435333437303831222c2266756e6374696f6e3a3238626264393639356439373162343037636232613434393062316262306639222c2266756e6374696f6e3a3461333936303935396630663064613339336237623763613062633830336431222c2266756e6374696f6e3a3564303538393532333264396436386263333466656130376530333638363063222c2266756e6374696f6e3a3637643930386265356138636439343062383539636639383031623039363034222c2266756e6374696f6e3a3665383730336537316366656139353532343863373133323436386566333932222c2266756e6374696f6e3a3765386262356131303065383333373564376438376466326231356330663136222c2266756e6374696f6e3a3766353665353264633034643164616435663231336332316565306332376539222c2266756e6374696f6e3a3837373036316661366631323163383837646632663163393637383462353562222c2266756e6374696f6e3a3865653530633536653866333662326538346464636261346231336133336138222c2266756e6374696f6e3a3930613061633730656639633638316438393535363331316332346531353738222c2266756e6374696f6e3a3965343136376562303037653139313533316335346338613361373032643165222c2266756e6374696f6e3a6263616531316330653665343662313237663139623539373332323132656236222c2266756e6374696f6e3a6336323038656639346232366362333334663830343261383330373235373439222c2266756e6374696f6e3a6461663462313038633437326264343931366633643636303939383139646137222c2266756e6374696f6e3a6464663639303262626465656334313430663232646562376639613730373634222c2266756e6374696f6e3a6661633464663932326238313736373730643730616538386532313535353561222c2266756e6374696f6e3a6663303862396561626135626435663035383164383361343666343330373839222c2266756e6374696f6e3a6663323661663838656431666635653931366164333635376564376566383761222c226d6574686f643a3337616530326338343039333037336631323130346164663435666339646363225d2c22746f6b656e436f756e74223a3237337d
      bodyHash: 9db4c1956f564e34e3d15d6573036f95f95d7065fb3b2a18c7f67bc7fe4bb8ac
    - node: function:201ea6599d6385efb699b97cce74312c
      fingerprint: mh:64:7b226d696e68617368223a5b373433353431352c36333731363931342c393637323936362c33353634353436352c3130343134353832392c33353635373039332c34343538363335392c3133333539353833302c3132343432393032322c36333931373634362c31323737373330382c313630303532392c36373436383937392c31363539313035372c32353330363039302c38383939313730352c32303137363737352c31353939333639392c36393735353439322c34313130343939302c3131313537353430332c3132303136323731362c363838333432392c363132313633372c32393838353035362c32363630383036312c353332333032342c37363031323737322c33353938393237362c35323135393631352c31383233353831342c32303938353031362c3130363734393236362c3136323036343334332c34313937383934302c3131313430313530342c34343833303330302c393837393030332c383338303431362c32353130323835382c32363538313039382c31353539383738382c363733393930352c32313037393237362c31343137383630322c34373337313639322c31383833373332382c34313635363636302c383730393934332c3231343837363839312c393934393334312c34363133333730362c33333333333239362c31383234373139322c37363836323732342c373936373930382c35323732302c37383436363333302c36333038313734342c32323931323839392c32303636333635332c31373035323937342c37363837363831382c31363630313236315d2c226e65696768626f7273223a5b2266756e6374696f6e3a3231306566353964656639633430376438326135366365653830333662383339222c2266756e6374696f6e3a3833376661373437313837643963306564633133663861623030386164393963222c2266756e6374696f6e3a3865313265306265636437363266313531363038663861366539623465633732222c2266756e6374696f6e3a6634656464666231653532666633376336653939313336643431383562303234225d2c22746f6b656e436f756e74223a3233387d
      bodyHash: dd6226c1a71a88f32c8552c09b3194e3265d975be352e6d0d09fa2c631048137
  relations:
    - type: related_to
      target: mx_01M1M0CJ5C5XQV0HM5VM787WQS
      note: when connecting team state to Hub, Wiki, or graph consumers
    - type: related_to
      target: mx_01M1M0CJ9460AT00V8TH0QCKAC
      note: when changing canonical serialization or validation
---

# Local-First Team State

## Context

[`createRepositoryTeamWorkflowPort()`](mex://function:ecf1fb45ac2910d02bc78f6f761c0145)
assembles the internal Team boundary. Canonical members and activity are one-file-per-record,
Git-tracked Markdown; configured identity and Catch Up cursors are per-user SQLite
under `.mex/local/`. When present, the legacy decision-event JSONL stays byte-for-byte compatible.

## Steps

1. Validate IDs, paths, schema, bounds, and privacy before preparing bytes.
2. Produce deterministic UTF-8/LF frontmatter and SHA-256 revisions.
3. Preview canonical mutations without writes; apply only the exact reviewed plan
   after optimistic and containment revalidation. The shared CLI split is enforced
   by [`runTeamMutation()`](mex://function:201ea6599d6385efb699b97cce74312c).
4. Capture repository facts through the fixed read-only Git port. Never expose a
   raw Git command, stage, commit, or silently repair state during a read.
5. Keep local SQLite reads immutable. Create or migrate only inside an explicit
   write transaction, and require exact revisions plus explicit branch resets.
6. Preserve recorded actors/events. Resolve current display identity as a separate
   projection and surface ambiguity instead of guessing.
7. Serialize mixed canonical/local workflows behind one repository workflow
   lease. Journal only bounded IDs, revisions, paths, hashes, authority, and
   phase state; publish canonical bytes before local cleanup.
8. Treat exact replay as a bounded retained window. A completed journal row is
   terminal proof; incomplete replay must prove branch/HEAD and every durable
   effect before writing, cleaning up, or advancing a phase.

## Gotchas

- SQLite read-only mode can still create WAL/SHM sidecars; use the validated
  immutable read path and refuse active sidecars.
- A page-size limit does not bound a filesystem scan. Cap corpus bytes, rows,
  directory entries, diagnostics, and cursor size as well as returned items.
- Symlink checks must cover every path component immediately before I/O.
- Do not copy the permissive legacy event writer or the process-global Git helper
  into team-state code.
- Production code writes files only. Git publication belongs to the human or test
  harness.
- Reuse an already initialized Git test fixture when adding source/config files.
  Avoid deleting and reinitializing its `.git` merely to build indexes: that adds
  an unrelated repository-reset failure boundary before read-only assertions.
- A page cursor must bind both its filter and the complete bounded corpus
  revision; a position-only cursor can silently skip records after mutation.
- Filesystem collection locks need bounded owner metadata and proven-dead
  recovery. Never remove a live, malformed, foreign-root, or symlinked lock.
- A process-local Wiki patch handle is not recovery state. Persist a body-free
  manifest before apply, require a new preview when nothing landed, and resume
  only an exact operation-specific audit prefix when canonical bytes landed.
- A signed preview that must survive a process restart cannot re-plan a create
  with fresh random identifiers. Bind every engine-minted identifier in the
  receipt, force those exact identifiers during re-plan, and compare the whole
  reviewed presentation before journal intent. Reject hidden batch containers
  as well as disallowed top-level operations when a product facade promises a
  narrower write scope.
- A local draft create has no optimistic target revision, so a restart-safe
  receipt must bind its service-minted draft ID. Updates and deletes instead
  require one exact non-null local revision and must distinguish an absent
  target from a changed target.
- Dependency eligibility and dependency freshness are separate checks. A bad
  Relay recipient at preview is a validation failure; after a signed preview,
  the same Member revision changing must fail as a revision conflict before
  semantic authorization is evaluated. Standalone Relay publication accepts
  only the exact local draft and recipient Member revisions; a Workstream
  expectation is unrelated and must fail closed. Repeat that ordering under the
  workflow lease and during intent recovery.
- Persist immutable publication provenance from the signed authority already in
  hand. For schema-v3 Relays, copy branch, HEAD, dirty flag, and observation time
  into the canonical artifact and publication Activity; preserve it unchanged
  through Take and Close. Never fabricate this context for legacy artifacts.
- A dirty repository observation is intentionally coarse. Revalidation detects
  branch, HEAD, and clean/dirty drift, but cannot prove that dirty tree A has the
  same bytes as dirty tree B. Do not describe it as a source snapshot.
- Canonical handoff identity comparisons use stable Member IDs. Display names,
  Git aliases, and serialized actor objects are snapshots for review, not
  authorization keys.
- An additive Inbox payload must preserve legacy materialization bytes: changing
  old approval serialization can invalidate an already signed preview or its
  interrupted-write recovery. New contribution attribution must also use stable
  object-field order because receipt decoding may reorder JSON keys before
  canonical YAML is rendered.
- Inbox proposals are review artifacts, not a Wiki knowledge category. Apply
  corrections to existing entities and append proposal/evidence sources while
  retaining original producer attribution and grounding baselines. Routine
  non-Spec Wiki/GROW upkeep does not require Inbox.
- A stable Wiki read can represent an already stale index. Target discovery for
  a correction must require fresh status in the same immutable observation as
  the returned text and revisions; a separate earlier status check is not enough.
- An open-to-team Relay audience must remain a rule, not a snapshot of today's
  Members. Check current active identity at Take; preserve omitted audience as
  legacy named intent. A recipient-free local draft must never silently broaden
  named publication. Reactivation restores the same Member ID and revalidates
  alias uniqueness without rewriting prior actors or selecting that Member.
- A CLI shortcut that internally previews and applies still needs exact restart
  authority. Local draft publication and journal intent are separate transactions:
  persist the complete signed preview privately before apply, reuse it for an
  interrupted same-operation retry, and remove only its exact bytes after success.
  Bound pending count and bytes; never replace a conflicting receipt, silently
  evict pending operations, or put draft content into the metadata-only journal.
- Generic file reads and replacements default to exact bytes. Only known
  canonical Team codecs opt into uniform CRLF-to-LF conversion; Wiki files,
  operation ledgers, and local receipts retain exact revisions. Compare tracked
  config with checkout conversion applied only to that comparison, then recheck
  its exact revision. Reading an absent preference must not initialize state.
- Preserve legacy Timeline IDs using logical LF offsets while scanning and
  bounding actual bytes. Otherwise changing the shared reader silently changes
  historical IDs after the first CRLF line.
- The plain-note writer reuses artifact containment and exclusive publication,
  but opts into strict directory flushes through every naming ancestor before
  acknowledging. Never compensate for a post-publication flush failure by
  deleting the record. Expose unsupported platform guarantees in the receipt.
  Exact authored Markdown needs scoped Git attributes as well as an exact-byte
  reader; a frontmatter parser must not bind entity-looking examples in the body.
  Keep the note namespace outside Wiki ownership. See `docs/design/log-notes.md`.
- A bounded legacy tail cannot recover the historical LF offset without the
  omitted prefix's CRLF count. Expose unavailable identity instead of minting a
  replacement. If note filename enumeration exceeds its bound, do not present
  an arbitrary directory prefix as the newest history; direct ID reads stay
  independent of discovery and ordinary reads never clean abandoned staging files.
- Inbox may display escaped carriage returns in a Wiki diff, but must also
  escape literal backslashes so the display is unambiguous. Only the signed
  presentation changes; executable Wiki bytes and revisions stay exact.
- Keep filesystem identity at full width from the first stat through the final
  recheck: converting an already rounded number back to bigint cannot restore
  it. Lock owner JSON can retain decimal strings. Capture the newly opened lock
  identity before writing its owner, and verify the current leaf before cleanup
  even when initialization or the protected operation failed.
- Optional agent logging is advisory and separate from mandatory workflow
  Activity. Read the current policy dynamically instead of rewriting agent
  instructions on every preference change. Retrieve bounded historical notes
  by subject or recorded file, and report incomplete history honestly.
- Capture new Wiki creation provenance from explicit operation authority, while
  retaining supplied attribution. Keep the capture opt-in at ordinary authoring
  boundaries so legacy signed Team/Spec plans and recovery bytes stay stable;
  adopting older prose must not claim its importer wrote it.

## Verify

- [ ] Golden bytes, revisions, preview no-write, stale-plan, and containment tests pass
- [ ] Git reads leave HEAD, index, worktree, and hooks untouched
- [ ] Local-state reads leave database bytes, mtimes, and directory entries untouched
- [ ] Legacy JSONL bytes and mtime remain unchanged
- [ ] Two independent clones merge unique records without same-file conflicts
- [ ] Typecheck, full tests, eval tests, build, package dry-run, declarations, and diff check pass

## Update Scaffold

- [ ] Update `.mex/ROUTER.md` when internal capabilities become working or public
- [ ] Update this pattern when a new persistence/concurrency gotcha is discovered
