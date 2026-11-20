# Compatibility

## Unreleased dependency claim metadata

`Claim`, exported from the package root, gains optional `ecosystem: "npm" |
"python"` evidence for dependency and version claims. Existing callers can omit
it. Extraction records explicit ecosystem headings (including enclosing
headings) and scoped npm package names; mixed or unlabelled prose stays
ambiguous. Checking distinguishes the named ecosystems, so unread Python
manifests do not suppress identified npm claims. An unlabelled missing name
still abstains when Python manifests are unread.

Heading evidence uses whole ecosystem labels plus neutral dependency terms,
for example `JavaScript Dependencies` or `Python` above `Key Libraries`.
Bare `Node`, mixed-language headings, and unknown qualifiers clear inherited
evidence; `Node.js` and `NodeJS` identify npm. When both npm and Python version
claims exist for a name, an unlabelled version can match either candidate. A
version matching neither remains a cross-file conflict.

This is an additive change to the package-root API. No version bump is made here.

## MEX 0.9.0-beta.1

This is a pre-release on npm's `next` tag. MEX 0.8.5 stays on `latest`.
The beta rebuilds setup, notes, checks, sharing and agent hooks. The rebuilt Hub
arrives in 0.9.0; a 0.9 checkout does not start the 0.8 Hub.

## Runtime and operating systems

- Node 22.5 or later, with the built-in `node:sqlite` module.
- Windows, macOS and Linux.
- Native hook packages are selected for the platform. If the native binary is
  unavailable, installation reports the Node fallback.
- `mex status` reads installation state and runs the native binary's self-test.
  `mex doctor` adds a fix for each recorded problem.

### Tested agent versions

| Agent | Version used for beta.1 qualification |
| --- | --- |
| Claude Code | 2.1.326 (live sessions on Windows 11, 17 Nov 2026) |
| Codex | 0.165 (live sessions on Windows 11, 17 Nov 2026) |

Claude Code and Codex are the supported agents in beta.1. More agents are planned
for 0.9.0. In Codex, review and trust MEX's hooks once: `/hooks` in the CLI, or **Review hooks** beside the message box in the app. Until then Codex skips them.
A note saved with `mex note` reached a new session on both agents (6 of 6 on each), and a note the code had made false was held back on both. See `docs/design/0.9.0-release-plan.md`.

## Install and undo

```sh
npm i -g mex-agent@next
cd your-repo && mex
```

Hooks are installed in user settings. Bare `mex` does not add tracked files,
run repo commands or make a model call for the first screen. Learning from what you type is off until you turn it
on (`mex config set learning.statements on`); it then uses the installed agent's
smallest model on your plan, at most 3% of your usage. `mex capture off` stops capture here.

`mex off` stops MEX in this repo. `mex uninstall` restores the changes MEX
recorded and keeps notes. `mex uninstall --purge` also removes the notes.
Locally changed installation files are reported for review rather than overwritten.

## Notes, checks and sharing

Notes without recorded checks are unknown. A failed complete check holds a note
back. A changed supporting check can send a pointer to current code. Status
reads cached verdicts; `mex check` runs the checks.

`mex share` previews a new share branch. Follow the printed `--apply --expect`
command after review. Nothing is pushed without `--pr`. Teammates receive the
reviewed notes and agent rule files through git; databases remain local.

## Upgrading from 0.8

Run `mex upgrade` in the old repo for a preview. Apply only the exact revision
printed by that preview. Review its tracked branch before sharing.
Existing 0.8 pages remain readable with `mex hub` while `.mex/ROUTER.md` exists.
`mex doctor --legacy` runs the old diagnostic.

## Package and API scope

The CLI is the supported beta entry point. Package-root exports remain limited
to the APIs exported by `src/index.ts`; internal modules are not a stable API.
Do not share local databases or runtime files through git.

Next: run `mex status` after installation. Use `mex doctor` if a part is unknown.
