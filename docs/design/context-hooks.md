# `mex context` and agent hooks

Status: in implementation on `feat/context-hooks`.

## Goal

Deliver the right MEX knowledge to a coding agent at the moment it is needed, without the agent having to ask, and send nothing when nothing clearly fits. Agent-arm runs showed that pull (agents calling the CLI) cost +93% tokens versus plain file search, static Markdown cost +38% to +50%, and hook-pushed knowledge was the only delivery that came out ahead (TypeScript −8%). This design moves the hook prototype's logic into MEX as one read-only composer, `mex context`, that hooks call.

## Shape

```
hook event ─► light entry (mex-hook) ─► src/context composer ─► packet (stdout JSON for the host)
                                            │
                    .mex/local/context-index.json   .mex/graph.db (read-only)   session state
```

- **Composer (`src/context/`)**: pure, in-process, read-only. Never refreshes an index, never regrounds, never writes canonical files.
- **Context index**: `.mex/local/context-index.json`, derived from the Wiki entities and the graph. It is rebuilt by `mex context index`, and lazily when its recorded inputs (Wiki index identity, graph snapshot identity, `.mex` Markdown digests) change. It is disposable and checkout-local.
- **Light entry point**: a separate small bundle that loads only the composer. Starting the full CLI costs about 0.46 s, against about 0.1 s for bare Node, which is too slow for per-file hooks.
- **Root resolution**: every context and hook command finds the project root from any working directory.

## Events

| Event | Input | Selection | Model |
|---|---|---|---|
| `prompt` | user prompt text | ranking (below) plus gate | optional MiniLM |
| `read` | file plus read range | facts whose code links overlap the range; ⚠ when the linked code changed | none |
| `edit` | edited files (Edit/Write/MultiEdit and Bash diff) | facts linked to touched lines, with the `.mex` line to update | none |
| `grep` | search results | for the top hits: enclosing symbol, linked fact, callers; tests and docs marked | none |
| `stop` | session diff | touched-but-unseen facts get one prompt; settle worker afterwards | none |

## Prompt ranking (frozen recipe)

Chosen by a sealed held-out evaluation: 70 questions over Hono and TypeScript, split into dev and test halves; thresholds were frozen on dev and the test half was run once.

- **Primary (R3)**: candidates are `fact` entities. Field-weighted BM25 over title (×3), body, linked-code tokens and aliases (×3), with stop words and an exact identifier/backtick/path boost. It is fused by RRF (k=60) with an `all-MiniLM-L6-v2` (q8) dense channel over `title. aliases. symbol words. body[0:900]`.
  - Gate: normalised floor 0.2591; exact identifier hit or at least 5 query-term groups; cosine at least 0.6; at most 2 facts; a second fact only at a ratio of at least 0.2 of the first.
  - Test half: helped 17/24, 3 of 20 injected wrong, 0/10 false injections.
- **Fallback (R2w)**: lexical only, used when the semantic extra is not installed. Candidates are all typed Wiki sections (fact, convention, decision, guide, pattern, component) with body text. Floor 0.4186, G 5, ratio 0.5, margin 0.45.
  - Test half: 17/24, 5 of 22 wrong, 0/10.
- **Stop list**: words about code ("error, issue, problem, update, test, function…") never count as query concepts.
- **Abstention is logged**, with a reason (`no-index`, `below-floor`, `uncorroborated`, …).

The semantic channel is opt-in. Its library and model (about 23 MB) are installed under a MEX-managed directory on request. When they are absent, R2w is used, with no error.

## Packets

Packets use one compact format, since `file:line #symbol` locations halved the injected text in the prototype:

```
MEX knowledge (fresh) — <title>
<fact text, trimmed>
code: src/x.ts:120-180 #symbol · more: mex wiki show <id>
```

- At most 2 facts per prompt and at most 4K chars per event, well under the host's 10K-character limit.
- Facts already shown in this session are not repeated.
- Each packet says which channel selected it.

## Freshness and end of session

- Health is computed live for the entities a packet shows: graph `bodyHash` against the grounded hash. Cached Wiki-index health is never trusted after edits.
- `stop` asks the agent once about touched facts it has not seen. A detached settle worker then refreshes the graph and re-records (regrounds) **only** entities whose prose the agent edited or explicitly confirmed. Every other touched entity stays flagged "changed, re-check". The Hono complete-set CORS wrong renewal is the regression fixture.
- `wiki reground` accepts several ids in one snapshot (batch).

## Authoring

Setup, GROW and `wiki apply` write 3–6 short symptom or goal phrases per code-linked fact into the existing `aliases` field. Fingerprints and code links are recorded by MEX itself, not copied by agents.

## Installation

`mex hooks install --tool claude` (with `--dry-run` and `remove`) writes the hook entries to `.claude/settings.json` and preserves user-owned entries. Other hosts come later, through the same composer.

## Evaluation gate

- **Offline**: the frozen recipe must reproduce the evaluation's injections on the held-out set (parity), at under 0.2 s for read/edit/grep and under 1.5 s for prompt with the semantic extra.
- **Agent runs**: on Hono and TypeScript, fewer total tokens than the files arm and the files + sgrep arm, with equal correctness. Input and output tokens are reported separately, and every arm gets the same concise-answer instruction.
