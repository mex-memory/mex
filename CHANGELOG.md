# Changelog

All notable changes to this project will be documented in this file.

## [0.3.5] - 2026-05-14

### Added
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

## [0.4.0] - 2026-04-07

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
