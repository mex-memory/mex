import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { DriftIssue } from "../../types.js";
import { MEX_ANCHOR_END, MEX_ANCHOR_START, MEX_SETUP_NOTICE_END, MEX_SETUP_NOTICE_START, isToolConfigCopy } from "../../tool-config.js";
import { MEX_INSTRUCTIONS_END, MEX_INSTRUCTIONS_START } from "../../agent-skills/instructions.js";

/**
 * Files that setup may copy with identical content from `.tool-configs/`.
 * If a user installs more than one tool and later edits one of these files in
 * place, the copies can silently drift out of sync. `.opencode/opencode.json`
 * is intentionally excluded -- it is a different format and references
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
 * Blocks mex maintains inside an anchor, which are expected to differ between
 * copies and must not count as drift.
 *
 * `CLAUDE.md` carries the agent-skills policy block and `.cursorrules` cannot
 * -- Cursor has no mex skills to invoke. Comparing the raw bytes therefore
 * reported an install of both tools as permanently drifted, with no edit the
 * user could make to clear it: matching the files would mean deleting a block
 * the installer rewrites on every sync. Compare what the user owns instead.
 */
const MANAGED_BLOCKS: ReadonlyArray<readonly [string, string]> = [
	[MEX_INSTRUCTIONS_START, MEX_INSTRUCTIONS_END],
	[MEX_ANCHOR_START, MEX_ANCHOR_END],
	// Present only while setup is unfinished; it says how to continue.
	[MEX_SETUP_NOTICE_START, MEX_SETUP_NOTICE_END],
];

/** Remove every mex-managed block, leaving the user-owned remainder. */
function stripManagedBlocks(content: string): string {
	let result = content;
	for (const [start, end] of MANAGED_BLOCKS) {
		const from = result.indexOf(start);
		if (from === -1) continue;
		const to = result.indexOf(end, from);
		if (to === -1) continue;
		result = result.slice(0, from) + result.slice(to + end.length);
	}
	// Line endings are a checkout artifact, not an edit: a repo without a
	// `text` attribute hands CRLF to Windows and LF to CI for the same commit.
	return result.replace(/\r\n/g, "\n").trim();
}

/** One copy differs from what the others agree on. */
function drift(path: string, reference: string): DriftIssue {
	return {
		code: "TOOL_CONFIG_DRIFT",
		severity: "warning",
		file: path,
		line: null,
		message: `Tool config ${path} has drifted from ${reference}. Re-copy from .tool-configs/ or edit both to match.`,
	};
}

/** Check that all installed tool config files hold identical content. */
export function checkToolConfigSync(projectRoot: string): DriftIssue[] {
	const present: Array<{ path: string; content: string }> = [];
	for (const rel of TOOL_CONFIG_FILES) {
		const abs = resolve(projectRoot, rel);
		if (!existsSync(abs)) continue;
		try {
			const content = readFileSync(abs, "utf-8");
			if (!isToolConfigCopy(content)) continue;
			present.push({ path: rel, content: stripManagedBlocks(content) });
		} catch {
			// Unreadable file -- ignore rather than reporting a checker-internal error.
		}
	}

	// Nothing to compare until at least two tool configs are installed.
	if (present.length < 2) return [];

	// Group the copies by content, keeping TOOL_CONFIG_FILES order within and
	// between groups. Identical copies collapse into one group; each edit that
	// was not propagated forms another.
	const groups = new Map<string, string[]>();
	for (const { path, content } of present) {
		const group = groups.get(content);
		if (group) group.push(path);
		else groups.set(content, [path]);
	}
	if (groups.size === 1) return [];

	const ordered = [...groups.values()];

	// With exactly two copies there is no majority to appeal to and no way to
	// tell which one moved, so keep reporting the pair as before.
	if (present.length === 2) {
		return [drift(present[1].path, present[0].path)];
	}

	// The largest group is what the copies are supposed to say: an edit made in
	// one place leaves the others agreeing. Blaming the first file in list order
	// instead pins every warning on the wrong file whenever the edited copy
	// happens to sort first. See https://github.com/mex-memory/mex/issues/127
	const largest = ordered.reduce((a, b) => (b.length > a.length ? b : a));
	const tied = ordered.filter((g) => g.length === largest.length).length > 1;

	// No majority means no honest culprit -- say they diverged and stop there,
	// rather than picking a group to blame.
	if (tied) {
		const summary = ordered.map((g) => `[${g.join(", ")}]`).join(" vs ");
		return [
			{
				code: "TOOL_CONFIG_DRIFT",
				severity: "warning",
				file: ordered[0][0],
				line: null,
				message: `Tool configs have diverged into ${ordered.length} groups with no majority, so none can be identified as the edited one: ${summary}.`,
			},
		];
	}

	const issues: DriftIssue[] = [];
	for (const group of ordered) {
		if (group === largest) continue;
		for (const path of group) {
			issues.push(drift(path, largest[0]));
		}
	}
	return issues;
}
