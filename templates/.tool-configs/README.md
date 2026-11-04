# Tool Configuration Files

These files make the scaffold work with specific AI coding tools. `mex setup`
manages them automatically; manual copying is only a fallback.

The markdown files carry a `<!-- mex-tool-config -->` marker on the line after the frontmatter. `mex check` compares only the files carrying it, so a `CLAUDE.md` or `AGENTS.md` you wrote yourself is left alone. Keep the marker when you edit a copy; remove it and that file drops out of the sync check.

## Which file does your tool use?

| Tool | File to use |
|------|-------------|
| Claude Code | `CLAUDE.md` plus copied `.claude/skills/mex-*` project skills |
| Cursor | `.cursorrules` → copy or symlink to project root, plus copied `.agents/skills/mex-*` project skills |
| Windsurf | `.windsurfrules` → copy or symlink to project root, plus copied `.agents/skills/mex-*` project skills |
| GitHub Copilot | `copilot-instructions.md` → copy to `.github/` in project root, plus copied `.agents/skills/mex-*` project skills |
| OpenCode | `opencode.json` → copy to `.opencode/` in project root, plus `AGENTS.md` and copied `.agents/skills/mex-*` project skills |
| Codex (OpenAI) | `AGENTS.md` plus copied `.agents/skills/mex-*` project skills |
| Any other tool | Point agent to `.mex/AGENTS.md` |

## Setup

Prefer `mex setup`, which preserves user-written instructions, installs managed
skill copies, and adds the client-appropriate managed block. For a manual
anchor-only fallback, copy the relevant file (do not symlink package skills):

```bash
# Claude Code
cp .tool-configs/CLAUDE.md ./CLAUDE.md

# Cursor
cp .tool-configs/.cursorrules ./.cursorrules

# Windsurf
cp .tool-configs/.windsurfrules ./.windsurfrules

# Copilot
mkdir -p .github && cp .tool-configs/copilot-instructions.md ./.github/copilot-instructions.md

# OpenCode
mkdir -p .opencode && cp .tool-configs/opencode.json ./.opencode/opencode.json

# Codex (OpenAI): generate its client-aware block; do not copy CLAUDE.md.
mex skills sync --tool codex
```

## If your tool is not listed

Add "Read .mex/ROUTER.md before starting any task" to your tool's system prompt
or paste it at the start of each session. The scaffold works identically.

## Content

The unsupported-client files share the Circle 1 anchor from `.mex/AGENTS.md`.
Claude's maintained template additionally uses Claude's `/mex-*` syntax, while
Codex's managed root block uses `$mex-*`. OpenCode references `.mex/AGENTS.md`
by path. Never copy client-specific invocation syntax into another client.
