import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { DriftIssue } from "../../types.js";

/**
 * Files that `setup.sh` may copy with identical content from `.tool-configs/`.
 * If a user installs more than one tool and later edits one of these files in
 * place, the copies can silently drift out of sync. `.opencode/opencode.json`
 * is intentionally excluded -- it's a different format and references
 * `.mex/AGENTS.md` rather than embedding the same text.
 */
const TOOL_CONFIG_FILES: ReadonlyArray<string> = [
	"CLAUDE.md",
	"AGENTS.md",
	".cursorrules",
	".windsurfrules",
	".github/copilot-instructions.md",
];

/**
 * A file only participates in the sync check when it is actually a copy of the
 * mex tool config -- recognised by the sentinel comment every generated
 * template carries. Repos commonly have a hand-written CLAUDE.md or a
 * generated AGENTS.md that never came from `.tool-configs/`; those may still
 * mention ROUTER.md in ordinary guidance, so only the dedicated sentinel is
 * proof of scaffold origin.
 *
 * Anchored to the start of a line so a file that merely quotes the sentinel in
 * prose is not mistaken for a copy.
 */
const SCAFFOLD_MARKER = /^<!-- mex-tool-config\b/m;

/**
 * Copies installed before the sentinel shipped do not carry it, and nothing
 * rewrites them: `mex setup` skips any destination that already exists, so an
 * installed anchor is never re-copied. Without a second signal the check would
 * go silent for every pre-existing install -- real drift, no warning.
 *
 * This frontmatter line has been byte-stable across every tool config template
 * since the initial commit, so it identifies those copies with no migration
 * step. It is mex's own template prose and does not appear in an independently
 * owned config. Bridge only: drop it at a major version once installs have
 * turned over, leaving the sentinel as the sole contract.
 */
const LEGACY_MARKER = "Always-loaded project anchor. Read this first.";

/** Whether a file is a copy of the mex tool config, new sentinel or legacy. */
function isScaffoldCopy(content: string): boolean {
	return SCAFFOLD_MARKER.test(content) || content.includes(LEGACY_MARKER);
}

/** Check that all installed tool config files hold identical content. */
export function checkToolConfigSync(projectRoot: string): DriftIssue[] {
	const present: Array<{ path: string; content: string }> = [];
	for (const rel of TOOL_CONFIG_FILES) {
		const abs = resolve(projectRoot, rel);
		if (!existsSync(abs)) continue;
		try {
			const content = readFileSync(abs, "utf-8");
			if (!isScaffoldCopy(content)) continue;
			present.push({ path: rel, content });
		} catch {
			// Unreadable file -- ignore rather than reporting a checker-internal error.
		}
	}

	// Nothing to compare until at least two tool configs are installed.
	if (present.length < 2) return [];

	const reference = present[0];
	const issues: DriftIssue[] = [];
	for (let i = 1; i < present.length; i++) {
		if (present[i].content !== reference.content) {
			issues.push({
				code: "TOOL_CONFIG_DRIFT",
				severity: "warning",
				file: present[i].path,
				line: null,
				message: `Tool config ${present[i].path} has drifted from ${reference.path}. Re-copy from .tool-configs/ or edit both to match.`,
			});
		}
	}
	return issues;
}
