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
 */
const SCAFFOLD_MARKER = "<!-- mex-tool-config";

/** Check that all installed tool config files hold identical content. */
export function checkToolConfigSync(projectRoot: string): DriftIssue[] {
	const present: Array<{ path: string; content: string }> = [];
	for (const rel of TOOL_CONFIG_FILES) {
		const abs = resolve(projectRoot, rel);
		if (!existsSync(abs)) continue;
		try {
			const content = readFileSync(abs, "utf-8");
			if (!content.includes(SCAFFOLD_MARKER)) continue;
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
