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
| `read` (opt-in) | file plus read range | facts with resolved links of at most 300 lines overlapping the range; ⚠ when linked code changed | none |
| `edit` (opt-in) | edited files (Edit/Write/MultiEdit and Bash diff) | precisely cited claims touched by a hunk, with a body-line pointer | none |
| `grep` | search results | linked claims and verified definition or enclosing-symbol locations | none |
| `stop` | session diff | flag touched facts and start settle; review prompt is opt-in | none |

## Prompt ranking (frozen recipe)

Chosen by a sealed held-out evaluation: 70 questions over Hono and TypeScript, split into dev and test halves; thresholds were frozen on dev and the test half was run once.

- **Primary (R3)**: candidates are `fact` entities (since the long-prompt work, every typed section with a body as well; see Long prompts below). Field-weighted BM25 over title (×3), body, linked-code tokens and aliases (×3), with stop words and an exact identifier/backtick/path boost. It is fused by RRF (k=60) with an `all-MiniLM-L6-v2` (q8) dense channel over `title. aliases. symbol words. body[0:900]`.
  - Gate: normalised floor 0.2591; exact identifier hit or at least 5 query-term groups; cosine at least 0.6; at most 2 facts; a second fact only at a ratio of at least 0.2 of the first.
  - Test half: helped 17/24, 3 of 20 injected wrong, 0/10 false injections.
- **Fallback (R2w)**: lexical only, used when the semantic extra is not installed. Candidates are all typed Wiki sections (fact, convention, decision, guide, pattern, component) with body text. Floor 0.4186, G 5, ratio 0.5, margin 0.45.
  - Test half: 17/24, 5 of 22 wrong, 0/10.
- **Stop words**: the tokenizer drops common English function words and a short list of conversational filler ("please, explain, describe, show, want, need, really…"), plus the project's own name (root directory name and `package.json` name, derived at index time). Words about code ("error", "issue", "update", "test", "function"…) are *not* stop words in the frozen recipes: that list only feeds the segment channel, which is disabled.
- **Abstention is logged**, with a reason (`no-index`, `below-floor`, `uncorroborated`, …).

The semantic channel is opt-in. Its library and model are installed under a MEX-managed directory on request: about 68 MB on Windows, of which the model is 23 MB. A stock install is about 500 MB, because the library hard-depends on native runtimes for every platform plus a second, web runtime; the installer stubs `sharp`, removes the web runtime and keeps only this platform's CPU binaries. (The WebAssembly runtime would be about 56 MB, but its quantised kernels differ from the native ones enough to move one held-out injection across the cosine threshold, so it is not used.) When the extra is absent, R2w is used, with no error.

### Long prompts (windows)

The recipes above were calibrated on one- and two-sentence questions. Real task prompts run from 5 words to pasted pages. The normalised score divides by the weight of every query word, so a 55-word task description scored below the floor even when its one matching sentence scored 0.64 alone: with the thresholds above, all six pilot prompts abstained. The fix keeps the frozen recipes for prompts that fit in one window and changes only how a longer prompt is scored and gated. Parameters are frozen in `frozen.ts` (`WINDOWING`, `RECIPES[*].windowed`) and recorded, with the evidence, in the evaluation folder as `ablation\frozen-v3.json`.

- **Short prompts keep their output.** A prompt of at most 40 words ranks, gates and renders as before, unless `MEX_PROMPT_SHORT_POLICY=1` explicitly enables the revised policy, including the experimental independent margin. Both recipes passed 130/130 short packet and explanation comparisons. `MEX_PROMPT_INDEPENDENT_MARGIN=1` alone does not change short prompts.
- **Prose only.** Fenced blocks, stack frames, test-runner summaries and runs of at least three code-like lines are removed before scoring (`proseOf`). A paste says what the user is looking at, not what they ask, and its identifiers belong to the pasted file. Measured on dev, treating identifiers found in pasted blocks as exact-match evidence made the very long bucket worse (more wrong sends, fewer hits). With under 10 words of prose, the whole text is scored.
- **Windows.** The prose is cut into sentences (a sentence under 10 words is merged into its neighbour, one over 40 words is cut). A cut's tail of fewer than 10 words is merged into the preceding chunk, which may then exceed 40 words. Overlapping runs become windows (at most 12; a window contained in another is dropped). Each window is scored by the frozen scorer against its own query-word weight, with its own identifiers and its own corroboration count; a candidate keeps its best window. The dense channel embeds each window and takes the best cosine.
- **Gate for a windowed prompt.** The maximum over many windows flatters the runner-up too, so the lead over the fourth candidate carries the weight. Both recipes use the same lexical gate: floor 0.293, at least 4 (lexical) or 3 (semantic) query-word groups in one window (or an identifier hit), a second entry only at 0.9 of the first, lead over the fourth 0.45 (lexical) or 0.6 (semantic), at most 2 entries. The semantic recipe adds its cosine as a veto: candidates with a best-window cosine under 0.5 are dropped before the gate, and the fusion only orders the rest.
- **Candidates.** R3 ranks the same typed sections as the lexical recipe plus every fact. For prompts over 40 words, component and guide entries are excluded at the gate, after ranking, so corpus statistics and cached vectors stay intact. Conventions, decisions and patterns remain eligible. The dense text of a non-fact is unchanged (title, aliases, symbol words, first 900 characters).
- **Independent margins are experimental.** `MEX_PROMPT_INDEPENDENT_MARGIN=1` enables the independent-grounding competitor rule and exact-symbol margin bypass for revised prompts. It is off by default: replay lost labelled gold hits and added irrelevant sends. The normal floor, corroboration and semantic veto still apply.
- **Related pointer.** A revised prompt packet containing one full fact may add one body-free title/id pointer to an unseen fact sharing a grounding node. The pointer has its own `pointer:<id>` memory and does not suppress a later full fact. It is navigation, not a guaranteed answer.
- **Abstentions.** A windowed semantic veto reports `low-cosine-veto`; graph fallback logs its own reason alongside `knowledge:<reason>`. Revised prompts with no lexical matches return before embedding. The hook loads the local model only on the first embedding request.

Measured on the development half (24 with-fact and 12 without-fact questions per bucket; "correct" is the share of injections that carry a gold entry; false sends are injections on questions without a fact):

| Dev | Old R2w | New R2w | Old R3 | New R3 |
|---|---|---|---|---|
| Short (original) | 14/24, 14/18, 1/12 | 15/24, 15/19, 1/12 | 13/24, 13/17, 1/12 | 13/24, 13/16, 1/12 |
| Medium (60-96 words) | 4/24, 4/6, 0/12 | 14/24, 14/16, 0/12 | 9/24, 9/13, 1/12 | 16/24, 16/20, 1/12 |
| Very long (305-1,500 words) | 0/24 | 10/24, 10/15, 3/12 | 0/24 | 11/24, 11/14, 1/12 |

Methods tried on dev (lexical recipe, thresholds searched per method under the same rule; the rule needed at least 70% of the short bucket's helped in the medium and very long buckets):

| Method | Medium helped | Very long helped | Verdict |
|---|---|---|---|
| Whole prompt, normalised as before | 4 | 0 | the bug |
| Truncate to the first 500 or 1,000 characters | 4 | 0 to 1 | fails whenever the question is not at the start: with the question at the start, middle or end of the very long prompts, 500 characters found 3 of 16, 0 of 15 and 0 of 17 hits (dev and test pooled, lexical) against 7, 7 and 7 for windows | 
| Keep only the 8 to 16 rarest query words (whole prompt) | 0 to 2 | 0 | loses the corroboration that separates a match from a coincidence |
| Rare-word reduction inside each window | 10 | 7 | worse than plain windows |
| Length-aware sigmoid of the raw score (five length tiers) | 0 to 2 | 0 | the raw scores here sit far from the tier midpoints; no setting passed |
| Evidence gate (resolved identifier, two words in one entry's title, aliases and symbol names, or one rare word of at least 5 letters present in 2 to 25 entries) in place of the corroboration count | 14 | 10 | the same as the corroboration count once the lead rule is in place, so the simpler count stays |
| Windows, pasted blocks kept | 11 to 12 | 1 to 5 | many wrong sends from pasted identifiers |
| Windows over prose (shipped) | 14 to 16 | 10 to 11 | |

A rising floor with the number of windows and a rule that drops a second entry coming from a distant window were also searched and gave no gain, so neither is in the gate. The false-send growth that many windows could cause is bounded instead by prose-only scoring, the cap of 12 windows, the 0.9 second-entry ratio and the lead rule. A one-line "may apply" pointer tier for a rejected-but-clear leader was not built.

Test half (v3 is a second look; the single one-shot run used v2, which differed only by keeping prompts up to 56 words whole and gave R2w 17/24 on the short bucket instead of 16/24, and the same numbers elsewhere):

| Test | Old R2w | New R2w | Old R3 | New R3 |
|---|---|---|---|---|
| Short | 17/24, 17/22, 0/10 | 16/24, 16/19, 0/10 | 17/24, 17/20, 0/10 | 17/24, 17/21, 0/10 |
| Medium | 15/24, 15/15, 0/10 | 15/24, 15/17, 0/10 | 15/24, 15/16, 0/10 | 17/24, 17/21, 0/10 |
| Very long | 0/24 | 11/24, 11/25, 4/10 | 0/24 | 12/24, 12/26, 4/10 |

The very long bucket does not meet the precision rule on test. In that set one unrelated paragraph, taken from another question's prompt, is pasted into every prompt; it is a real question about another topic, so the entry it matches is sent. 10 of the 14 wrong R2w injections (and 8 of 14 for R3) and 3 of the 4 R2w false sends (2 of 4 for R3) match only that paragraph. Without them R2w is 11 of 15 correct and R3 12 of 18. Nothing in a prompt's content separates a pasted paragraph from the question, so this is reported, not tuned away: the gate is precision-first for one coherent question, and a prompt about two topics may get the wrong one.

Corroboration 4 for the lexical recipe (2026-10-18; it was 3 when the tables above were measured). On the agent-run task prompts (54 to 271 words with the run's instruction suffix), the lexical recipe sent two unrelated entries, each picked with no identifier hit and exactly 3 matching words in one window, all ordinary prose ("SQLite", "settings", "objects"): a setup guide on environment variables for a SQLite literal bug, and a QuerySet caching fact for an admin delete trace. Requiring a fourth word (the same as requiring an identifier hit when only three words match) changes nothing on the length buckets: dev and test injections are identical for both recipes in every bucket, so the tables above stand; on dev the gate decision moved only for unsent runner-up candidates of 19 lexical prompts, all over 40 words. On all 33 agent-run prompts (Hono 10, TypeScript 13, Django 10; both recipes, through the hook entry point) those two entries are the only change: the two prompts now inject nothing, the graph tier stays silent for them, and the other 64 outputs are byte-identical, including a QuerySet cloning entry matched by 4 words and an identifier. The one-window parity check still gives 65 of 65 identical. The semantic recipe keeps 3: its cosine veto already rejected both coincidences, and a fourth word dropped a correct dev entry (`ts-09`, medium and very long). Also measured: corroboration 5 for the lexical recipe lost two correct medium dev entries; a floor of 0.4 for three-word picks removed one of the two entries, and 0.5 removed both only because one scored 0.496, at the cost of a second threshold.

Latency (cold process per prompt, Windows): hook entry point, lexical 220 to 260 ms and semantic 770 to 850 ms on short, medium and very long prompts alike, including the 1,500-word prompt; `mex context prompt`, lexical about 440 ms and semantic 900 to 1,000 ms.

## Packets

Packets use one compact format, since `file:line #symbol` locations halved the injected text in the prototype:

```
MEX knowledge (fresh) — <title>
<fact text, trimmed>
code: src/x.ts:120-180 #symbol · more: mex wiki show <id>
```

- At most 2 facts per prompt and at most 4K chars per event, well under the host's 10K-character limit. A session also has a total budget (12K characters by default, `context.sessionBudgetChars`); see Milestone 2.
- Facts already shown in this session are not repeated.
- Each packet says which channel selected it.

## Freshness and end of session

- Health is computed live for the entities a packet shows: graph `bodyHash` against the grounded hash. Cached Wiki-index health is never trusted after edits.
- `stop` does not block by default. It records touched facts in the session flags and starts a detached settle worker for tracked indexed source edits even when no fact was touched. That path refreshes only, with no reground when no entity is eligible. Reground remains limited to entities whose prose the agent edited or explicitly confirmed. Every other touched entity stays flagged "changed, re-check". The earlier in-session question is opt-in (`MEX_HOOK_STOP_REVIEW=1`).
- `mex check` reports resolved session-touched entities as `GROUNDING_REVIEW` (warning), including those the worker re-recorded on the session's word. An unresolved link cannot establish hunk overlap; never-resolved links and old flags without current symbols remain `GROUNDING_UNVERIFIED`, not file-level review. Stop and check also compare edited Markdown with HEAD for lost ids, headings and changed entity counts (`WIKI_ENTITY_DAMAGED`); damaged files cannot qualify for reground. `mex sync` hands review findings to its session; an entity whose prose the run rewrote, or that was confirmed during the run, is cleared; an unchanged, unconfirmed one stays. `mex context confirm` clears a review mark.
- `wiki reground` accepts several ids in one snapshot (batch).

## Authoring

Setup, GROW and `wiki apply` write 3–6 short symptom or goal phrases per code-linked fact into the existing `aliases` field. Fingerprints and code links are recorded by MEX itself, not copied by agents.

## Installation

`mex hooks install --tool claude` (with `--dry-run` and `remove`) writes the hook entries to `.claude/settings.json` and preserves user-owned entries. Other hosts come later, through the same composer.

The default set is UserPromptSubmit, PostToolUse Grep, PostToolUse Bash and Stop. Export `MEX_HOOK_READ=1` or `MEX_HOOK_EDIT=1` to add Read or Edit|Write|MultiEdit, including the corresponding shell paths. Export `MEX_HOOK_PROMPT=0`, `MEX_HOOK_STOP=0`, `MEX_HOOK_SEARCH=0`, `MEX_HOOK_GREP=0` or `MEX_HOOK_BASH=0` to disable those paths. Search disables both Grep and shell search; Bash may remain for opted-in reads or edits. Rerun install after changing switches to update host matchers; the runtime also checks them for older installations. Read/edit require exactly `1`, so unset or `0` disables them. `MEX_HOOK_GRAPH=0` disables graph notes; `MEX_HOOK_GRAPH_IMPACT=1` separately enables impact notes on enabled edit paths. `MEX_HOOK_LEXICAL=1` forces lexical prompt ranking.

Install also replaces the managed `CLAUDE.md` block, preserving text outside its markers:

```text
<!-- mex-agent:hooks:start -->
MEX notes are curated project knowledge linked to code locations, not complete answers. Read the code when details matter. ⚠ means linked code changed: verify the note before relying on it. Do not open or edit `.mex` files by hand except as an edit note directs.
<!-- mex-agent:hooks:end -->
```

## Evaluation gate

- **Offline**: the frozen recipe must reproduce the evaluation's injections on the held-out set (parity), at under 0.2 s for read/edit/grep and under 1.5 s for prompt with the semantic extra.
- **Agent runs**: on Hono and TypeScript, fewer total tokens than the files arm and the files + sgrep arm, with equal correctness. Input and output tokens are reported separately, and every arm gets the same concise-answer instruction.

## Milestone 1 (implemented): composer and `mex context`

`src/context/` holds the composer; hooks, the light entry point and the other events are later milestones and attach to the seams noted below.

- **Commands**: `mex context index`, `mex context prompt "<text>" [--session <id>] [--lexical] [--explain] [--json]`, `mex context semantic install|status|remove`. The project root is the nearest ancestor with a real `.mex/` scaffold (`root.ts`), so they work from any subdirectory and from inside `.mex/`. The per-machine `~/.mex` is never taken for a project.
- **Index** (`.mex/local/context-index.json`): entities come from the Wiki parser (`parseWikiMarkdown`), graph rows from a read-only open of `.mex/graph.db`. It records the Markdown digests, a hash of the graph snapshot metadata and the alias overlay digest. Freshness is checked cheaply first (one stat per Markdown file plus the graph identity); bytes are hashed only when a file looks touched, and an identical digest keeps the index. `.mex/local/**` is never read as Wiki Markdown.
- **Aliases** come from each entity's `metadata.aliases`, plus an optional checkout-local overlay `.mex/local/context-aliases.json` (`{ "<entity id>": ["phrase", ...] }`) for tooling that must not edit tracked prose. This is the seam for authoring.
- **Recipe selection**: R3 when an embedder loads and the scaffold has candidates (facts or typed sections with a body), otherwise R2w. A failing model falls back to R2w with a `CONTEXT_SEMANTIC_FAILED` warning. Entry vectors are cached in the index by model id and document-text hash.
- **Gate decisions are reported** per candidate (`selected`, `below-floor`, `uncorroborated`, `low-cosine`, `weak-margin`, `below-ratio`, `already-shown`, ...) and as the abstention reason.
- **Session de-duplication** runs after the gate, so the frozen scores and margins are computed over the full candidate set; entries already shown are then dropped.
- **State writes** use the bounded helpers in `src/context/local-state.ts` for the index, session files (`.mex/local/context-sessions/`, bounded and pruned) and the managed semantic directory (`<MEX home>/semantic/`). The composer itself does not write files.
- **Parity**: `scripts/context-parity.mjs` replays the held-out question files through the built CLI and compares injected ids with the reference harness.
- **Reference details not ported**: the reference's second "code noise" stop list is consumed only by the segment channel, which the frozen recipes disable (`seg: 0`), so it never affected a result. The reference hard-coded one repository's name as a stop word; the port derives the project-name words per project (index field `projectWords`). The reference's term table was a plain object, so the query word "constructor" matched every document through the prototype chain; the port uses a `Map`.

## Milestone 2 (implemented): hooks

- **Entry point**: `mex-hook` (`dist/hook.js`, package `bin`) is its own bundle from `src/context/hook/entry.ts`. It never imports the CLI; tool events load only light modules (the graph is opened through `graph-reader.ts` rather than the graph's database module, the index file is read through `index-file.ts`), and the prompt handler, which needs the Markdown parser and the ranker, is a dynamic import. Read and edit have no default host matcher. A forced invocation of a disabled path exits at preflight; handled search, prompt and Stop paths still pay process startup. `scripts/benchmark-hook-runtime.mjs` measures those cold costs separately from composer work.
- **Dispatch and preflight** are by the payload (`hook_event_name`, `tool_name`). Before importing the runner, preflight rejects invalid or disabled events, empty or background-task prompts, empty searches and irrelevant shell calls. Opted-in reads resolve the root and check the context index and session memory for an unseen linked fact before opening the graph. A preflight rejection emits nothing and has no runner log. Handled events log duration, ids and text in `.mex/local/context-log.jsonl` (capped at 256 KB, newest half kept). Entry failures exit 0 silently; runner failures are logged when possible.
- **Dedup keys** share the session file: a bare id (text shown), `pointer:<id>` (prompt navigation only), `edit:<id>` (shown as touched by an edit, a different message) and `diff:<file>:<hash>` (this exact change was checked). A prompt that starts with `<task-notification>` is skipped.
- **read** (opt-in): resolved code links of at most 300 lines must overlap the range read (`offset`/`limit`, otherwise the file). Changed facts come first; at most two receive 200-character opening/tail excerpts, with a counted overflow pointer. Supported shell `sed`, `head`, `tail`, `cat` and `nl` reads use the same composer when enabled; tail ranges require the source length. Reads add no graph note.
- **edit/bash** (opt-in): `git diff -U0 HEAD --ignore-cr-at-eol` hunks are matched against resolved locations recorded for HEAD in `.mex/local/context-base.json`. Explicit body citations to `file:line[-line]` narrow the overlap. Broad symbol overlap can flag a fact for review but does not request a prose edit. At most three precisely cited claims get a title and pointer to the first body line, or `mex wiki show` if that line cannot be verified; an unseen claim also gets up to 400 body characters. Repeated claims omit the body. The instruction says to rewrite only if the claim may now be false, take no action if it is still true, and never edit entity blocks, ids or fingerprints. Conservative unresolved flags produce no edit request. A size-and-mtime signature lets an unchanged Bash call skip git.
- **grep**: line hits map to the enclosing symbol and an unseen fact grounded to that node; file-only hits can supply one linked fact per file. Groundings over 300 lines are excluded. At most two facts from five files fit in 1,200 characters, with 220-character opening/tail excerpts. Excerpts shrink to 140 source characters when available before a fact is dropped. Factless locations belong to the graph tier; grep adds no caller lists. The note labels locations and asks the agent to read bodies to verify.
- **See also**: read and grep may add at most one unseen title/id pointer per delivered fact when space permits. Evidence is an authored relationship, a shared grounding node, or a uniquely resolved referenced symbol enclosing recorded evidence. Shared prose alone is insufficient. These pointers carry no body and do not mark the neighbour as fully shown.
- **Session budget**: the injected characters per `session_id` are summed over all events (session file). Default 12,000, set with `context.sessionBudgetChars` in `.mex/config.json` (a positive integer up to 1,000,000; anything else means the default). After dedup, a packet that would push the total over the budget becomes one pointer per entry, `MEX: <title> applies (<health>) — mex wiki show <id>`, at most 120 characters; pointers count toward the total. From 1.5 times the budget nothing more is sent and the log says `budget-exhausted`.
- **Install**: `mex hooks install|status|remove --tool claude [--dry-run]` merges marked entries into `.claude/settings.json` (a command ending in `--mex-managed` is MEX's; nothing else is touched) and keeps a short block in `CLAUDE.md` under `mex-agent:hooks` markers, through the shared managed-block machinery (which gained a removal planner). The command is `mex-hook` when it resolves on PATH, otherwise `node "<abs>/dist/hook.js"`.

## Milestone 3 (implemented): stop, settle and batch reground

The rule, a product decision: after a session changes code MEX may refresh the graph, but it re-records (regrounds) **only** entities whose prose was edited in the session or that were confirmed with `mex context confirm <ids>`. Every other touched entity stays flagged "changed, re-check" in `.mex/local/context-flags.json`. Seeing a fact, or reading its code, never counts as confirmation: a complete-set claim (the Hono CORS headers) is touched by an edit that adds an item, and re-recording it would bless a claim that just became false.

- **Review** (`src/context/review.ts`): touched facts come from `git diff -U0 HEAD` against where each fact's code stood at HEAD (`findTouched`, shared with the edit event). An entity counts as *edited* when its title and body hash differs from the hash recorded in `context-base.json` for this HEAD (`prose`, written with the base locations at the first event); a hash of the prose rather than a diff of `.mex`, because MEX's own re-recording rewrites the entity block. It counts as *confirmed* by a session confirmation or by a flag a confirmation already made eligible. A change whose digest equals the one last re-recorded (`reconciled`) is not asked about again. Entities flagged by earlier sessions stay in view until vouched for.
- **Flags** (`context-flags.json`, `flags.ts`): `flagged` or `eligible` (with its basis), why, since, and the last re-record error. Packets and `mex context status` read it; `liveStateFrom` reports a flagged entity as `changed` even while the graph still says fresh.
- **`mex context confirm <id...> [--session <id>] [--note <text>]`** records the confirmation in the session file (the newest session when none is named) and makes an already-flagged entity eligible at once. Unknown ids are reported; none known is an error.
- **`mex context status`** lists flagged and eligible entities, their location and reason, whether a settle worker runs, and the last settle log entry.
- **Stop event**: reviews the session; flags every touched entity and logs the unvouched ones (`blocked: false`, `unvouched`); never blocks unless `MEX_HOOK_STOP_REVIEW=1`. With that opt-in, when `context.stopReview` is `ask` (default; `off` disables) and entities touched now are neither edited nor confirmed, it blocks **once per session** with a list of at most 1,500 characters (id, title, `.mex` location, why, and the exact `mex context confirm <ids> --session <id>` command; overflow is counted and left to `status`). It does not block while Claude Code reports the stop is already continuing from a block. Then it starts the settle worker, unless the review digest (each entity's code digest and what vouches for it) equals the one the session last settled. A block starts the worker too: a headless host may end the session without delivering it.
- **Settle worker** (`mex-hook settle --project <dir> --session <id>`, `hook/settle.ts`): started detached, `windowsHide`, retried on exit code 0xC0000142. A lock file (`context-settle.lock`, the worker's pid; a dead pid is taken over) allows one worker; a Stop while it runs leaves `context-settle.again` and the worker goes round once more (at most four passes). Each pass: review, flag, one `mex graph refresh` (on failure the exit code and the last 1,500 characters of stderr go to the log as `settle-refresh-failed` and nothing is re-recorded), batch `mex wiki reground <ids> --apply --json` for eligible ids only (chunks of 80), flags cleared and `reconciled` set for each success, the error kept on each failure, then update the context index if stale. Current indexes are reused. Each pass logs review, refresh, index and total timings as `settle` in `context-log.jsonl`.
- **Batch reground**: `mex wiki reground <id...> --apply` opens one fresh graph snapshot, runs the unchanged single-id service for each id (so every safety check holds per id), and reports a result per id; one refused entity never blocks or rolls back the others, and the exit status is nonzero when any failed. One id prints exactly as before.
- **Install**: `mex hooks install|status|remove` also manage a `Stop` entry; the short `CLAUDE.md` block explains notes and directs manual knowledge edits only when an edit note asks.

## Milestone 4 (implemented): authoring and fixes

- **Agents never copy fingerprints.** An agent writes a grounding as a node id. `wiki apply` (`create-entry`, `set-grounding`) derives the fingerprint and body hash from the live graph; a frontmatter `grounds_to` entry with only a node gets its fingerprint when baselines are captured (`captureGroundingBaselines`, which setup finalize, ground migration and sync completion share), in either the root or the `mex.grounds_to` store. The provenance rule is unchanged: a node the graph does not hold fails with `GROUNDING_UNVERIFIED` (wiki) or is counted as skipped, which fails setup finalization, and a supplied fingerprint must still equal the graph's. A file naming an unknown node is left untouched rather than half written. `adopt` still requires fingerprints, because it never consults the graph. Setup, ground-migration, sync-repair and upgrade prompts and the shipped templates stop instructing `scope --fingerprint`; the flag stays.
- **Aliases at authoring.** `create-entry` and `update-entry` take `aliases`, stored under `metadata.aliases`, the key the Wiki index and the context ranker already read. The key is also what topics use for alternative names, so there is no conflict, but the bounds apply to search phrases only: a topic's aliases are not limited. Bounds: an array of non-empty strings, trimmed and de-duplicated, at most 8 of at most 80 characters; a violation is rejected, not truncated, so the author sees the limit. Aliases stay optional (no validation diagnostic when absent), so older scaffolds are valid. The guidance (`ALIAS_AUTHORING_GUIDANCE`) names kinds of phrase (symptom, goal, plain-word synonyms, the mistake avoided), forbids restating the title or listing identifiers, and says phrases come from the fact's own content.
- **Upgrade review.** `mex wiki upgrade` no longer lists entities with a blank body (a file-level overview whose claims live in sections holds only the file's grounding), and its closing line counts what the pass reviewed and what remains beyond a bounded batch instead of re-listing candidates that were judged already focused.
- **Refresh mode.** `mex graph refresh` prints `Refresh: incremental|full (<reason>), N changed, M re-extracted.` or `Refresh: nothing changed.`; `--json` already carried `refresh`. The settle worker runs the refresh with `--json` and logs `mode`, `reason`, `changed`, `reextracted` in the `settle` entry.
- **Root resolution tests.** `graphReadRoot` and `rebaseGraphTarget` are exported and covered, plus spawned-CLI checks from a subdirectory.
- **Incremental references.** Before incremental publication, edges with endpoints outside the indexed corpus are dropped; a surviving source can retain an unresolved reference. Missing reference sources are dropped, missing targets are demoted, candidate lists are filtered and invalid import targets are cleared. Affected file records retain `INCREMENTAL_REFERENCE_OUTSIDE_CORPUS` diagnostics. Full-build validation stays strict. Compiler extraction stops visiting further projects once every source has an owner.
- **Not done here.** `maxSourceFileBytes` stays a constant; an issue is drafted separately.


## Graph tier (offline pilot replay, 2026-10-18)

Knowledge remains first. The light graph reader also supplies prepared, read-only
exact-name, enclosing-symbol, range, caller, callee and caller-count queries.
Call edges rank production paths before tests **before** applying their row limit;
this includes `testRunner` and `unittests`. Graph hints never index or refresh code.

Current rules (the pilot measurements below describe the earlier rules):

- **Prompt:** only after knowledge abstains. Verify code-shaped identifiers
  (camel case, snake case, or a bare name in backticks) by exact case-sensitive
  lookup. Send callable definitions only, with their indexed location; a prompt
  of more than 40 words may also name a class that spans at least five lines
  (see "Long prompts, second round" below). A name
  resolving to more than three declarations abstains. Plain prose, member calls
  such as `items.push(...)`, and task notifications provide no independent gate.
  Segment matches and unverified prose words do not trigger a note.
- **Grep/search:** require a verified identifier in the pattern and at most 60
  hits in five files. Resolve definitions within hit files; if none is there,
  a name with exactly one definition in the repository may name that definition
  outside those files. More than three scoped definitions get one counted
  summary instead of an arbitrary list. Inspect the first 12 hits for enclosing
  symbols. Filter callbacks, test paths and spans over 300 lines. No search
  caller lists; a trace/flow/chain pattern may add one unseen callee location.
  File-only or count output can identify a definition. Single-file
  `line:content` results use the explicit path. Bash uses the first search in
  supported compound commands and pipelines; mixed stdout attribution remains
  conservative and may be ambiguous.
- **Edit:** off by default (`MEX_HOOK_GRAPH_IMPACT=1` enables it on edit paths).
  Match base-side diff ranges to an enclosing indexed symbol, and send
  its other production callers to check. At most five files and 20 hunks per file;
  no note without a production caller. Multi-symbol hunks or locations that no
  longer enclose a complete hunk can abstain. Existing knowledge diff handling
  and Stop/settle rules remain unchanged.
- **Read:** no graph injection. The offline candidate required a range of at most
  200 lines inside one symbol and listed callers. It added no useful notes.
- **Caps:** 1,200 graph characters per event, three primary rows, at most 12 named
  node ids; impact can list three callers per symbol, search one callee in total. Graph
  lines are atomic; an oversized note is dropped. Knowledge and graph together
  remain under 4,000 event characters. Graph fits only in the remaining 12,000
  character session budget; it never displaces knowledge or becomes a pointer.
- **Memory/ablation:** every named graph node gets a `graph:<id>` session key,
  including callers. Undelivered nodes are not remembered. `MEX_HOOK_GRAPH=0`
  disables graph notes while retaining knowledge. Delivered graph notes log
  `kind: "graph"`, `graphNodes`, and `graphChars` separately from knowledge ids;
  `chars` remains the complete packet length. Existing event logs count silence.

### Replay method and limits

`scripts/context-graph-replay.mjs` calls the production event and graph composers,
not a second implementation. It copies each cache's database and context index
before opening them, joins transcript tool uses/results, and replays all 18 prompts,
61 Reads, 48 Greps, 70 Bash calls and 11 Edit/Write calls. All explicit edits had
structured patch ranges or an original file from which to recover their ranges.
Shell edits without transcript diff ranges are not synthesized. The source
checkouts, cache inputs and indexes are never maintained. No API, model or paid
sessions are used.

Existing arms retain their observed prompt knowledge gates, including semantic
abstentions, from the pilot logs. The files arm gets a lexical counterfactual
knowledge gate, using the harness's actual prompt builder (including JSON and
concise-answer suffixes). Tool knowledge uses the real composer on each copied base graph.
This preserves the base snapshot, not an exact replay of later graph refreshes;
source positions after repeated edits can differ. The pilot never triggered settle.

A useful note names an unopened gold file/symbol **or verified definition location**
that appears in a later Read/search. Read ranges determine whether a symbol was
opened; reading another part of the same file does not open every symbol. Noise
has neither a gold target nor any later use. The remaining notes are neutral
(often a gold target already read). The detailed JSON records both gold usefulness
and definition usefulness, node locations, opened status and the first later use.
`Lead` is the largest number of intervening tool calls for one eligible target in
a session. It is a navigation opportunity, not measured causal turns saved; leads
are not summed because their intervals overlap. Same-tool hits do not count as a
future use.

The wider 60-hit/five-file gate recovered useful notes without adding noise versus
30/three or 10/two. Callable-only prompt hints and excluding one-line declarations
removed option-property and enum-member noise. Bare member calls were rejected:
`items.push(...)` otherwise resolved to an unrelated indexed `push` function.
The Read candidate added only neutral/noise output, so silence remains the default.
All tuning used these same sessions; this is development evidence, not a held-out
quality estimate.

| Task | Arm | Useful | Noise | Neutral | Graph chars | Total chars | Lead |
|---|---|---:|---:|---:|---:|---:|---:|
| error-convention | files | 0 | 0 | 0 | 0 | 1035 | 0 |
| error-convention | mex-r2w | 0 | 0 | 1 | 387 | 2461 | 0 |
| error-convention | mex-r3 | 0 | 0 | 0 | 0 | 1192 | 0 |
| lambda-edge-binary | files | 1 | 0 | 0 | 360 | 2346 | 2 |
| lambda-edge-binary | mex-r2w | 1 | 0 | 0 | 308 | 2404 | 1 |
| lambda-edge-binary | mex-r3 | 2 | 0 | 0 | 332 | 1481 | 1 |
| ts-evolving-array-type | files | 1 | 0 | 0 | 438 | 5491 | 1 |
| ts-evolving-array-type | mex-r2w | 2 | 0 | 0 | 1170 | 6194 | 3 |
| ts-evolving-array-type | mex-r3 | 2 | 0 | 0 | 741 | 6755 | 3 |
| ts-change-refproj-default-import | files | 3 | 0 | 0 | 1694 | 2829 | 21 |
| ts-change-refproj-default-import | mex-r2w | 3 | 0 | 1 | 1995 | 3989 | 3 |
| ts-change-refproj-default-import | mex-r3 | 1 | 1 | 1 | 1138 | 1898 | 2 |
| dj-view-exception-to-response | files | 2 | 0 | 0 | 551 | 2503 | 2 |
| dj-view-exception-to-response | mex-r2w | 2 | 0 | 0 | 663 | 3026 | 1 |
| dj-view-exception-to-response | mex-r3 | 1 | 0 | 0 | 378 | 3770 | 0 |
| dj-change-exclude-in-none | files | 0 | 1 | 0 | 92 | 1017 | 0 |
| dj-change-exclude-in-none | mex-r2w | 0 | 0 | 1 | 269 | 1194 | 0 |
| dj-change-exclude-in-none | mex-r3 | 0 | 0 | 1 | 269 | 269 | 0 |

TypeScript freshness investigation: both task caches use scaffold commit
`125ebae0970d`, whose source history is based at `968d5deb8b5`. Task bases are
`b465fdbfe175` (question) and `114327939c93` (change). The former has 106 fresh,
22 changed and eight missing facts; the latter has 110 fresh, 19 changed and seven
missing, before the agent edits anything. These are actual stored-versus-current
body-hash mismatches, not commit-id inequality or a cached health verdict. For
example, `bindInStrictMode` changed from `getStrictOptionValue(opts, "alwaysStrict")`
to `getAlwaysStrict(opts)` between scaffold source and task base; its grounding
hash is `c7e7a558...` while the question graph records `e186e67d...`. The old prose
still names the old helper. The label is correct; no product freshness change or
automatic regrounding is warranted.

Across the selected replay: **21 useful, two noise, five neutral**, 10,785 graph
characters. Eighteen useful notes reach gold targets; three reach other verified
definitions later used. Files: 7 useful / 1 noise / 3,135 graph chars; lexical:
8 / 0 / 4,792; semantic: 6 / 1 / 2,858. The 30-hit/three-file cap gives
14 useful / 2 noise / 8,201 chars; 10-hit/two-file gives 10 / 2 / 5,701.
Enabling the Read candidate gives 21 useful / 3 noise / 15 neutral / 13,379 chars:
zero additional useful notes, 2,594 additional characters. The two remaining
noise notes concern an emit-format helper (semantic bug-fix session) and a class
definition from a Django search (files session). Caller trails are structural,
not proof that a caller needs changing.

### Latency and verification

An isolated warm full-runner replay (one warmup then three timed invocations per
Read/Grep payload, copied graph/index, no session dedup) measured:

| Path | Samples | p50 ms | p95 ms | Max ms |
|---|---:|---:|---:|---:|
| Read runner | 183 | 12.3 | 17.1 | 20.5 |
| Grep runner | 144 | 12.9 | 62.6 | 84.0 |
| Read composer | 61 | 1.0 | 2.8 | 4.7 |
| Grep composer | 48 | 2.2 | 42.7 | 57.2 |

Runner timing includes index load, graph open, selection and bounded log writes;
process startup is excluded. A preliminary run concurrent with typecheck had
scheduling outliers up to 1.7 seconds, including Read where graph injection is
disabled; it is retained in scratch evidence and is not used as the warm budget
estimate. Repeat with `--warm-latency --label isolated` on an otherwise idle machine.

The context suite passes 164 tests. Typecheck passes. The normal build command is
blocked in this checkout by sandbox ancestor-directory traversal in the config
bundler; the same source/configuration builds in an isolated scratch copy with
local workspace-package links. Git staging is blocked by `.git/index.lock`
permissions, so implementation, tests and evidence remain uncommitted. No push.

Final checks also passed 14 rebuilt-entry, graph-delivery and budget tests after
copying the successful scratch build into ignored `dist/`; emitted public
`index.d.ts` is byte-for-byte unchanged. `MEX_HOOK_GRAPH=0` replay sends zero
graph notes/chars while retaining 39,043 knowledge characters over the sessions.

## Long prompts, second round (2026-10-18)

Task prompts of 100 to 300 words reach the gate with the relevant entry near the
top, but a long prompt shares a few words with almost every entry, so the leader
rarely clears the lead over the fourth candidate. This round measured fixes for
that, with prompts of 40 words or fewer left untouched.

### New labelled set

54 new prompts, 18 per project (Hono, TypeScript, Django): 36 with a gold entry
from the scaffold knowledge (a few accept a second, equally relevant entry) and
18 on topics no entry covers, many of them sharing vocabulary with entries.
They are bug reports, trace requests and change requests of 54 to 378 words:
41-100 words (21), 101-200 (18), 201-300 (9) and 300+ (6). None is taken from or
paraphrases the agent-run task prompts. Split dev/test by alternation within
project, length and kind. Run with `scripts/context-rank-eval.mjs` (same file
format as the earlier sets).

### Baseline (unchanged by this round)

Helped/with-fact, injections carrying gold/injections, false sends/no-fact; gate
computed in-process by the product's own functions on copies of the pilot index
caches (identical ids to the CLI on every prompt).

| Bucket | R2w dev | R2w test | R3 dev | R3 test |
|---|---|---|---|---|
| New 41-100 | 3/6, 3/4, 1/3 | 6/8, 6/7, 0/4 | 5/6, 5/7, 1/3 | 7/8, 7/7, 0/4 |
| New 101-200 | 5/6, 5/6, 0/3 | 4/7, 4/4, 0/2 | 3/6, 3/3, 0/3 | 6/7, 6/6, 0/2 |
| New 201-300 | 1/4, 1/1, 0/2 | 2/2, 2/2, 0/1 | 3/4, 4/5, 1/2 | 1/2, 1/1, 0/1 |
| New 300+ | 1/2, 1/1, 0/1 | 1/1, 1/1, 0/2 | 1/2, 1/1, 0/1 | 1/1, 1/1, 0/2 |
| Old medium (60-96) | 14/24, 14/16, 0/12 | 15/24, 15/17, 0/10 | 16/24, 16/20, 1/12 | 17/24, 17/21, 0/10 |
| Old very long (305-1,500) | 10/24, 10/15, 3/12 | 11/24, 11/25, 4/10 | 11/24, 11/14, 1/12 | 12/24, 12/26, 4/10 |

On dev, the gold entry is the top-ranked candidate in 48 of 68 long with-fact
prompts (lexical order), but only 34 (R2w) and 39 (R3) are sent: the ranking is
mostly right and the lead rule is what holds recall back.

### Methods measured on dev (long prompts: helped/66, gold/injections, false sends/33)

| Method | R2w | R3 |
|---|---|---|
| Current gate | 34, 34/43, 4 | 39, 40/50, 4 |
| Lead measured inside the leader's best window | 45, 46/77, 12 | 44, 45/71, 8 |
| Same, plus candidates sharing a code file with the leader not counted as competitors | 48, 49/82, 12 | 46, 47/76, 8 |
| Sharing a code file not counted as competition (global lead) | 34, 34/46, 5 | 42, 43/58, 4 |
| Lead on the sum of the two best windows (0.35 / 0.45) | 39, 39/60, 10 / 32, 32/40, 4 | 46, 47/69, 8 / 44, 45/61, 7 |
| Rare-term weighting (idf squared), current thresholds | 27, 27/38, 6 | 33, 33/41, 4 |
| A prose word equal to a linked symbol name as identifier evidence | 33-34, no gain | 38-39, no gain |
| Lexical score times (cosine − 0.4) as the order and lead (R3) | — | best 49, 49/78, 11 |
| Title evidence (frozen below) | 37, 37/46, 4 | 40, 41/51, 4 |

A grid over floor (0.25-0.5), lead (0.2-0.6), corroboration (3-5), idf exponent
(1, 1.5, 2) and lead reference (global or in-window), and a second, stricter
path for an in-window leader (floor, corroboration, lead, code-linked leader,
cosine floor or top cosine, topic present in at least two windows, near-tied
same-code competitor, sent alone) found no setting that raised helped without
raising false sends or wrong injections, except the title-evidence path.

### Title evidence: frozen on dev, tested once, not adopted

Rule: in a windowed prompt, a first candidate that passes the floor and
corroboration but fails only the lead over the fourth candidate is still sent,
alone, when its best window holds at least 3 distinct words of its title and it
leads every other candidate inside that window by at least 0.3 of its own score;
the semantic recipe also requires that no candidate in the gate list has a
higher cosine.

| | R2w dev | R2w test | R3 dev | R3 test |
|---|---|---|---|---|
| Long prompts, current | 34, 34/43, 4 | 39, 39/56, 4 | 39, 40/50, 4 | 44, 44/62, 4 |
| Long prompts, title evidence | 37, 37/46, 4 | 39, 39/56, 4 | 40, 41/51, 4 | 45, 45/64, 5 |

On test the lexical recipe is unchanged and the semantic recipe gains one entry
(new set, 101-200 words) and one send on a very long no-fact prompt; that send
matches only the unrelated pasted paragraph (an answer to the other question in
the prompt). On the 33 agent-run prompts (in-process, the hook's ranking) it adds four
lexical sends: two exactly relevant (evolving array types; middleware converts
exceptions to responses), one partial (never-returning calls, for a dead-code
trace) and one unrelated (package.json exports, for a default-import bug). The
acceptance rule was no rise in false sends in any bucket and higher recall on
long prompts for both recipes, so the rule is not shipped.

### Graph tier: classes in long prompts (shipped)

The prompt note named callables only, so a bug report naming `ExpressionWrapper`
and `RawSQL` got no note. A prompt of more than 40 words may now also name a
class, when the class spans at least five lines (`GRAPH_MIN_CLASS_LINES`;
shorter classes are markers such as exception subclasses, and two of those were
the only new noise on the first replay). Prompts of 40 words or fewer keep the
callable-only rule.

- Pilot replay (18 sessions): noise unchanged (2), useful 21 → 22 (a field class
  later opened in a semantic-arm session), no other change.
- The 33 agent-run prompts through the built hook, both recipes: 10 of 66
  outputs change, all graph notes on prompts where knowledge abstains: the
  SmartRouter, RegExpRouter and TrieRouter classes (router decision, gold
  SmartRouter), UniqueConstraint (gold `UniqueConstraint.validate`, both
  recipes), EmailMessage (gold `EmailMessage.send`, both), FilteredRelation
  (alias bug; gold is in the query compiler, partial, both), the BooleanField
  classes and ExpressionWrapper (SQLite literal bug, next to the gold
  `NegatedExpression.as_sql`, partial, lexical) and the CharField classes
  (exclude bug, neutral, semantic). No unrelated note.

### Parity

`scripts/context-window-parity.mjs` against a build of the previous head: 65 of
65 prompts of at most 40 words identical, and all 59 longer prompts of the
evaluation sets and the new set identical (knowledge is unchanged). Through the
hook entry point, all 130 outputs (65 prompts, both recipes) of at most 40 words
are byte-identical. The context suite passes 166 tests.

### Graph-anchored evidence: measured, not shipped (2026-10-18)

Rule tried: in a windowed prompt, a leader that passes the floor and
corroboration but fails only the lead is sent alone when an identifier in the
prompt's prose resolves to a graph node (as the graph identifier tier resolves
it, classes allowed) and the leader is grounded to that node, its file, or a
caller or callee of it. Dev, long prompts: R2w 34 → 36 of 66 (both gold, no new
false send) at file or neighbour level, nothing at node level; R3 unchanged at
39. Test, once (file level): no change in any bucket for either recipe. The 33
agent-run prompts: three new sends, two relevant (the router fallback fact for
the router decision, both recipes) and one unrelated (QuerySet result caching
for the FilteredRelation alias bug). Long prompts rarely name a code identifier:
the gold entry is graph-reached in 8 of 68 long dev prompts. Short of the bar
(recall up on long prompts for both recipes, no new false sends), so not shipped.

## Pilot fixes (2026-10-18)

From the seven-session pilot (Django and Hono heavy tasks):

- **Line ends.** Agents edit through Python scripts, whose text mode writes CRLF on
  Windows into LF checkouts. Every such file was one whole-file hunk, so every fact
  linked to it read as touched (the Stop block listed facts nobody had edited) and
  no edit fitted inside a symbol. The edit, Bash and Stop diffs now pass
  `--ignore-cr-at-eol`; a CRLF-only rewrite is no change.
- **Impact notes after a search.** An edited symbol that a search note had already
  named (as a hit or as a caller) got no impact note, because impact shared the
  location notes' `graph:<id>` memory. Impact now remembers `impact:<id>`, once per
  edited symbol, and lists callers the session has seen. A silent edit or Bash
  check logs `nothing-touched` or `no-change`.
- **Impact notes for shell edits.** The pilot agents mostly edited through Python
  scripts run in Bash, which no Edit hook sees. A Bash command that may write
  (anything but read-only programs, `sed` without `-i`, `find` without
  `-exec/-delete`, no `>` into a file) and names project files (arguments, inline
  scripts, `cd` targets) gets one diff of those files, started before the graph
  opens. Hunks not seen before (ids of their removed and added lines, seeded at the
  first prompt and recorded by Edit and Bash events) go to the same impact
  composer, with the same caps, `impact:<id>` memory and budget, when at most five
  files changed. Warm in-process time on Django and Hono: read-only or unnamed
  commands 25-27 ms as before, writing commands that name a file 91-101 ms. A
  whole-tree diff would cost about 200 ms on Django, so a command that names no
  file gets no note. Prompts of at most 40 words: 130 of 130 outputs
  byte-identical; the 66 agent-run prompt outputs are unchanged.
- **Blocks the host never delivers.** A headless session ends at the agent's
  structured answer, so a Stop block raised after it never reached the agent and,
  as the worker started only on a later Stop, nothing settled. The block now starts
  the worker as well; a confirmation afterwards changes the review digest and runs
  it again.
- **Refused regrounds are explained in the log.** The settle entry lists each
  refused id with its first reason (`reground.refused`). In the pilot that was a
  fact whose PostgreSQL and SQLite links name `minimum_database_version` variable
  nodes minted from the values at scaffold time; the task base has other values,
  so the ids do not exist there and the fact's "missing" label and the refusal are
  both correct. Variables this small carry no neighbours, so reconciliation cannot
  rebind them; the fact needs relinking by a person.
