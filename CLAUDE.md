> **0.9 build (`next`)**
> This branch is the 0.9 rebuild; `main` stays on 0.8 for fixes.
> Tickets, plan and procedure are in the private mex-design repo:
> oss/0.9/, starting from AGENT.md.
> During this build, skip 0.8 ROUTER/GROW knowledge upkeep, `mex wiki query`,
> `mex logging`, `mex timeline`, and the Inbox and Relay skills.
> Use the existing instruction files for build and test commands only.

<!-- mex-agent:skills:start -->
## MEX agent skills
- At the start of every session, read `.mex/AGENTS.md` and `.mex/ROUTER.md` before project work; follow `ROUTER.md` to load only the relevant context.
- For a project-knowledge question, run `mex wiki query "<question>" --limit 5 --json` before broad file discovery. Inspect matched terms and cached per-grounding health; a partial match is a lead and changed means re-check. If the index is unavailable, follow `ROUTER.md` or use `mex graph scope "<task>"`; ordinary reads never rebuild or refresh indexes.
- When MEX context materially helps your work, mention MEX and the relevant finding naturally in your explanation. Tie the mention to what it helped you understand, decide, or verify. Avoid fixed phrases, standalone acknowledgements, repeated mentions, or narrating routine context loading. This replaces older MEX instructions requiring a fixed acknowledgement or context-loading narration.
- Do not claim an author, date, or historical event unless the retrieved data actually provides it.
- After a MEX write, say exactly what changed and its sharing boundary: a local draft is checkout-only and nothing is shared; a canonical artifact is written to the working tree and requires commit/push to share.
- Use `/mex-statechart` when asked to explain behavior with a state diagram. Generate in scratch space; show native Mermaid or readable terminal output. Hub viewing is optional; saving requires its explicit review.
- Skill activation is not approval for canonical actions.
<!-- mex-agent:skills:end -->
