# Internal artifact v1

Start with [example.json](example.json), replacing every fixture claim with evidence for the actual subject. Leave `diagram.mermaid` empty and run `node <skill-dir>/scripts/runtime.mjs normalize /scratch/draft.json /scratch/artifact.json`: it writes the exact Mermaid projection of your states and transitions and validates the result. `validate` checks an artifact without changing it. The normative private Zod contract ships in the bundled helper and lives in `packages/hub-contracts/src/statechart.ts` in MEX source. It is not a public package API.

Exact shapes (objects are strict: unknown keys are rejected). Every id matches `^[A-Za-z][A-Za-z0-9_]{0,63}$` (no hyphens or dots); a state id must not be a Mermaid keyword such as `state`, `end`, `note`, `choice`, `fork` or `join`.

```text
states:      { id, label, evidence: [ids], parent?, region? }
transitions: { id, from, to, event, condition, evidence: [ids], rules: [ids] }
rules:       { id, label, kind, provenance, evidence: [ids] }
evidence:    { id, path, line?, sha256 | null, kind, explains: [ids], note }
mapping:     { model, targets: [ids], evidence: [ids] }
files:       { name, content }   name: ^[A-Za-z][A-Za-z0-9_-]{0,63}\.(tla|cfg|json|mmd|txt|md)$
diagram:     { validity, mermaid }
check:       { outcome, bounds, results: [{ rule, outcome, detail }], modelStates, modelTransitions }
traces:      { id, rule, kind, steps: [{ state, transition? }], raw, loopTo? }
reproduction:{ outcome, detail, evidence: [ids] }
toolchain:   { upstream, tlc, java, renderer, regeneration }
```

Required fields:

- `schemaVersion: 1`, title, summary, scope, subject, reader, classification (`implemented`, `proposed`, `agreed-model`), createdAt (UTC ISO).
- `states`: stable ASCII ids, human labels, evidence ids; optional parent composite and independent region id. `initial`: state ids.
- `transitions`: stable id, from/to state ids, readable event, condition, evidence ids and rule ids.
- `rules`: id (the TLA+ predicate name), readable label, kind (`invariant`, `temporal`, `goal`), provenance, evidence ids. Retain source/conflict provenance instead of silently replacing a rule.
- `evidence`: id, repository-relative path, optional line, SHA-256 of exact file bytes or null, kind (`code`, `test`, `knowledge`, `history`, `requirement`), `explains` behavior ids, specific note. Every retained context item must explain behavior. Never invent hashes; oversized/unavailable dependencies stay unverified.
- `mapping`: model variable/action/guard description, target behavior ids and source evidence ids. Without complete state/transition source mapping the Hub says alignment unverified, regardless of TLC success. Source mapping is not a conformance proof.
- `files`: bounded named TLA+, cfg, JSON, mmd, txt or Markdown inputs/results. First `.tla` is the model checked with its same-stem authored `.cfg`. Preserve originals and reference configs; do not weaken them. Reserved companion names: record.md and diagram.mmd. Include unchanged reference, fixed model and upstream machine-readable summaries as needed within the limits. Retain any executable upstream mapping source as inert `Mapping.txt`; no scripts execute when viewed.
- Optional `Projection.json` companion: pure data mapping TLC states to graph ids, `{ "states": [{ "state": "ready", "values": { "pc": 0 } }], "actions": { "Start": "start" } }`. An action may map to a list of transition ids when it has multiple source/destination pairs. Each valuation and each projected transition must have exactly one match. This deterministic projection verifies the normalized graph and constructs ordered finite traces; missing/partial projection leaves diagram validity unverified even if TLC passes. Internal/stuttering projection steps must be disclosed as omissions. For complicated/nested models, retain the baseline mapping and summaries as data and disclose projection limitations.
- `diagram`: validity (`valid`, `unverified`, `invalid`) and deterministic Mermaid derived from the normalized graph. Use the example's closed syntax: `stateDiagram-v2`, state aliases, composite braces, `--` independent regions, initial arrows and labeled transitions. No front matter, arbitrary directives, HTML, scripts or link commands. Labels exclude quotes, control characters, angle brackets, backticks, braces and backslashes. Each state/transition label stays below 180 characters; conditions and implementation details stay in inspection.
- `check`: outcome (`passed`, `violated`, `goal-reached`, `incomplete`, `cancelled`, `unavailable`, `resource-limited`), bounds, per-rule results and checker runtime counts or null. Initialize as incomplete, then run `check`. Do not convert partial/incomplete execution to success. TLC checking is distinct from implementation verification and graph projection.
- `traces`: stable id, rule id, kind (`counterexample`, `temporal`, `goal`), steps (state id; each subsequent finite step includes transition id), full bounded raw trace, optional loopTo. Unprojectable/temporal traces retain raw output even without a finite chart path. Explicitly map and review path order before handoff. A goal witness is never a bug.
- `reproduction`: outcome (`reproduced`, `not-reproduced`, `partial`, `not-attempted`, `not-applicable`), detail and evidence ids. Retain observable entry point/tests, what they establish and limits.
- `omissions`, `toolchain` (upstream, tlc, java, renderer, regeneration instruction as inert text). Do not retain the agent conversation, private prompts or raw unbounded tool history.

`terminal` projects the same states, transitions, conditions, rules and path numbering. Deliver with `show` as SKILL.md step 7 describes for the client. PNG export QA uses the attributed workflow. Register copies only validated artifact data to `.mex/local/diagrams/<opaque id>` (24h TTL, up to 20 previews). Retain its returned route and offer to open that specific preview in Hub; follow [Opening the preview in Hub](toolchain.md#opening-the-preview-in-hub). Generation alone does not launch Hub. Hub Save shows exact portable working-tree writes in `.mex/diagrams/<new id>`, creates an immutable bundle, and never stages/commits/pushes. `record.md` is the canonical metadata/baseline owner; companions are retained inputs. Opening never executes any file or regeneration instruction. Old results remain visible when Java/indexes are unavailable; freshness is separate from the recorded check.
