# Context-aware state diagrams for MEX

Status: proposed implementation spec. Test approach confirmed by the user on 26 October 2026. This document describes proposed behavior; it does not claim the feature exists or promote its models into accepted project knowledge.

Delivery: keep this spec and its planning artifacts local, as explicitly requested by the user. Do not create a GitHub issue, label, or other external publication for this work.

## Problem Statement

Coding agents explain complicated behavior through long responses. Developers struggle to see the states a system can occupy, what changes them, which conditions matter, and what happens after interruption or failure. Asking for another explanation can produce more text without making the behavior easier to understand.

A state diagram can make that behavior understandable at a glance. However, a plausible diagram can omit an important condition, confuse implemented behavior with intended behavior, or imply that a successful model check proves the real implementation correct. A generic diagram skill also does not deliberately retrieve the repository's relevant decisions, operating patterns, or remembered failure modes.

MEX should help an agent produce a clearer, better-supported explanation for a human. Relevant project context should improve the actual states, transitions, rules, or recovery guidance. Adding context merely to show that MEX was consulted provides no user benefit.

## Solution

Ship a managed `mex-statechart` skill and a Diagrams viewer in the Project Hub. A user can invoke the skill directly or ask naturally, including “explain what you just said using a state diagram.” The agent uses that request to identify a bounded subject, reads the relevant implementation, selectively retrieves useful MEX context, models the behavior in TLA+, and runs TLC model checking using the supplied statechart workflow as its baseline.

The default result is a small, readable Mermaid diagram rendered directly in a supporting chat client, accompanied by a short explanation of the checked rules, material limitations, and any important contextual addition. A terminal client receives supported native rendering or a readable text diagram of the same model. Images are export and compatibility fallbacks. The agent remains free to choose a more suitable explanation when a state diagram would not help.

Generation stays with the invoking coding agent. The Hub displays and explores the result: pan and zoom, select a numbered counterexample path, and inspect conditions, rules, and supporting evidence when needed. Producing a diagram does not automatically start or open Hub. Results are temporary by default. An explicit Save in Hub action reviews and writes a portable, Git-trackable snapshot; sharing remains a separate Git action.

The first release prioritizes explaining existing behavior. It retains the original skill's existing-spec, agreed-chart, counterexample, and proposed-fix capabilities without adding a visual modeling editor or a new agent execution system.

## User Stories

1. As a developer, I want to ask an agent to explain a complicated flow using a state diagram, so that I can understand it without reading another long response.
2. As a developer, I want to request a diagram of the agent's previous explanation, so that I can clarify the discussion without restating the subject.
3. As a developer, I want that previous explanation treated as a subject cue and checked against evidence, so that the agent does not turn its own mistake into an authoritative diagram.
4. As a reader, I want states and transitions labeled in familiar product or system language, so that I can follow the behavior without decoding implementation names.
5. As a reader, I want a focused overview with detail available separately, so that the diagram remains easier to understand than the text it replaces.
6. As a reader, I want important differences between superficially similar states preserved, so that simplification does not hide an error or recovery condition.
7. As an engineer, I want independently changing parts represented clearly when necessary, so that concurrency is not presented as one misleading sequential lifecycle.
8. As a developer, I want interruption, cancellation, retry, pause, and recovery included when relevant, so that I know what to do beyond the happy path.
9. As a developer, I want the diagram grounded in current code and meaningful tests, so that it explains what the implementation actually does.
10. As a developer, I want relevant MEX decisions and patterns considered, so that the diagram includes important constraints or failure modes that a bounded code inspection could miss.
11. As a developer, I want historical Timeline notes checked before reuse, so that an old observation is not silently presented as current policy.
12. As a developer, I want the Code Graph used to find implementation evidence when useful, so that discovery is faster without treating call edges as state transitions.
13. As a developer, I want stale or missing indexes handled honestly, so that the agent can fall back to source and tracked Markdown without silently repairing my checkout.
14. As a reader, I want to see a concrete contextual addition when one matters, so that I understand what MEX contributed.
15. As a reader, I want irrelevant project context omitted, so that the explanation stays focused.
16. As a reviewer, I want implemented behavior distinguished from an agreed requirement or historical note, so that conflicts remain visible.
17. As a developer, I want already agreed rules reused with their provenance, so that I do not have to approve the same requirement repeatedly.
18. As a developer, I want genuinely inferred or conflicting rules brought to me for agreement, so that the agent does not invent requirements and call the implementation broken.
19. As a reviewer, I want the human-readable rules visible alongside the diagram, so that I know what was checked.
20. As an engineer, I want TLA+ modeling and TLC checking retained, so that the feature includes the original workflow's behavioral reasoning rather than only a drawing.
21. As a reviewer, I want a successful check scoped to the model and its bounds, so that I do not mistake it for proof of the entire implementation.
22. As a developer, I want a broken rule shown as a numbered path when the checker provides one, so that I can understand the sequence leading to the failure.
23. As a developer, I want temporal-property counterexamples available even when they cannot be drawn as an ordinary chart path, so that important failures are not lost.
24. As a developer, I want a deliberate reachability witness identified as a goal example, so that an expected broken rule is not misreported as a product bug.
25. As a developer, I want modeled bugs replayed through real observable entry points where possible, so that I can distinguish a model counterexample from a reproduced implementation bug.
26. As a reviewer, I want a proposed fix compared when provided, so that I can see whether it addresses the same rule and failure path.
27. As an engineer, I want an existing TLA+ specification preserved as the comparison reference, so that the agent does not weaken the agreed specification to fit the code.
28. As a designer, I want the baseline workflow for an agreed chart to remain available, so that agreement about behavior can precede a more detailed implementation model.
29. As a developer, I want a useful diagram with an explicit incomplete-check status when checking cannot finish, so that a missing runtime or resource limit does not become a false success.
30. As a developer, I want to cancel generation cleanly, so that a diagram request does not leave uncontrolled checker processes running.
31. As a chat user, I want a diagram rendered natively where supported, so that I can read it directly in the conversation.
32. As a terminal user, I want a readable diagram in my current client, so that I do not have to open a browser just to understand a quick explanation.
33. As a user, I want all presentations derived from the same model, so that the chat, terminal, and Hub views do not tell different stories.
34. As a user, I want images available as exports or fallbacks, so that I can use the result in clients or documents that cannot render the diagram.
35. As a user, I want Hub viewing to be optional, so that every diagram request does not redirect me away from my current conversation.
36. As a Hub reader, I want to pan, zoom, and fit a diagram, so that I can explore a larger model without losing readability.
37. As a Hub reader, I want to select a counterexample and follow its numbered steps, so that I can examine one failure without decoding every path at once.
38. As a Hub reader, I want to inspect a state's or transition's conditions and evidence on demand, so that the main diagram remains uncluttered.
39. As a keyboard or assistive-technology user, I want a readable state/transition list and accessible controls, so that I can inspect the same behavior without relying on mouse gestures or color.
40. As a user, I want diagrams to stay temporary unless I choose to retain them, so that quick explanations do not accumulate as shared project documentation.
41. As a user, I want to preview exactly what Save in Hub will retain, so that I can decide whether the artifact belongs in the working tree.
42. As a teammate, I want a saved snapshot to contain its model, rules, diagram, evidence, and results, so that I can inspect it without access to the original agent conversation.
43. As a teammate, I want saved snapshots to survive index rebuilds and ordinary Git sharing, so that they do not depend on one checkout's disposable databases.
44. As a user, I want Save to leave staging, commits, and pushing under my control, so that retaining a diagram does not publish unrelated work.
45. As a reader, I want changed or unavailable supporting evidence flagged on a saved snapshot, so that an old check does not imply that current code was checked.
46. As a user, I want regeneration to be explicit and produce a new preview, so that the product does not silently rewrite a saved explanation or renew its baseline.
47. As a user, I want saved diagrams readable when Graph or Wiki indexes are unavailable, so that I can still inspect the recorded snapshot and its limitations.
48. As a user, I want opening a diagram to display data without executing its model or helper scripts, so that viewing a shared artifact is an ordinary read.
49. As a developer, I want the packaged skill to work after a clean MEX installation or upgrade, so that the feature does not depend on this development checkout.
50. As a user, I want the agent to exercise judgment about when a state diagram helps, so that the feature supports understanding without forcing every explanation into the same format.

## Implementation Decisions

### Product surfaces and scope

- Use `mex-statechart` as the official managed skill name, following the existing MEX skill convention. Support direct Claude Code and Codex invocation and natural-language requests. This is a skill-led utility, not a dedicated user-facing MEX generation command.
- Register and ship it through the existing managed agent-assets installer. The installer already supports owned nested skill assets, so reuse its installation, update, conflict, and containment behavior rather than creating another installer.
- Keep the main skill instructions small and progressively load the modeling workflow, renderer guidance, and runtime helpers. Installation must not install Java or download the checker runtime.
- Add a lazy Diagrams collection/detail workbench to the existing Project Hub shell. Keep generation in the invoking agent; no Hub prompt composer, generation job, or hosted service is part of this release.
- Generate only in response to user intent. The agent may suggest a diagram and may choose another explanation when appropriate. Do not impose a rigid eligibility classifier or automatically diagram every agent response.

### Useful context, with source retained

- Start from the requested subject and current implementation. The preceding agent response identifies the topic; it is not independent evidence.
- Reuse the existing bounded Wiki, Router, Timeline, and Graph read surfaces through skill instructions. Do not build a parallel context index, automatic whole-repository ingestion pipeline, or new semantic state extractor.
- Query Wiki before broad project-knowledge discovery, inspect matched terms and available grounding health, then read the relevant live records. Use Router-directed tracked Markdown when the index is unavailable or insufficient.
- Retrieve historical notes only for a bounded subject or known file. Treat them as historical evidence and verify applicability before using them as current behavior or a rule.
- Use fresh Graph information to locate symbols and relationships when it improves discovery. A call graph is not a behavioral model. Changed, partial, or unavailable graph evidence must be identified and checked against source; ordinary reads never rebuild or refresh indexes.
- Every retained context item must explain a state, event, guard, rule, exception, recovery instruction, or meaningful abstraction choice. Record that relationship in the artifact. Omit context that contributes none of these. A short user-facing note should identify a material addition; do not manufacture an addition when source alone was sufficient.
- Current code governs a diagram labeled as implemented behavior. Retain conflicts with intended behavior or accepted knowledge as explicit findings rather than rewriting either side silently.

### Preserve the supplied statechart baseline

- Adopt a pinned, attributed copy of the original statechart skill/runtime with its license and reproducibility information. Keep TLA+ and TLC in the normal generation workflow; Mermaid syntax checking alone is insufficient.
- Preserve both directions: model concrete code or an existing specification, and derive a skeleton from a human-agreed chart. Existing-behavior explanation is the primary guided path; an elaborate design-authoring product is deferred.
- When a TLA+ specification exists, work from a copy and preserve its invariants. Code-versus-spec checks retain the reference specification unchanged and use its authors' applicable configuration.
- Use reader-observable states and events. Start with a small model; split states when a hidden distinction would obscure a failure or important step. Use independent regions when the modeled parts change independently. Do not replace domain labels with variable or action names.
- Retain provenance for code-derived variables, guards, and actions. Model indivisible implementation steps and attach exact source locations to the conditions being modeled. Stable artifact identifiers connect model states, projected states, transitions, rules, evidence, and traces; display text is not an identity key.
- Translate agreed rules into explicit invariants or appropriate temporal properties. Reuse established user/project rules with their source. Ask only when a new inferred rule or a material conflict needs human agreement. Never weaken a rule to obtain a passing chart.
- Preserve the baseline handling of settled-state rules, narrower observation points, reachability witnesses, projected overviews, concurrent regions, proposed fixes, and reference-model comparisons. Record what an overview omits.
- Keep a deliberate goal witness distinct from an implementation bug in the human-facing result, even when the upstream runtime represents it through an expected broken invariant.
- Render and inspect a fallback/export image as part of generation QA, while delivering native Mermaid first in supporting chats. Numbered paths must read in order; an export must not become the mandatory viewing surface.

### One artifact contract

- Establish one internal, versioned statechart artifact contract as the primary new application seam. The user confirmed this test approach. Generation helpers, the temporary-preview store, canonical snapshot storage, Hub projections, and presentation helpers consume this contract.
- Separate the agent's interpretation and evidence selection from deterministic validation, checking, projection, and storage. Do not add separate adapters for every renderer or context source unless an existing boundary requires one.
- An artifact includes a human-readable summary and scope; the subject and reader; implemented/proposed/agreed-model classification; model and checker inputs; mapping; rules and their provenance; normalized diagram structure and Mermaid; rule results; traces and numbered paths; evidence references and recorded baselines; reproduction results; omissions; and the exact toolchain/regeneration information.
- Preserve separate observations for diagram validity, model-check outcome, implementation reproduction, and evidence freshness. A passing model does not become a claim of implementation correctness. Model checking that is incomplete, cancelled, unavailable, or resource-limited must never appear as passed.
- A missing code mapping leaves implementation alignment unverified even if the mathematical model passes. For modeled implementation bugs, attempt an externally observable test or live reproduction. Report what execution proved and what source inspection supports. If reproduction disagrees, revisit the model rather than weakening the rule.
- For a design with no implementation yet, the checker trace is model evidence. Do not imply that a code reproduction exists.
- Keep full temporal-property counterexamples available even when there is no corresponding finite numbered path in the chart. Quote runtime counts from its machine-readable summary rather than counting the drawing.
- Use one human-readable Markdown record as the canonical owner of saved metadata, provenance, and change baselines, with bounded accompanying model, mapping, diagram, and result files. Structured projections can be derived; disposable indexes must not become the sole home of a claim about an earlier state.
- The saved collection is owned by the diagram feature. It is not a new Wiki entity kind, an Inbox proposal, a Relay, or a product Spec. Preserve Wiki/Team ownership rules so ordinary adoption or migration does not accidentally reinterpret or modify diagram bundles.

### Temporary preview and explicit save

- Perform modeling and tool execution in scratch space outside the repository. After validation, an explicit generation helper may register a bounded copy of the finished artifact in the checkout-local preview store. This is temporary private output, not a canonical save or a Git-sharing action.
- Store preview artifacts under the existing ignored local-state boundary with bounded retention. Reads do not create the store or perform cleanup. Expiration and eviction happen at explicit write/startup boundaries and leave an honest expired-preview response.
- The Hub reads preview artifacts by opaque repository-bound identifiers, never arbitrary filesystem paths supplied in a URL. Opening a preview must not execute its mapping, model, scripts, or regeneration command.
- If a Hub is already available, supply the correct authenticated viewing route through the normal session flow. Otherwise, make viewing an explicit follow-up using the existing Hub launch flow; do not start a Hub, open a browser, or emit a fabricated working localhost link merely to deliver the chat diagram.
- The Diagrams workbench shows temporary previews separately from saved snapshots. A preview can be inspected without saving. Its expiry and checkout-local boundary remain visible.
- Save in Hub presents the artifact summary, retained evidence, verification limitations, and intended working-tree writes. Apply through an authenticated, exact revision-bound save after that review, with real containment checks, deterministic bounds, and failure-atomic publication.
- Keep the first-release save operation simple: create an immutable snapshot with a unique identity. Regeneration produces a new preview; retaining it creates a new snapshot rather than silently overwriting an earlier one. Git remains the history and sharing mechanism.
- Preserve the last complete snapshot if saving fails. Never stage, commit, push, refresh an index, or change unrelated files as a side effect. Do not require Team member enrollment or an Inbox lifecycle merely to save an explanatory artifact.
- An explicit save may retain an incomplete-check result, but its incomplete status and limitations must remain visible throughout preview, storage, and display.
- Retain selected evidence and reproduction summaries, not the entire agent conversation, prompts, or raw tool-output history. Shared references are repository-relative; raw local diagnostics remain bounded and checkout-local. The save review shows the exact content being retained.

### Rendering and interaction

- Deliver fenced Mermaid from the checked artifact in chat clients that support it. Keep a compact overview first; reveal or link larger details rather than returning a giant diagram and a second wall of prose.
- Use the client's supported native terminal rendering when established. Provide a deterministic, readable ASCII/Unicode projection when native rendering cannot represent the required statechart. A TUI or client brand alone is not evidence of Mermaid or image support.
- Keep state identities, transition meanings, conditions, numbered paths, and check status consistent across Mermaid, terminal, image, and Hub presentations. Disclose omitted paths in reduced views. Presentation changes must not silently change the checked graph.
- Add a pinned, lazy-loaded Mermaid rendering dependency to the Hub. Use a statechart rendering proof early in implementation to confirm composite states, independent regions, line wrapping, and path/state identification before committing to its integration details.
- Provide pan/zoom/fit, selectable numbered counterexample paths, and a state/transition details panel for conditions, rules, and evidence. Path selection navigates a recorded trace; it is not a behavioral simulator. Supply an accessible text/list view of the same graph.
- Keep state and event labels dominant. Put implementation details, checker configuration, and source references behind inspection rather than in every node.
- Treat diagram source, labels, and imported artifact content as data. Disable embedded scripts, arbitrary HTML behavior, and executable Mermaid link directives. Render evidence links through the existing trusted Code/Knowledge routes or allowlisted repository references.
- Native chat interaction is limited by the host. The spec does not promise that every chat client's Mermaid view supports the Hub's path selection or evidence panel.

### Freshness, dependencies, and operational limits

- Saved artifacts are snapshots of recorded inputs. On read, compare only bounded recorded dependencies through immutable observations. Show changed, missing, or unverified evidence separately from the original check outcome. File and symbol change signals do not establish whether the old explanation is semantically wrong.
- Preserve baselines through Graph/Wiki rebuilds. Opening, refreshing the view, or obtaining a fresh index never regenerates the model or accepts a new baseline. Regeneration is an explicit agent action.
- Keep saved diagrams inspectable without Java and without healthy Graph/Wiki indexes. Existing results and models remain visible; any unavailable current freshness judgment is labeled unverified.
- Resolve the checker toolchain only on explicit generation. Reuse an explicitly supplied/existing compatible Java and TLC when available; otherwise use pinned, checksum-verified setup with visible first-use requirements and progress. Do not make every MEX install or Hub launch download the modeling toolchain.
- Bound subprocess time, memory, concurrency, state exploration, logs, artifact files/bytes, preview retention, collection scans, API responses, and browser work. Freeze concrete limits in the private contract before implementation and test refusal at those limits. Prefer existing upstream caps and MEX limit conventions; calibrate only the feature's owned budgets.
- Cancellation settles owned checker/renderer processes and never turns partial output into a successful result. Runtime/setup failure can leave a clearly labeled explanatory artifact when enough information is available.
- Keep the renderer out of Home and unrelated route asset closures, and keep Java/TLC out of the Hub process. Preserve the public package-root API and existing Graph/Wiki/Team protocols.
- Reuse existing Hub session, exact-Origin/CSRF, request validation, and safe-error projection behavior. Do not add diagram content, models, code excerpts, or evidence bodies to telemetry.

### Ordered build plan

1. **Freeze the artifact and upstream boundary.** Pin the source and license; inventory preserved baseline behaviors; define the private artifact schema, limits, identities, status semantics, and temporary-versus-saved ownership. Add small valid, broken-rule, temporal-property, expected-goal, and incomplete-check fixtures. Prove representative nested/parallel statechart rendering and terminal fallback before freezing the projection. Exit when the real checker can produce artifacts accepted by the contract and no status conflates rendering, checking, or reproduction.
2. **Ship the managed generation path.** Add the skill to existing installation/upgrade flows, package its helpers, implement selective context guidance, preserve both model directions, and produce native Mermaid plus terminal and image fallbacks. Exit when a clean packed installation generates an understandable, checked explanation without a Hub and without writing canonical project knowledge.
3. **Connect temporary artifacts to the Hub.** Implement the bounded local-preview repository and its private Hub projections through existing service/API composition. Add collection/detail navigation and honest unavailable/expired states. Exit when an artifact generated in another agent process can be inspected through an explicitly opened normal Hub session, with no arbitrary-path access or model execution.
4. **Complete the viewer and saved snapshots.** Add the lazy renderer, path selection, evidence inspection, accessible list view, exact reviewed save, snapshot reads, and recorded-dependency freshness. Exit when a user can preview, save, restart Hub, and reopen the same checked artifact, including an explicitly incomplete result.
5. **Qualify and release the complete first version.** Run the highest-level contract, checker, browser, packed-install, portability, and release-performance checks; verify representative output in the supported Codex and Claude clients; document toolchain setup, fallback behavior, save/sharing boundaries, and regeneration. Exit when native chat output and a readable terminal fallback work, saved artifacts remain portable, and no unrelated resource budget or public API has changed.

These are dependency-ordered implementation checkpoints, not separate product promises or permission to release a PNG-only or unchecked substitute. Routine library choice and limit calibration can be resolved during implementation within these constraints.

## Testing Decisions

- **Primary seam, confirmed by the user:** test the versioned artifact/application contract through generation, temporary preview, exact save, and reopen. Prefer observable artifacts, responses, filesystem effects, and reader-visible behavior. Avoid tests that merely assert helper calls, inspect source text, or mirror the implementation's internal flags.
- **Real checker coverage:** run small deterministic models through the packaged runner and real pinned TLC in the appropriate integration environment. Cover a passing invariant, a broken invariant with an ordered trace, a temporal-property failure, an expected reachability witness, and checking that cannot complete. Distinguish unavailable tooling from a passed test; required checker coverage must not silently skip in the qualifying CI job.
- **Evidence and context behavior:** use bounded fixtures and a retained human evaluation to show that relevant context can add a verified guard, exception, rule, or recovery instruction. Cover stale/missing indexes, source/knowledge conflict, historical notes, no useful additional context, and missing code mappings. Assert no implicit index maintenance or baseline renewal. Do not treat a keyword in a skill document as proof that an agent will reason correctly.
- **Prototype acceptance case:** explain MEX setup/interruption/recovery and include the specific old-process-after-clean-rebuild recovery when that condition is relevant. Readers should be able to answer whether files survive a pause, whether successful agent exit is enough, whether finalization means committed setup, and whether Retry fixes the removed-module failure. A deeper source-only investigation may discover the same condition; the test must not manufacture exclusivity for MEX.
- **Artifact/storage integration:** use a real temporary repository and the same consumer contract for the real implementation. Prove that preview reads do not initialize storage; save writes exactly its reviewed snapshot; stale plans, malformed schemas, oversize input, symlink/path escape, and interrupted publication refuse safely; existing saved snapshots survive failure and index deletion/rebuild. Assert unrelated files, staging, and Git refs remain unchanged.
- **Hub API integration:** extend the existing `createHubApp` harness style used by real Graph/Wiki integrations. Exercise session/Origin/CSRF checks, schema bounds, opaque IDs, temporary and saved reads, exact save, expired previews, unavailable freshness, and content that tries to become executable markup. Production must use the real repository service, not development fixtures.
- **Browser behavior:** extend the existing Hub component/API tests and Playwright/Axe approach used by Context graphs. Test pan/zoom/fit, recorded-path selection, correct step order, evidence details, accessible list navigation, empty/error/expired/incomplete states, readable labels, and supported viewport sizes. Assert reader-visible behavior and graph equivalence; do not freeze incidental SVG layout coordinates or whole-page screenshots as the behavioral contract.
- **Presentation equivalence:** compare generated states, transitions, rules, and path numbering across the normalized graph and each output. Simplification must disclose omissions and must not remove a material condition. Exercise nested/parallel-state examples and long labels, not only a three-node happy path.
- **Installation and client compatibility:** extend existing managed asset installation/update/conflict and packed Hub smoke-test patterns. A clean tarball install must contain the skill, runtime helpers, provenance/license files, and lazy Hub assets. Verify representative actual rendering in the target Codex and Claude versions; use the readable terminal fallback where native coverage is not established. Do not equate Claude mods, image-input support, or being a TUI with native statechart rendering.
- **Resource and regression gates:** check the feature's bounded subprocess and storage behavior and add its owned Hub route measurements to the existing release-performance harness. Preserve Home and shared budgets. Run focused tests, workspace typechecks, production/packed builds, relevant full regressions without concurrent build interference, portability checks, and an exact-head enforcing performance run before merge. Graph evaluator changes are not planned; run those suites if implementation actually changes that boundary.

## Out of Scope

- A new dedicated user-facing MEX generation command.
- Agent orchestration, agent-owned execution state, autonomous remediation, or using diagrams as an agent's runtime control plane.
- Generation or chat with an agent inside Hub, hosted inference, remote storage, notifications, or cloud sharing.
- A general diagram suite, automatic whole-repository state extraction, or a requirement to diagram every explanation.
- Visual state-machine editing, drag-to-change semantics, live execution/simulation, and a full design-authoring workbench.
- Claude-specific mods or custom client plugins in the first release.
- Assuming identical rendering capabilities across Codex, Claude Code, terminal emulators, desktop apps, and versions.
- Automatic canonical saves, automatic index maintenance, automatic regeneration, silent baseline renewal, automatic commits, or pushing.
- A new Wiki entity kind, a new Team workflow lifecycle, public application-port exports, or using disposable indexes as canonical diagram storage.
- In-product editing or overwriting of an existing saved snapshot; regeneration creates a new candidate and saving creates a new snapshot.
- A claim that passing model checks prove the entire implementation correct, that the model covers every behavior, or that MEX context always improves the result.

## Further Notes

**What the trial established.** The original skill and a bounded source-only inspection already explained normal interruption, retained files, validation, retry, and the distinction between finalization and commit. MEX's tracked setup pattern surfaced an additional condition: a clean rebuild can remove a lazy module still referenced by a running setup CLI; Retry in that process does not replace the old module references. Once files are finalized, close that process and use the current CLI's `setup --browser` flow to reopen the finishing page with the prepared files. Source inspection supported the mechanism, and a small Node fixture reproduced that module-replacement mechanism. The full live MEX setup/rebuild failure was not reproduced.

Both bounded trial models passed their configured checks. The source-based trial projected 18 model states to 12 chart states and 20 chart transitions; the focused recovery trial projected 8 model states to 6 chart states and 7 chart transitions. These counts came from the runtime summaries. Three existing terminal/agent/completion test files passed 26 tests with one skipped. These results support the trial's limited explanation, not a claim of exhaustive implementation verification or newly discovered bugs.

The useful additional context in that trial came from tracked Markdown. Graph was stale and Timeline supplied no further recovery fact. The product should preserve this selectivity. The evidence establishes one useful, fairly narrow example; it is not a controlled study or proof that the standalone skill could never find the same condition.

**Presentation decision.** The user explicitly preferred the same flow as an inline Mermaid state diagram over its PNG export. Native rendered chat diagrams are therefore the preferred delivery, not a later enhancement. The Hub supplies richer inspection; it must not become a mandatory detour.

**Source baseline.** The supplied skill matched the MIT-licensed [statechart skill in backnotprop/pstack](https://github.com/backnotprop/pstack/tree/fad8d01588a1b1ae803f87c8a1e0de79e28cffec/skills/statechart). The trial used that pinned revision, TLC 1.7.4, and pinned renderer dependencies. Preserve attribution and reproducibility when packaging the adapted workflow. The selected runtime's dependency strategy and exact client compatibility must be qualified during the first implementation checkpoint rather than assumed from the prototype.

**Architectural fit.** This spec follows MEX's existing decisions: tracked files retain durable knowledge/baselines, ordinary reads remain immutable, writes are explicit and bounded, Hub contracts remain private, and public exports change only through a separate compatibility decision. The main new boundary is the artifact contract; existing managed-skill, Hub service/API, browser-test, and release-performance seams are reused.

**Delivery and implementation boundary.** The user explicitly chose local-only delivery. This spec remains an uncommitted working-tree document; no GitHub issue or triage label is created. It records a proposed build plan, not an npm release or accepted Wiki policy, and it does not authorize unrelated canonical Team actions or execute the implementation plan.
