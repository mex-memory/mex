# mex 0.8.2 — Set up in the Hub

MEX setup now starts in your local browser. The terminal setup remains available.

## Setup

```bash
npx mex-agent@0.8.2 setup
```

- Choose integrations, follow agent population, review the setup-file diff, and explicitly commit it locally in one flow. A manual Git checkpoint remains available.
- If an agent fails, retry it or copy the retained prompt and continue after manual population. Integration pointer notes are advisory and do not block setup.
- After the commit, a completion guide explains how to start a fresh agent session and verify its project knowledge. Choose **Open Hub** to enter the full dashboard and its first-run tour.
- Optionally install `mex` globally at the exact version running setup. Installation has progress, verification, retry, skip, and a copyable terminal command. Failure leaves setup complete.
- Optionally leave an email and a name for follow-up about MEX. Name is optional; email is required only when submitting. The embedded Web3Forms service handles delivery. Contact details stay out of repository files and usage telemetry; only a submitted/skipped preference is stored on the computer and shared with Overview's invitation.

Use `mex setup --cli` for the terminal flow and `mex setup --dry-run` for a read-only terminal preview. `--no-open` prints the browser link; `--port <n>` chooses a loopback port. Bare `mex` opens Hub or setup, and `mex tui` keeps the terminal dashboard.

## Also included

- A first-run Hub tour highlights the actual navigation once per checkout; Settings can replay it.
- Overview links directly to Context when its Wiki index is fresh, and to Health when maintenance is needed.
- Next.js App Router HTTP handlers become route nodes in the Code Graph.
- Sync moves inline grounding anchors together with their matching frontmatter entries, preserving the link to moved code.

## Upgrade

```bash
npm install -g mex-agent@0.8.2
mex skills sync --dry-run
mex skills sync
```

Review integration conflicts and start a fresh agent session. Completed 0.8.0/0.8.1 projects do not need setup again just to upgrade. Automation that expects terminal prompts must now use `setup --cli`.

Node.js 22.5 or newer with SQLite FTS5 is required. Package-root exports and Graph/Wiki/Relay storage formats are unchanged. MEX never pushes or pulls; a setup commit is created only from the reviewed Hub action.
