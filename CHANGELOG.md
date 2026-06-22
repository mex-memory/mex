# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Fixed
- **checkBrokenLinks false positives from HTML comments** — `checkBrokenLinks` now skips links inside HTML comments (`<!-- ... -->`), both single-line and multi-line. Previously, template examples in comments (e.g., in `patterns/INDEX.md`) were flagged as broken links.
- **checkPaths false positives** — `checkPaths` now only validates inline code paths from `ROUTER.md`, not all scaffold files. Eliminates false `MISSING_PATH` errors from context docs, pattern files, and tool config files where backtick-wrapped strings are config values, IPs, annotation keys, or other non-path content. [#79](https://github.com/theDakshJaitly/mex/issues/79)

## [0.6.1] - 2026-06-14

### Added
- **Event log provenance/lifecycle fields** — `EventEntry` now accepts two optional, free-form string fields: `source` (where an event came from, e.g. `meeting`, `manual`, `agent`) and `status` (decision lifecycle, e.g. `decided`, `implemented`). Both are written only when provided and are preserved by `mex timeline` (including `--json`). `kind` stays a closed enum; `status` is deliberately ungated so unrecognized values are never dropped. Exposed via `appendEvent` (the in-process API) and optional `mex log --source`/`--status` flags. Entries without these fields are unchanged.

## [0.6.0] - 2026-06-09

### Added
- **Feedback command** — `mex feedback` opens a hosted form for users to opt in to maintainer user-research calls. A quiet, dismissible one-line invite appears after a successful `check`/`sync` and in the `mex` TUI (TTY-only, shown a few times then stops). The CLI never reads or transmits an email — it only opens the URL. Hide it with `mex config set feedback off`. Kept fully separate from telemetry.
- **Anonymous telemetry** — opt-out usage counting via PostHog. Each command sends one event with only `machine_id`, `scaffold_id`, `command` name, `mex_version`, `os`, and `node_version` — no args, paths, file contents, repo names, IP, or location. Opt out with `DO_NOT_TRACK=1`, `MEX_TELEMETRY=0`, or `mex config set telemetry off`. Audit the exact payload with `mex telemetry inspect`; check state with `mex telemetry status`. Telemetry is disabled automatically when running from a clone of the mex repo. See [TELEMETRY.md](TELEMETRY.md).
- **Scaffold identity** — the scaffold's `config.json` now carries a stable `scaffold_id` (UUID v4), `scaffold_name`, and nullable `origin`/`upstream`. Generated at `mex setup` and silently backfilled for existing scaffolds on the next CLI invocation. New `getScaffoldIdentity()` export on the public API.
- **broken-link drift checker** — flags Markdown links in scaffold files whose local target file does not exist.

### Changed
- README and CONTRIBUTING now list all 11 drift checkers (including `tool-config-sync`, `todo-fixme`, and `broken-link`).

## [0.3.5] - 2026-05-14

### Added
- **Package rename** — the npm package is now `mex-agent`; the installed binary command remains `mex`.
- **Agent memory mode** — `mex setup --mode agent-memory` creates templates for persistent-agent, homelab, OpenClaw-style, and operational-memory workspaces.
- **Heartbeat checks** — `mex heartbeat` runs lightweight scheduled health checks over optional `last_updated` frontmatter, stale context, memory cleanup metadata, and old daily memory files.
- **Scheduled heartbeat loop** — `mex watch --interval` runs heartbeat repeatedly in the foreground while preserving the existing post-commit hook behavior for plain `mex watch`.
- **Event log** — `mex log` appends notes, decisions, risks, and todos to `.mex/events/decisions.jsonl`.
- **Timeline** — `mex timeline` reads recent event entries, with `--json` for scripting.
- **Doctor command** — `mex doctor` summarizes scaffold health across drift, heartbeat, config, and events.
- **Interactive TUI** — bare `mex` and `mex tui` open an Ink terminal dashboard with drift score, heartbeat status, event activity, timeline/log actions, and a bordered action panel.
- **Shell completions** — `mex completion bash|zsh|fish` prints completion scripts.
- **Config tuning** — optional `.mex/config.json` supports staleness thresholds, heartbeat thresholds, and watch interval defaults.

### Changed
- `mex check` output is grouped by severity with clearer remediation hints.
- `mex check --json` provides a script-friendly report shape.
- Scaffold templates now include `last_updated` frontmatter guidance and a GROW loop that encourages logging rationale with `mex log`.
- Agent-memory templates frame mex as three-layer memory: state memory in scaffold files, procedural memory in patterns, and event memory in JSONL logs.
- README documents the TUI, agent-memory mode, heartbeat, config, and the OpenClaw/persistent-agent use case.

### Compatibility
- No scaffold migration is required.
- `last_updated` is optional; files without it are ignored by heartbeat staleness checks.
- `.mex/config.json` is optional; missing values use defaults.
- `.mex/events/` is created only when events are logged.
- The TUI is additive; all existing CLI commands remain available and script-friendly.

### Deferred
- Context routing command.
- Full schema migration with ids/requires fields.
- Federation / hierarchical scaffolds.
- Bidirectional state-event references.
- Dynamic domain nodes via Tree-sitter.

## [0.3.4] - 2026-04-07

### Changed
- **Simplified install flow** — `npx promexeus setup` now offers to install globally at the end, so `mex check` and `mex sync` just work
- Users who skip global install get clear `npx promexeus` commands as the fallback
- Removed dev-dependency + package.json scripts instructions — one canonical flow, not three
- README install section rewritten: setup → global install prompt → done
- Fixed wrong package name (`mex-cli`) in post-setup instructions
- `mex commands` output cleaned up: removed shell scripts section, shows `npx promexeus` fallback

## [0.2.0] - 2026-04-05

### Added
- **`mex setup` command** — npx-first install replaces git clone + bash script. One command: `npx promexeus setup`
- Bundled scaffold templates in npm package (`templates/` directory)
- Interactive tool config selection (Claude Code, Cursor, Windsurf, GitHub Copilot)
- Project state detection: fresh, existing, or partial scaffold
- Codebase pre-scanner integration during setup
- `--dry-run` flag for setup command
- Published to npm as `promexeus`

### Fixed
- False positive `DEPENDENCY_MISSING` warnings for versioned dependencies with semver prefixes (`^`, `~`, `>=`)

### Changed
- Package renamed from `mex` to `promexeus` for npm availability
- Sync now sends all drift issues to Claude in a single session instead of one session per file — reduces token usage and eliminates repeated session restarts
- README updated: npx is now the primary install method, git clone is the alternative

## [0.1.0] - 2026-03-21

### Added
- Initial release
- 8 drift checkers: path, edges, index-sync, staleness, command, dependency, cross-file, script-coverage
- `mex check` with `--quiet`, `--json`, `--fix` flags
- `mex sync` with interactive and prompt modes, dry-run support
- `mex init` codebase pre-scanner
- `mex watch` post-commit hook
- `setup.sh` for first-time scaffold population
- `sync.sh` interactive menu
- Multi-tool support (Claude Code, Cursor, Windsurf, GitHub Copilot)
