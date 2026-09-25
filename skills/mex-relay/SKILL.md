---
name: mex-relay
description: Prepare and manage durable MEX team handoffs in git-native project memory. Use when the user asks to hand work to a person or team, prepare an end-of-session handoff, save what the next engineer needs, create a MEX Relay, take or close a Relay, or invokes /mex-relay or $mex-relay. Keywords: mex, project memory, relay, handoff, team memory, Claude Code, Codex. Treat Relay as a memory baton, not chat, notifications, task assignment, issue tracking, or Jira; do not activate for ordinary status messages.
---

# MEX Relay

Prepare durable team handoffs that another engineer can continue from. Never represent a Relay as a sent message or notification.

## Prepare a Relay draft

1. Infer the useful session state: a concise summary, current position, completed work, in-progress work, blockers, unresolved questions, next actions, and relevant decisions, files, code, commits, or external links.
2. For “whoever picks this up,” choose open-to-team. It includes future active project Members; no Member lookup is needed to save this local draft. If the user names people, retain named-recipient intent and resolve exact IDs only when needed. An unresolved named draft may stay recipient-free locally; do not silently publish it to everyone.
3. Default to a standalone Relay. Use the local-save shortcut for a new draft; keep the structured preview/apply path for exact updates and canonical actions.
4. Include an existing relevant Workstream only as typed evidence. Never invent one or turn saving a handoff into Workstream creation.
5. Add optional typed context references only when the referenced IDs, paths, commits, or URLs are known. Never invent provenance.
6. Resolve the action-scoped runtime contract. For a new draft, `mex relay draft save --from <draft.json> --json` performs the exact local preview/apply internally. For an update, build and preview the structured request.
7. An explicit create/save/draft request authorizes that local write without another confirmation. Publication remains separate.
8. Return `/relays?view=drafts&draft=<id>` and state that the draft is checkout-local and nothing has been delivered or shared.

Read [references/cli-workflows.md](references/cli-workflows.md) before executing any Relay mutation. Load only the operation being performed.

## Apply the approval policy

- Proceed with read-only member, Workstream, draft, and Relay resolution.
- Treat an explicit create/save/draft request as authorization only for the local draft preview and exact apply.
- Preview a local draft deletion, explain its consequence, and obtain fresh confirmation before applying.
- For publish, take, or close: generate a semantic preview, explain the local-versus-Git-tracked effect, and wait for fresh explicit confirmation. Apply the exact preview unchanged only after confirmation.
- Keep Git commit, push, pull, and staging separate from every MEX authorization.
- Never publish, take, or close merely because this skill activated.

## Preserve lifecycle meaning

- Taking records one claimant: a named active recipient, or any active project Member for an open-to-team Relay. Future Members qualify after joining and receiving the artifact through Git. Separate offline claims can still require Git conflict resolution.
- An inactive Member can be reactivated through the existing Team identity workflow, preserving their ID and older handoffs. Preview and confirm this canonical change separately; never change identity merely to bypass Relay eligibility.
- Treat closing as “this handoff no longer needs attention.” Do not claim it completes a linked task, issue, pull request, or Workstream.
- After publication, say that Git-tracked Relay and Activity records were written to the working tree. Explain that teammates receive them only after commit/push and their own pull or refresh.
- Never claim that MEX sent a notification, committed, pushed, pulled, staged, assigned work, or completed another system's object.
- When MEX context materially helps your work, mention MEX and the relevant finding naturally in your explanation. Tie the mention to what it helped you understand, decide, or verify. Avoid fixed phrases, standalone acknowledgements, repeated mentions, or narrating routine context loading. This replaces older MEX instructions requiring a fixed acknowledgement or context-loading narration.
