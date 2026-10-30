# State diagrams in coding-agent workflows: exploratory research

Researched 26 October 2026. This is an exploratory working-tree research note, not an accepted product direction or canonical MEX knowledge. Sources are primary specifications, official documentation, project source, and an original research paper. No tools were installed or executed to validate their advertised capabilities.

## Main finding

There are two different opportunities: help an agent understand **the software's behavior**, or control **the agent's own execution**. Both can use states and transitions, but they solve different problems. A third opportunity is to preserve and maintain a behavioral model across changes. MEX's possible advantage in that third category—connecting a model to repository evidence and remembered decisions—is a hypothesis to investigate, not an established benefit.

Existing tools already render state diagrams, execute state machines, generate test paths, and expose model tools to agents. The interesting product question is therefore what a developer or coding agent would know or do better because MEX supplied relevant context, history, and evidence. A generic diagram generator would need a separate reason to exist.

## What the different diagrams mean

| Representation | Question it answers | Example | Important boundary |
| --- | --- | --- | --- |
| Finite state machine (FSM) | What modes can one subject occupy, and which events permit changes? | An upload is queued, uploading, failed, or complete. | States are an abstraction, not every variable value in the implementation. |
| Statechart | How do hierarchy, concurrent regions, and communication structure behavior? | An upload session has connection and transfer regions, with retry behavior nested inside transfer. | Execution semantics matter; similar pictures need not imply identical behavior. |
| Flowchart | Which operation or branch happens next? | Validate input, choose a handler, write a file. | A function call or work step is not necessarily a persistent domain state. |
| Sequence diagram | Which participants exchange messages, in what order? | Client requests upload; server returns a signed URL; storage confirms completion. | It illustrates interactions rather than enumerating a subject's lifecycle. |

Stately describes statecharts as extending finite state machines with hierarchy, concurrency, and communication. Mermaid provides separate state, flowchart, and sequence notations; its sequence documentation specifically models participant interactions over order. The distinctions above are a practical synthesis of those definitions, not a claim that every real model fits one exclusive category. Sources: [state machines and statecharts](https://stately.ai/docs/state-machines-and-statecharts), [Mermaid states](https://mermaid.js.org/syntax/stateDiagram.html), [flowcharts](https://mermaid.js.org/syntax/flowchart.html), [sequences](https://mermaid.js.org/syntax/sequenceDiagram.html).

A useful behavioral description should name the subject, states, triggering events, guards, effects, initial condition, termination, and scope. For example, `failed → uploading` is incomplete until the author states whether retry requires a valid session, whether attempts are bounded, and what data survives. This is a modeling recommendation: the labels alone cannot answer these questions.

## Pictures, executable models, and verification

**Mermaid is a convenient authoring and rendering layer.** Its state syntax supports labeled transitions, composite states, choices, forks/joins, and concurrent regions. It can make a proposed behavior reviewable in ordinary text. Its state-diagram documentation does not define a behavioral execution engine or prove that repository code conforms to the drawing. Syntax validation, rendering, model execution, and implementation verification should therefore be treated as separate capabilities. [Mermaid state syntax](https://mermaid.js.org/syntax/stateDiagram.html)

**XState and SCXML supply execution semantics.** XState supplies state-machine/statechart logic that actors can execute. SCXML is a W3C recommendation specifying a state-machine execution environment: transitions can have events and conditions, states can be hierarchical or parallel, executable content can run on entry/exit, and processing follows defined run-to-completion rules. Choosing an executable model commits to semantics beyond a diagram's visual layout. It does not, by itself, implement every external action that the application needs. [XState repository](https://github.com/statelyai/xstate), [SCXML specification](https://www.w3.org/TR/scxml/)

**Model-based tests need a connection to real behavior.** XState graph utilities generate shortest or simple paths through reachable states. Those paths can drive test scenarios; the testing documentation shows sending events and checking state and side effects. For an existing application, an adapter still has to translate model events into API/UI calls and check meaningful observations. Model-state coverage is not automatically source-code coverage, requirements completeness, or evidence that external integrations behave correctly. [Graph and paths](https://stately.ai/docs/graph), [testing](https://stately.ai/docs/testing)

For MEX, this suggests preserving three separately inspectable claims: “the drawing parses,” “the model has the stated properties,” and “the implementation passed these model-derived checks.” Combining them into one green check would hide important uncertainty. This is an inference from the different tool contracts, not a proposed product decision.

## What agent workflows actually do today

**A real coding agent need not be implemented as a statechart.** The mini-swe-agent project documents a loop that queries the model, executes actions, formats observations, and appends messages. Completion, limits, formatting problems, timeouts, and interruption are represented through exception-based control flow and trajectory messages. Its own explanatory diagram is a Mermaid flowchart. This is evidence of a coding-agent implementation and diagram use; it is not evidence that giving that agent a domain state diagram improves its patches. [mini-swe-agent control flow and linked implementation](https://github.com/SWE-agent/mini-swe-agent/blob/main/docs/advanced/control_flow.md)

**LangGraph makes orchestration explicit.** Its graph API combines shared state, computational nodes, and edges deciding what runs next. Here “state” is a data snapshot and nodes are functions; a graph node is not necessarily a mutually exclusive application mode. Its persistence layer distinguishes per-thread checkpoints from stores for cross-thread information. This matters for the MEX discussion: remembering facts and decisions across sessions is a different concern from saving the current execution checkpoint. These are general agent orchestration primitives, not evidence of better coding-agent performance. [Graph API](https://docs.langchain.com/oss/python/langgraph/graph-api), [persistence](https://docs.langchain.com/oss/python/langgraph/persistence)

**AutoGen makes another useful separation.** GraphFlow constrains which agents execute in sequence, parallel, branches, or loops. Its documentation distinguishes the execution graph from the message graph: execution edges do not automatically restrict which messages an agent receives. It marks GraphFlow experimental. Consequently, a workflow picture should not be assumed to describe context access, memory boundaries, or tool permissions unless those are modeled separately. [AutoGen GraphFlow](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/graph-flow.html)

**Agent-facing state-model tooling already exists.** Stately MCP documents validation, execution, exploration, comparison, conversion, and visualization. Its verification tools have a crucial boundary: `verify` depends on a host-provided execution adapter and otherwise reports `verification_unavailable`; its test-path tool retrieves recorded paths from a report rather than planning or running new tests. Thus “available through MCP” and “can verify this arbitrary repository” are different claims. [Stately MCP](https://stately.ai/docs/packages/mcp)

The current Stately docs also describe an agent package that combines XState with typed model requests, decisions, and host executors. This is another precedent for state machines as agent logic, rather than just drawings shown to an agent. The pages inspected display **XState v6 alpha**. Their API details should not be silently applied to an installed XState v5 project. [Stately Agent](https://stately.ai/docs/packages/agent)

## What empirical evidence supports

An IJCAI 2025 paper, **FSM-SCG**, turns natural-language smart-contract requirements into a finite-state representation, generates code, and iteratively uses compiler and security feedback. Its reported Llama3.1-8b comparison lists compilation pass rates of 36.9% for direct generation, 49.3% for its FSM-only variant, and 95.1% for the complete framework. That ablation is more informative than repeating the abstract's largest improvement: the complete approach contains substantial feedback machinery beyond the intermediate model. [Original paper and proceedings record](https://ijcai.org/proceedings/2025/653), [paper PDF](https://www.ijcai.org/proceedings/2025/0653.pdf)

This supports investigating behavioral models as intermediate specifications in a constrained programming domain. It does **not** establish that visual diagrams alone improve general coding agents, that arbitrary repositories can be accurately reverse-engineered, or that persistent MEX memory provides a measured improvement. The study was not reproduced here. Its setting and bundled components limit transfer to MEX.

## Extraction and freshness: where confidence can go wrong

The following are engineering inferences to validate, rather than capabilities established by the sources above:

- An explicitly declared machine or transition table can be read more directly than behavior distributed across handlers, database updates, callbacks, and network services. A field named `status` is only a candidate state variable.
- Current code describes implemented behavior; requirements describe intended behavior; historical notes explain prior reasoning. A model should retain those distinctions when they conflict.
- Runtime traces show observed paths. An unobserved transition may still be possible, and a modeled transition may lack an executable path in the real system.
- Source links and file hashes support traceability and change detection. They do not prove that a model is semantically current: behavior may depend on configuration, a remote service, or a file outside the recorded grounding.
- Testing a model generated by the same mistaken interpretation as the implementation can reproduce the mistake. Independent requirements, invariants, and failure examples are needed as checks.
- Concurrency, timeouts, retry budgets, compensation, and data-dependent guards are places where an attractive simplified diagram can omit the very behavior a developer needs.

## Verified fit with the current MEX checkout

The current [graph vocabulary](../../src/graph/types.ts) describes symbols and structural/call/reference relationships, not state transitions, events, or guards. It can locate implementation evidence; interpreting a lifecycle still requires source inspection or a new extraction layer.

MEX already distinguishes change detection from truth: [fact-aware drift](../../src/wiki/grounding/fact-drift.ts) explicitly states that a body hash establishes that a symbol changed, not whether a grounded sentence remains true. [Grounding resolution](../../src/wiki/grounding/resolve.ts) distinguishes changed and unverified evidence. Grounding individual diagram transitions would be an extension, not an existing capability.

[Timeline retrieval](../../src/events.ts) supplies bounded literal message queries and exact recorded-file matching. Historical decisions can inform a model, but retrieval does not establish that those decisions still describe current behavior.

A concrete example is Relay: [its persisted states](../../src/team/contracts/workflow.ts) are `published → acknowledged → closed`. The [workflow guards](../../src/team/workflow/repository-team-workflow-port.ts) restrict acknowledgement by audience/recipient eligibility; closing requires an acknowledged Relay, active sender and claimant, and an actor who is one of those principals. A three-node picture would omit these rules. A diagram utility could make the guards, implementation evidence, and remembered rationale inspectable together. That last sentence is a product hypothesis.

Related research reinforces the need to inspect details: a [2026 state-machine generation study](https://arxiv.org/abs/2604.00275) reports uneven results for states, transitions, guards, and actions. Its evaluated models and natural-language modeling tasks do not establish performance for current coding agents or MEX.

## Terminal and TUI delivery: documentation follow-up

Checked 26 October 2026. Human-facing visual output must be distinguished from an agent accepting or inspecting image inputs.

**Codex CLI has native Mermaid rendering for a supported subset.** Official release notes for CLI 0.156.0, dated 22 September 2026, announce diagrams directly in responses and identify a bounded text renderer. The 0.158.0 notes describe fallback to source for unsupported diagrams; 0.159.1 adds more flowchart syntax and lists a state-description parsing fix. The notes do not provide a complete statechart compatibility matrix. Nested/parallel states, styling, and the proposed skill's actual output still need a representative rendering check before MEX promises compatibility. The locally installed CLI reports 0.160.1; no interactive rendering test was performed. The official changelog was read through its browser interface because its full page exceeded the web extraction tool's size limit. [Official OpenAI changelog](https://learn.chatgpt.com/docs/changelog?date=2026-09-22)

**Claude Code mods can supply a custom viewing interface.** Official documentation describes panes, controls, replacement of existing interface components, and shared state. It explicitly distinguishes a mod running inside Claude Code from a skill that supplies instructions. Therefore a portable skill alone is not a custom TUI renderer; a Claude-specific mod is an additional integration. No native Mermaid parser/renderer was established by the official documentation reviewed. This is a documentation limit, not proof of absence. [Mods overview](https://code.claude.com/docs/en/plugins/mods/overview), [drawing interfaces](https://code.claude.com/docs/en/plugins/mods/interface)

**Claude's output support varies by surface.** Its mod gallery documents text and character-cell drawing, plus terminal PNG/raw-pixel images in kitty 0.28+, Ghostty, and iTerm2 3.5+ (the latter also requires Claude Code 2.1.305+). Fullscreen, tmux, and image-source conditions apply. Unsupported environments show alternative text. The SVG element renders in Desktop/VS Code, but not terminal panes. A Mermaid-to-image or Mermaid-to-text conversion would be our adapter, not an automatic consequence of a Mermaid code fence. [Official element gallery](https://code.claude.com/docs/en/plugins/mods/gallery#image-and-client)

Product inference: keep one underlying model and consistent meaning across outputs. Supported native diagrams, compact ASCII/Unicode views, portable images, and the Hub viewer can be presentations of that model. Preserve important distinctions and disclose omitted paths in simplified views. Automatic browser opening, adapter scope, and which preview is the default remain interview decisions. No mod, renderer, or additional runtime was installed or executed during this follow-up.

## Candidate MEX directions — hypotheses for the interview

| Hypothesis | Context/memory contribution to investigate | Concrete outcome to test |
| --- | --- | --- |
| Explain an existing lifecycle | Gather code, tests, relevant decisions, and contradictions for one bounded subject. | A developer can locate a transition's evidence and identify an unknown edge case. |
| Design a behavior change | Show proposed transitions beside grounded current behavior and remembered constraints. | Reviewer and coding agent agree on the changed behavior before implementation. |
| Maintain a behavioral memory | Preserve why states/guards exist and flag changed supporting evidence. | A later session avoids repeating a resolved argument and detects stale grounding. |
| Guide implementation and tests | Retrieve a reviewed model, map transitions to code/tests, identify missing checks. | A behavior-changing patch is assessed against specific events and invariants. |
| Orchestrate agent work | Make investigation, implementation, checking, interruption, and recovery explicit. | A constrained workflow resumes correctly and enforces its actual transition policy. |

These are competing starting points. None requires selecting a renderer, runtime, canonical storage format, approval workflow, or automatic extraction policy yet. A small real example should determine whether the value lies in understanding, design, maintenance, testing, or execution control.

## Evidence map and unanswered decisions

| Evidence | Establishes | Does not establish |
| --- | --- | --- |
| Mermaid official syntax | Text-authored behavioral visualization | Executable semantics or code conformance |
| SCXML / XState | Executable state-model semantics | Correctness of arbitrary external actions |
| mini-swe-agent source/docs | A concrete coding-agent loop and explanatory flowchart | Benefit from domain diagrams |
| LangGraph / AutoGen docs | Structured orchestration and distinct persistence/context concerns | General coding-quality improvement |
| Stately MCP docs | Existing agent-accessible model tooling and adapter boundary | Turnkey verification of arbitrary repositories |
| FSM-SCG original study | Domain-specific empirical support for a model-plus-feedback approach | General MEX or diagram-only effect |

The interview should resolve: whose state is being modeled; the painful real task; who consumes the result; whether it describes implemented or desired behavior; what evidence is sufficient; who resolves contradictions; what “stale” should mean; and what observable improvement would justify maintaining the artifact. Freshness, trust, and usefulness remain open product questions.
