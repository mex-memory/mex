# State diagrams: local implementation and qualification

Initial qualification: 26 October 2026. Updated 29 October 2026.
Implementation of `state-diagrams-spec.md`, initially prepared
locally. The user subsequently authorized a feature branch, push and PR; no
release, issue or triage label is part of this work. The supplied spec and
research were read in this checkout before implementation and remain unchanged.
The separate uncommitted marketing research was left untouched.

## Current qualification: 29 October 2026

The viewer update in `cbda1b74e26f833f65cd144ef7825836aa73034d`
replaces Hub's Mermaid browser renderer with a native React/SVG state graph.
It follows the Context graph's visual language, retains state/transition
identities, nested states and independent regions, and supports selection,
ordered trace overlays, pan/zoom/fit and accessible behavior lists. Dense charts
show events on selection with an all-events toggle. Diagrams has a distinct
workflow sidebar icon. Mermaid remains the normalized export/client-delivery
format; the Hub does not execute its embedded styles. The managed skill also
offers to start Hub and open the specific registered preview after the user
accepts, preserving normal authentication and separate Save review.

Verified evidence for that commit:

- [Main CI run 40740210076](https://github.com/mex-memory/mex/actions/runs/40740210076)
  passed Node 22.22.0 and Node 24 checks, Windows/macOS storage portability and
  the Hub browser job. The separate
  [statechart checker qualification run 40740210028](https://github.com/mex-memory/mex/actions/runs/40740210028)
  passed.
- Local viewer verification passed 78 focused Hub tests, six browser cases
  (including the built viewer under real Hub CSP), workspace typechecks and a
  production build. Deterministic asset checks passed with every budget
  unchanged: diagram detail loaded 136,826 JavaScript bytes and 4,134 CSS bytes.
- The user's actual checkout-local setup/recovery preview was opened after a
  rebuild/restart. It displayed nine states and eighteen transitions, the
  retained passed check, partial reproduction, source mapping and unchanged
  evidence. This verifies display of the recorded result; it does not re-run or
  renew the model check, implementation reproduction or dependency baselines.

The release-performance job in the main run failed operationally before
producing a measurement report. Its generic SVG readiness locator matched the
chart and three toolbar icons. This follow-up targets the named
`States and transitions` group and exercises the actual benchmark readiness
helper against the built production viewer for both the recovery graph and
nested/parallel regions. The browser regression reproduces the four-SVG failure
before the fix. A successful pinned CI measurement/enforcement run on the
follow-up commit remains required; this operational failure supplies no
performance calibration evidence. No budget, timeout, fixture, or confirmation
policy is relaxed by the fix.

Follow-up local verification passes all six diagram browser cases and workspace
typechecks. The release-benchmark Vitest file passes 49 cases and fails the
unmodified one-second child-shutdown marker assertion when run as a whole on
this Mac. That probe passes in isolation, and a direct call to the unmodified
startup helper also records termination. It exercises `startHub()` rather than
the changed graph readiness selector. No probe timeout or shutdown code was
changed; the full pinned CI run remains required.

The user reported that the Claude app worked and that terminal Mermaid was
unreadable. Current Claude delivery uses the text projection and PNG/file-reader
or system-viewer fallback, with an optional direct Hub-opening offer. The user's
hands-on testing of Codex terminal, app and Hub remains in progress; these notes
do not certify post-fix acceptance across all clients.

## Implemented behavior

1. The private v1 artifact in `packages/hub-contracts/src/statechart.ts` connects
   explicit generation, checking, deterministic Mermaid/text projection,
   temporary registration, exact Save review and reopening. It retains model
   inputs, rules and provenance, stable identities, evidence hashes, finite and
   temporal traces, omissions, reproduction and toolchain information.
2. `mex-statechart` ships through the existing Claude/Codex managed installer.
   The attributed, MIT-licensed pstack baseline is pinned to
   `fad8d01588a1b1ae803f87c8a1e0de79e28cffec`; original files have a SHA-256
   inventory. The bounded wrapper retains from-spec/from-chart, reference/fixed
   comparisons, settled/observation rules, goals, cover views and region support.
   Derived per-rule configurations preserve exact quoted constants and comments;
   the authored model/configuration remains unchanged.
3. Generation stays in scratch space. Explicit checking verifies the TLC 1.7.4
   jar checksum. Existing Java can be supplied or found on PATH. An explicit
   setup helper can download only the pinned, verified jar into a chosen cache;
   ordinary installation and Hub viewing install neither Java nor TLC. Rendering
   a fallback image does not require Java/TLC.
4. Registration copies a validated artifact to ignored `.mex/local/diagrams`.
   Reads do not initialize or clean storage. Opaque IDs are checkout-bound by the
   repository service. Expiry/eviction happens only on registration.
5. The lazy Hub collection separates previews from saved snapshots. Detail has
   a native React/SVG state graph, pan/zoom/fit, state and event selection,
   numbered recorded paths, conditions/rules/evidence inspection, keyboard
   controls and accessible lists. Nested states and independent regions retain
   their containers. All imported content remains data; models, mappings and
   regeneration instructions never execute on a Hub read.
6. Authenticated, exact-Origin/CSRF Save first returns the exact retained writes.
   Applying its process-local, revision-bound review creates a new immutable
   `.mex/diagrams/<id>` bundle. `record.md` contains readable verification,
   rules, evidence and limitations plus the canonical fenced data. Companion
   files retain model inputs. Reads tolerate Git-style CRLF conversion. Wiki
   discovery and writes exclude feature-owned bundles independently of config.
7. Recorded dependency bytes are compared separately from the original check.
   Changed, missing and unverified evidence never renews a baseline. Model check,
   graph projection/diagram validity, source mapping and implementation
   reproduction remain separate observations. Saving an incomplete result is
   supported; staging and Git publication are never part of diagram Save.

The public package-root exports and existing Graph/Wiki/Team response protocols
were preserved. Setup review now derives selected skill roots from the shared
registry; the bundled helper is minified to fit existing setup diff limits.

## Frozen bounds

The contract caps an artifact at 512 KiB, each companion at 128 KiB, 80 states,
200 transitions, 32 rules, 16 traces with 256 steps each, and 64 evidence records.
Save reviews are additionally bounded below the existing 1 MiB Hub response
limit. There are at most 20 temporary previews (24-hour TTL), 100 saved snapshots,
and 20 pending five-minute Save reviews per service.

Explicit checking has one checker per helper, a 60-second total deadline,
512 MiB Java heap, one TLC worker, bounded logs/DOT, and a 100,000 accepted-state
limit. The baseline Node child has a 256 MiB heap and export images cap at
16 million pixels. Cancellation kills/settles the owned process group and never
produces a passed check from partial output. Windows uses its process-tree kill
mechanism; Windows execution of real TLC and the packed helper passed in GitHub CI run
40311997052, alongside Linux and macOS.

## Initial implementation verification

The following counts and run references record the initial implementation.
Current viewer and follow-up CI evidence are reported above.

- The real pinned TLC suite passes nine cases: required tooling, a passing
  invariant, ordered broken-invariant trace, expected goal witness, temporal
  failure, cancellation/resource limits, checked-artifact Save/restart, independent
  temporal-property attribution, and preservation of exact quoted constants.
  Missing/wrong tooling is separately tested as unavailable, never skipped or
  treated as success. A required real-checker and packed-helper matrix covers Linux, macOS and
  Windows; the existing portability job also runs the diagram contract, storage
  and authenticated Hub integration tests.
- Contract/storage/API/installer/ownership/performance tests pass. They cover
  malformed/oversize inputs including UTF-8 bytes, hierarchy/reference bounds,
  injected markup and owner markers, opaque IDs, Origin/CSRF, stale/expired
  reviews, retention, symlink escape, occupied publication targets, exact writes,
  dependency changes, unavailable indexes, conflicting historical evidence,
  immutable rules/baselines, CRLF reads and noninitializing ordinary reads.
- All 557 Hub web unit tests pass with two workers. Four Playwright/Axe cases
  pass at 1024/1440 pixels, including nested/parallel state rendering, long
  labels, SVG selection, matching numbered paths, keyboard controls and Save
  review. PNG exports were visually inspected.
- Production builds and workspace typechecks pass. The packed helper runs with
  real TLC from a clean consumer skill tree, produces readable terminal output
  and registers a private preview without a Hub or canonical save. Packed Hub
  smoke verifies actual managed installation/idempotence, authenticated preview
  and exact Save, then unchanged reopening after real Graph/Wiki rebuilds.
- The full root run completed with 4,851 passes, 39 failures and two existing
  skips. Five failures identified template/default/inventory expectations that
  were fixed. The other 34 were 32 default hang-guard timeouts and two process
  timing failures. All six affected Git/process integration files subsequently
  pass: 242 tests with one worker and a 60-second local test hang guard. Product
  operation deadlines and committed performance limits were not relaxed. The
  affected source-expectation files also pass. The monolithic default command
  was not rerun after those corrections; this is not a claim of a clean default
  full-suite run.
- Release asset measurements pass with existing shell/Home/shared budgets
  unchanged. The renderer and statechart schemas remain outside their static
  closures. Both owned Diagrams routes are measured by the existing harness.
  Local small/medium/large runtime characterization completed and audited ordinary
  reads/outbound requests; it remains diagnostic. Pinned Linux CI run 40311997168
  supplied five heap samples per owned route/profile and deterministic assets.
  The two asset leaves and six heap leaves now use those recorded measurements
  and the existing 1.05/1.15 formulas. No unrelated budget was changed.

Ignored local artifacts include `test-results/statechart/local-characterization.json`
and the viewer QA PNG. Detailed command logs are retained under
`/private/tmp/mex-statechart-*.log`; acceptance models, diagrams and the artifact
are under `/private/tmp/mex-statechart-acceptance`.

## Initial repository verification checklist

1. **Public API — pass.** `src/index.ts` is unchanged and packed declaration
   checks reject private diagram/Hub exports.
2. **Read and write authority — pass.** Ordinary reads remain noninitializing;
   explicit registration and exact reviewed Save use contained, revision-bound
   publication. Occupied targets and symlink escapes refuse safely.
3. **Deterministic bounds — pass locally.** Artifact, file/UTF-8, trace, graph,
   subprocess, retention, collection and response bounds are checked. Pinned
   exact-head runtime acceptance remains pending as described below.
4. **Focused tests and typecheck — pass.** The final focused boundary run passes
   106 tests before integration; the current-main follow-up passes 70 focused
   tests and workspace typechecks. The full-root attempt and isolated
   reruns are reported separately above, without calling the first run clean.
5. **Build and packaging — pass.** Production build, real packed helper and
   packed Hub lifecycles pass. Both model directions and reference/fixed
   comparison paths execute from the packed helper without changing the
   reference inputs. Graph evaluator/protocol code was not changed.
6. **Diff and local scope — pass.** `git diff --check` is clean, staging is
   unchanged, generated runtime/build/measurement outputs stay ignored, and
   unrelated uncommitted work is retained. The initial qualification was local; the user subsequently authorized PR #317.
7. **Existing protocol ownership — pass.** Existing Graph/Wiki/Team shapes,
   defaults, errors and read boundaries remain covered; the new private leaf
   and feature-owned snapshot namespace do not become Wiki/Team entities.

## Human evaluation: setup, interruption and recovery

The original bounded setup model was re-executed through the packaged workflow:
18 model states project to 12 chart states and 20 chart transitions. Its
configured checks pass. The recovery model passes four invariants: eight model
states project to six diagram states and seven transitions. The new artifact
helper independently reports eight explored model states/eight model transitions
for that recovery model; these are runtime observations, not drawing counts.

The source-only explanation already covers retained files on pause, successful
agent exit being insufficient while placeholders remain, and finalization being
separate from the reviewed commit. The initial evaluation used the pre-rebase setup implementation. After integrating
main `340f3e8`, source inspection reconfirmed placeholder refusal in
`src/setup/headless.ts:582`, late Hub import in `src/setup/terminal.ts:269` and
the retry loop at line 296. The integration added one-paste/subsystem setup
behavior; the earlier model is not an exhaustive model of those additions. Its
recorded inputs were not silently rebaselined.

Useful MEX context is the specific clean-rebuild recovery in
`.mex/patterns/dogfood-mex-setup.md:135`: an old process can retain references to
removed lazy chunks, Retry does not replace it, and a compatible current CLI can
reopen the finishing page using prepared files. The acceptance artifact ties this
context to the old-process/retry states, recovery condition and rule; it does not
add unrelated context. Wiki retrieval found no matching lead for the initial
query, Graph reported stale branch evidence, and bounded Timeline retrieval
added no fact. No development index was rebuilt or refreshed.

`node scripts/statechart-recovery-repro.mjs` freshly reproduced the Node module
replacement mechanism: both old-process attempts return `ERR_MODULE_NOT_FOUND`,
while a fresh process loads the replacement. This is **partial mechanism
reproduction**, not a full live MEX setup/rebuild reproduction. The artifact
retains that distinction and leaves the incompletely code-mapped recovery
alignment unverified. Its normalized Mermaid was exported and visually inspected
with Java deliberately unavailable. An agreed chart was also turned into a
checked TLA+ skeleton and drawn back unchanged.

Historical/conflicting evidence round-trips without replacing an agreed rule;
no-context and missing-mapping cases remain valid artifacts. Those deterministic
checks establish preservation, not that an agent always interprets context
correctly. This is one retained human evaluation, not a controlled demonstration
that MEX uniquely discovers the recovery or improves every diagram.

## Remaining qualification and capability limits

- Codex CLI 0.160.1 presentation is qualified for the cases in
  `state-diagrams-codex-rendering.md`: native simple statecharts, ordered finite
  trace text and full raw temporal text. Nested/parallel syntax is unsupported by
  its native renderer and uses MEX text. `state-diagrams-client-handoff.md`
  records the original Claude test handoff. User-reported Claude app/terminal
  behavior and ongoing post-fix acceptance are distinguished above; no complete
  client certification is inferred from Hub tests or code inspection.
- The enforcing performance invocation refused this host: macOS arm64 /
  Node 22.17.1 is not Ubuntu 24.04 x64 / Node 22.22.0. Pinned CI subsequently
  supplied calibration recorded in `state-diagrams-calibration.json`; the six new
  heap limits are finite. Exact-head enforcing CI is rerun after that calibration.
  Initial raw Home/other-route heap crossings were also present in exact-base
  run 40303551675 and assessed as advisory by the unchanged existing policy; no
  frozen Home/shared budget or confirmation policy was relaxed.
- The real-checker/packed-helper matrix passed on Linux, macOS and Windows in
  run 40311997052. Subsequent checker qualification and the Node 22/24,
  Windows/macOS portability and Hub browser jobs passed for `cbda1b7`, as linked
  above. Earlier initial-CI sidebar and setup-subsystem expectation failures
  were corrected; the setup planner excludes installed official skill roots
  from coverage ranking and size targets. The current follow-up still requires
  its own CI, including a completed pinned release-performance report.
- The pure-data projection helper verifies finite scalar valuations and mapped
  actions. Complex concurrent/compound projections may remain unverified and
  require the retained baseline workflow/proof plus human review. Raw temporal
  traces remain available when they cannot form a finite chart path.
- A passing model is not implementation conformance, exhaustive coverage, an
  implementation reproduction, or a statement that recorded dependencies remain
  semantically current. Regeneration always creates a new preview.

MEX Router, architecture, Hub guidance and managed instruction copies were
updated in the working tree. Existing grounding baselines were not renewed.
These canonical documentation changes are included in the feature PR. The
separate MEX Relay draft remains checkout-local until reviewed publication. No generated diagram was
saved into this checkout's canonical collection.
