---
name: durable-change-signal
description: Keep the value that answers "has this changed?" in Git, not in a disposable index, and make every reader consult the same key path.
triggers:
  - "drift baseline"
  - "body hash"
  - "grounding change signal"
  - "disposable index"
  - "grounds_to key path"
edges:
  - target: "context/architecture.md"
    condition: "when changing what a drift check compares against"
  - target: "patterns/safe-graph-snapshot-evolution.md"
    condition: "when the value also lives in the graph database"
  - target: "context/conventions.md"
    condition: "when verifying the change"
last_updated: 2026-10-02
mex:
  id: mx_01M1M0CJK5ZTSHCDDWB3NTSEBF
  type: pattern
  status: promoted
  revision: 5
  title: durable-change-signal
  grounds_to:
    - node: function:fa9a6935ad14990f545c7802e4ecbc0a
      fingerprint: mh:64:7b226d696e68617368223a5b373433353431352c36383630383839382c3130303034393039332c33353634353436352c38353733343030372c3130343838333336322c323731343330352c35363734313536392c343834343834302c31353931323235392c3139393034373236372c34383730353332392c34303334303630342c34323033363635302c32353330363039302c35393637383033382c32303135383230302c33313537383431312c37333230333534312c3130393536393239342c37323034363430312c32363737353237332c363838333432392c363132313633372c32393838353035362c32363630383036312c33373336303731332c323335353239332c34373630313239322c35323135393631352c31313636313734322c35303830363936322c31373536313039372c34343336303338392c34313937383934302c35353934333039352c33313335333138302c32373735333637302c33303436323736322c34343137383331332c3130353335393233302c35313437353533322c32373334323233302c32313037393237362c31343137383630322c34373337313639322c31383833373332382c343837343537302c3130343335383337302c38373130373836352c393934393334312c33393833373439372c33333333333239362c31383234373139322c34393738303838392c343739383336372c35323732302c33363530303737372c363030333533302c343136313837362c3134313635333739322c31343337333431382c33383337343331332c38393633303336345d2c226e65696768626f7273223a5b2266756e6374696f6e3a3032353836376531323163373930333264336334613230613366336632643437222c2266756e6374696f6e3a3332343030643335356631323139396439623033303130633465313636376130222c2266756e6374696f6e3a3631393766666236343561636136373530366363663665653063393235333430222c2266756e6374696f6e3a3636633339636235353263353362363964666534323537643230646564353962222c2266756e6374696f6e3a3637313535613337346534303530363966323732613138313862313539633339222c2266756e6374696f6e3a3738633063396139366234626437343831383462666364663663656263633037222c2266756e6374696f6e3a6337326339343336666364623436643035353538373861303433343234626461225d2c22746f6b656e436f756e74223a3132307d
      bodyHash: de4ddb2b25733abebb6a658fb71865f429d7ee4de8807fbccd8904515086fb79
    - node: function:a6ed814a0212f935ce0952cbcd236dc7
      fingerprint: mh:64:7b226d696e68617368223a5b373433353431352c32353335363935372c3234323032373033382c36343836393831322c3132393739363239302c3138383338323731312c39373433323431372c32313232313836342c3132373036373338362c313234363339382c39313837343736372c32363531333233312c36373436383937392c32373736373235362c32353330363039302c3230313734343237332c3130323331333231362c32353233373034342c313431333938382c37383439303834322c3233333336303733382c36363837363735362c31333237323838382c32393135353834362c31393935333737302c32363630383036312c3134353430343730322c32363636393933392c32383632353434302c35323135393631352c36313739393332392c3139373336323032302c31373536313039372c363938343133322c363137333734322c34323031343837372c3138393139363837352c38373437363636392c34353438363335322c3233353432333939382c3233383736373434372c31353539383738382c383636373430332c32313037393237362c3130303837313332392c36393336313532312c31303034373330372c3132353633333335352c3137303736373433362c393533353239372c393934393334312c31353536303238312c373837343237372c31383234373139322c37363836323732342c39393439383531392c34353431373034352c31323139363435312c31363331343230332c3134373730393733382c34373130313735312c3130363631393135382c39313836303539302c38393633303336345d2c226e65696768626f7273223a5b2266756e6374696f6e3a3065343535663466383436636666646366363764373861343136356336626361222c2266756e6374696f6e3a3065643665653134343431643863336563303662363561366464653334373738222c2266756e6374696f6e3a3132343436306439313266376333656230633135653537363539313063306165222c2266756e6374696f6e3a3134303635383965386464666534333362356666386138366532656632353034222c2266756e6374696f6e3a3166656362633235633562643538643432366135393461386231313236666363222c2266756e6374696f6e3a3364636637633864333763393739353130326437656234643138323233646365222c2266756e6374696f6e3a3435656663613364653230326331306465616262373830666539663063363234222c2266756e6374696f6e3a3437356338323239663937313337383532646366376134313261336233343963222c2266756e6374696f6e3a3631386531376632383639633536383636663163393936323165626137616363222c2266756e6374696f6e3a3636633339636235353263353362363964666534323537643230646564353962222c2266756e6374696f6e3a3662333438386536383465396536616434646334643035303763343036663662222c2266756e6374696f6e3a3733313836323066373434626465393466386562363536393334316334353139222c2266756e6374696f6e3a3736383738373362333937663666663739323239656136663630363534396462222c2266756e6374696f6e3a3738633063396139366234626437343831383462666364663663656263633037222c2266756e6374696f6e3a3863646639656564323435396333333464383833353063336664626165666237222c2266756e6374696f6e3a3962343362363331623937613938383634663766386531323232653261313234222c2266756e6374696f6e3a3962346634623061626333343837643664643962616535353531393732376232222c2266756e6374696f6e3a6162623262623035363032643735633432393363366636386434386361663465222c2266756e6374696f6e3a6266343862646232343666626263323538326633323937663163633631383039222c2266756e6374696f6e3a6330373535363635663764646365326338643934306131646439653031653966222c2266756e6374696f6e3a6465356233383837373832323836383665363163373534636531643537636536222c2266756e6374696f6e3a6465663739643835666438346465613163623834323865303066306466363263225d2c22746f6b656e436f756e74223a37347d
      bodyHash: e7c9b24a33953c06531634a6b1a23408bf3f5a141817bf7b50dc749d12e2fba8
  relations:
    - type: related_to
      target: mx_01M1M0CJ5C5XQV0HM5VM787WQS
      note: when changing what a drift check compares against
    - type: related_to
      target: mx_01M1M0CJP81C590FCKTSN5HA3Q
      note: when the value also lives in the graph database
    - type: related_to
      target: mx_01M1M0CJ9460AT00V8TH0QCKAC
      note: when verifying the change
---

# Durable Change Signal

## Context

`.mex/graph.db` and `.mex/wiki.db` are derived, gitignored, and disposable by
invariant: `mex graph rebuild` is offered in the Hub as a routine repair, and a
teammate who clones never receives either file. Anything held only there is gone
the moment a user takes the repair the product recommends.

That is correct for an index and wrong for a baseline. A drift check answers
"has this code changed since we wrote this down?", and the value it compares
against is a claim made at a point in time. Re-derive it during a rebuild and
you compare current against current: the drift silently disappears, nothing
warns, and the scaffold keeps reporting clean.

Two distinct kinds of value, and the difference decides where each one lives:

- **Identity** — the fingerprint. Answers "where did this symbol go?" It is
  deliberately insensitive to an edited constant or a renamed local. Never use
  it to answer "did this change?"
- **Change** — the body hash. Answers "is this still the code we described?"
  Canonical because it is committed in Markdown and reviewable in a pull
  request.

## Steps

1. Decide which kind of value you are adding. If it is a claim about a moment
   in time, it belongs in Markdown. If it is a re-derivable lookup, the index is
   the right home.
2. Add the field to the shared type in `src/types.ts` as **optional**. Every
   scaffold in the world lacks it, and a required field turns each of them into
   a parse error. Mirror the wiki lane's key name and placement so both writers
   produce one shape rather than two conventions.
3. Populate it during initial capture or explicitly accepted renewal, from a
   value the graph produced. The setup and sync path converges through
   [`captureGroundingBaselines()`](mex://function:fa9a6935ad14990f545c7802e4ecbc0a).
   A reviewed replacement must match the exact current graph fingerprint/body
   hash and the reviewed document bytes. A hash an agent can invent is not
   evidence, and a successful agent exit is not acceptance.
4. **Change the readers in the same commit.** A field nothing reads is inert,
   and a fix that ships only the write half looks complete and does nothing.
   Grep for every consumer of the old source of truth before you start.
5. Read the key through
   [`extractGroundings()`](mex://function:a6ed814a0212f935ce0952cbcd236dc7),
   never `frontmatter.grounds_to` directly. A pre-wiki scaffold keeps the key at the root; once `wiki migrate`
   adopts the file as an entity, section 13.4 moves it under the `mex` map.
   Reading the root key directly finds nothing on a migrated scaffold, the loop
   runs zero times, and the check reports clean. Writer and reader must resolve
   the path the same way or they will disagree silently.
6. Keep the index copy and say in a comment that it is now a **cache of a
   canonical value**, not a second store of a fact. Otherwise the next reader
   deletes it as a duplicate — and it often carries something Markdown has no
   business holding, such as the body text a drift review needs for a diff.
7. Initial capture may establish a missing baseline. Legacy backfill must use
   the prior cached baseline when one exists, preserving the old body as well
   as its hash. Renew only the specific entries accepted after a concrete
   review; unrelated groundings must remain untouched. A value that merely
   **differs** is the finding, not permission to replace it.
8. Keep pointer repair separate from accepting behavior. MOVED repairs carry
   forward earlier change evidence, and the reader compares that evidence to
   the resolved node. A rename may therefore still need review. Do not erase
   that review signal merely because identity reconciliation succeeded.

## Verify

- Delete the index, rebuild it, then edit the grounded code. The check must
  still fire. This is the whole point, and it is the only test that proves it.
- A record written before the field existed must still parse, still validate,
  still warn, and still behave exactly as it did against a live index.
- A no-op agent that exits successfully must preserve existing hashes,
  fingerprints, cached old code, and drift. Include literal-only code changes,
  which can leave fingerprints identical.
- A declined or stale review must preserve the baseline. An accepted review
  must affect only its selected grounding, with document and source facts
  revalidated before publication.
- Confirm the new tests actually fail on the pre-fix tree. Restore the source
  files from the base commit and re-run; a test that passes both ways is a
  backward-compatibility pin, not a proof of the fix, and should be labelled as
  one.
- Run the check against a real migrated scaffold, not only a synthetic fixture.
  Both key paths and both populations only appear there.

## Gotchas

- A command that reports a captured count is not evidence it wrote a durable
  baseline. Verify that the matching Markdown `bodyHash` changed as intended.
- `serviceOptions` in the wiki CLI carries no code graph, so `wiki validate` and
  `wiki migrate` degrade silently rather than failing. Check what a command
  actually receives before believing a message about what it found.
- A diagnostic that names a cause nobody checked costs more than no diagnostic.
  If a flag has two causes, carry the discriminator rather than asserting one.
- A committed value can have more than one spelling. Fingerprints are written
  as `mh2:` but scaffolds still hold `mh:` (#233), so compare them with
  `sameFingerprint()` or `canonicalFingerprint()`, never `===`. A string
  comparison makes every older grounding read as changed: capture preserves
  it, sync asks for a review, and the Wiki reports it stale. Re-encode an old
  value only when its file's groundings are being rewritten anyway.
- A second committed hash must describe the same moment as the first.
  `codeHash` (#236) is written only while `bodyHash` equals the current
  code's, and renewed only with it. Otherwise "the code is unchanged" would
  compare against a different baseline from "the body changed". Writing them
  together is not enough, because an older version or a hand edit can renew
  one and not the other. So the value carries a prefix of the `bodyHash` it
  was captured with, and a mismatched pair is read as absent. When the
  baseline's comment-free hash is unknown, the answer is the warning, not a
  guess. Classify comments with the file's own grammar: a regex that misreads
  code as a comment downgrades a real change.
