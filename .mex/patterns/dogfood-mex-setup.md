---
name: dogfood-mex-setup
description: Safely run the exact checkout's MEX setup against the MEX repository itself.
triggers:
  - "dogfood setup"
  - "self-host setup"
  - "repopulate scaffold"
  - "MEX repository readiness"
edges:
  - target: "context/setup.md"
    condition: "when build prerequisites or command details are needed"
  - target: "context/architecture.md"
    condition: "when distinguishing canonical artifacts from local projections"
  - target: "patterns/release-performance-gate.md"
    condition: "when the change also affects packed-install or release gates"
last_updated: 2026-09-13
mex:
  id: mx_01M1M0CJJD2AQZ6XKHV4VKYTGJ
  type: pattern
  status: promoted
  revision: 5
  title: dogfood-mex-setup
  grounds_to:
    - node: function:9055347f917caf8721a2f6d4e18bcc9a
      fingerprint: mh:64:7b226d696e68617368223a5b373433353431352c36333731363931342c393637323936362c383037373732312c373436383231392c35323636383337392c323731343330352c36363839333332302c38353839303133372c36323236373432352c31323737373330382c32333337373636322c33313639383838352c34303433393538372c32353330363039302c35393637383033382c38393536373434302c37373133363833342c34303634393330352c33313338313832342c34323034333931342c333932393236352c363838333432392c363132313633372c31393935333737302c363633383035342c353332333032342c36313937383432352c32393337313538392c31303332333734382c35353035333536332c31323035343032312c33323835363138372c34343336303338392c343437383236372c34363136313136392c35323933373735322c393837393030332c383338303431362c3737333931352c363938323235302c32383032313438372c36313330303735372c353539313433372c363336393937362c31323734343731382c34323532323839342c31323133303137392c38383539323736322c33363537353930382c393934393334312c33393833373439372c3737353231392c31383234373139322c34393738303838392c37373232313639362c34353431373034352c33363530303737372c3130393933373435312c31353736323435352c383633303934372c32363835383637372c37363837363831382c31363630313236315d2c226e65696768626f7273223a5b2266756e6374696f6e3a3065363661613836306563653765313630376332323061373734613336393266222c2266756e6374696f6e3a3232373935383062353332353839326566363437333335323439353533343039222c2266756e6374696f6e3a3234313134626665616133343736363932383464373565663935366537343064222c2266756e6374696f6e3a3261303231663539646635656131326164646534343930373464386137303836222c2266756e6374696f6e3a3263363164356634343733306538653232623630353039626134323134306162222c2266756e6374696f6e3a3263626162653364613534366331303034393530353432663238626135373532222c2266756e6374696f6e3a3332343030643335356631323139396439623033303130633465313636376130222c2266756e6374696f6e3a3335343131303664616266656134353565626662323862363539626530313838222c2266756e6374696f6e3a3338386531356235643138636539396235346239633031313236343736663738222c2266756e6374696f6e3a3364316466623534363837326430393235376436613831626132633461386666222c2266756e6374696f6e3a3430313862303537306534663736343433303433646231613865623836353963222c2266756e6374696f6e3a3430323630306161376232376539373434316138313735373634656462336638222c2266756e6374696f6e3a3435393135386630643235616330366234663362373833616335373861613963222c2266756e6374696f6e3a3438643164393731323330303334646366666430613561306538633033346630222c2266756e6374696f6e3a3465323165353533613139353834383562643338386461396539313637393131222c2266756e6374696f6e3a3535656533333261353435346563316531633931663537353932306236353633222c2266756e6374696f6e3a3565613933653564313064663461373261366236313635646262643532663932222c2266756e6374696f6e3a3637356564396238643831376235343062353831313363376633633563386538222c2266756e6374696f6e3a3663336162623464363865653865316338643266666130656364666430663465222c2266756e6374696f6e3a3737633138323736303435623333616161646435303761326138363061353361222c2266756e6374696f6e3a3831303464373761373763643163383164626464653137353966326634626363222c2266756e6374696f6e3a3937633437383935643963393032313838616436346330613635383539303337222c2266756e6374696f6e3a6131616331333362646336623463353038336338666138633430343766393039222c2266756e6374696f6e3a6261656136323530336134633937633163383266323937646633353333343766222c2266756e6374696f6e3a6335356339303838393736396661663237643331623039366132613963373937222c2266756e6374696f6e3a6362656138363463303637616436393666656464643465356565303739663362222c2266756e6374696f6e3a6434623732613439383136386134623936663937316137653032326565316533222c2266756e6374696f6e3a6532646366376231653935303363363862356430343333663437393632323439222c2266756e6374696f6e3a6538626639616637376437393064636461343138343331363937653930653237222c2266756e6374696f6e3a6634336364313038306361616230616335356538653430353438306231653938222c2266756e6374696f6e3a6635363930366262343639643432636432353233376266653363623361613938222c2266756e6374696f6e3a6636623331653634396138376239643161623137346461333032623438353537222c2266756e6374696f6e3a6637366164343962353837646164373730313666366362666430303837366334222c2266756e6374696f6e3a6664353936383837333564353063633431633935373137376265633865313266225d2c22746f6b656e436f756e74223a3235387d
      bodyHash: 4646617b30fd31fdb1d747526454009818560a24f7f821e8540edf87e9a55c23
  relations:
    - type: related_to
      target: mx_01M1M0CJGBPPFPWHY980PMTS2T
      note: when build prerequisites or command details are needed
    - type: related_to
      target: mx_01M1M0CJ5C5XQV0HM5VM787WQS
      note: when distinguishing canonical artifacts from local projections
    - type: related_to
      target: mx_01M1M0CJNG4SW0WCJF3NB547HE
      note: when the change also affects packed-install or release gates
---

# Dogfood MEX Setup

## Context

The MEX repository uses the same ordinary setup path as a consumer repository.
There is no special `--self` mode. Build first and invoke the checkout's
`dist/cli.js` so unbuilt source changes are not confused with an installed
global `mex`.

## Steps

1. Inspect `git status` and preserve all unrelated authored scaffold content.
2. Confirm Node.js is at least 22.5, then run `npm run build:node`.
3. Review `node dist/cli.js setup --dry-run` from the repository root.
4. Run [`runSetup()`](mex://function:9055347f917caf8721a2f6d4e18bcc9a)
   through `node dist/cli.js setup --cli`. If no supported agent CLI is available,
   use the emitted prompt to fill only incomplete slots and rerun setup.
5. Preserve substantive context and patterns. Repair stale claims and broken
   `.mex/`-root-relative edges; create a pattern only for a genuine coverage gap.
6. Rerun setup after population so grounding baselines, Wiki migration/indexing,
   and validation complete through the supported maintenance path.
7. Verify `capabilities`, Graph status, Wiki validation, `check`, skills sync,
   and `git status` with the same checkout CLI.
8. Treat Team initialization or local-schema migration as a separate explicit
   workflow; setup must not invent a Member or mutate canonical Team records.

## Gotchas

- From 0.8.2, unflagged `setup` opens the browser. Terminal drivers and scripts
  must pass `--cli`; `--dry-run` remains a read-only terminal preview.
- Test completion without a real global installation or contact submission.
  Isolate `MEX_HOME` in disposable fixtures and inject the npm/form transport.
  Successful contact delivery stores only a submitted marker; skipping stores
  only a skipped marker. Neither contains contact data or analytics identifiers.
- Build before browser testing, and do not rebuild a running Hub's asset tree.
  `test/cli.test.ts` also builds production assets in its setup hook; run the
  packaged browser scenarios after that suite so manifests cannot outlive files.

- A global CLI can report the same version while containing different bytes;
  use the built checkout when validating uncommitted setup changes.
- Setup copies missing scaffold files but does not overwrite substantive files.
  Population prompts must merge at section granularity and preserve managed blocks.
- A non-interactive run without Claude Code or Codex may pause after printing the
  population prompt. That is a resumable checkpoint, not a failed setup.
- Drift staleness uses committed Git history. Correct uncommitted content can
  remain stale until the canonical scaffold is committed.
- A Graph with partial parses can support scoped evidence while exact reads
  abstain. Do not weaken freshness or provenance checks to force an answer.
- MEX does not stage, commit, pull, or push repository changes.

## Verify

- [ ] `node dist/cli.js setup --dry-run` accepts this repository
- [ ] A real setup run preserves existing patterns and managed instruction blocks
- [ ] Graph uses the current schema and reports zero source changes
- [ ] Wiki migration/index/validation complete without corrupting canonical files
- [ ] `node dist/cli.js skills sync --dry-run --json` reports no changes
- [ ] Generated databases and `.mex/local/` remain ignored
- [ ] `git diff --check` and the setup regression tests pass

## Update Scaffold

- [ ] Update `.mex/context/setup.md` when the self-dogfood command sequence changes
- [ ] Update `.mex/ROUTER.md` when setup readiness or a known blocker changes
- [ ] Update this pattern when a new resumability or self-hosting failure mode is found
