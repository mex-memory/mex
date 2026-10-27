/**
 * The root files an AI tool loads on its own, and what makes one of them point
 * at the scaffold.
 *
 * A populated `.mex/` is inert unless some always-loaded file tells the agent
 * to read it: Claude Code loads `CLAUDE.md`, Cursor loads `.cursorrules`, and
 * neither goes looking for `.mex/ROUTER.md` unaided. Three places need to
 * agree on that list -- setup when it writes an anchor, the sync checker when
 * it compares copies, and the orphan checker when it asks whether anything
 * points at the scaffold at all -- so the registry lives here rather than
 * being restated in each. See https://github.com/mex-memory/mex/issues/106
 */

/**
 * Delimiters of the pointer block setup maintains inside a markdown anchor it
 * did not write. Defined here rather than in setup because the sync checker
 * must strip the block before comparing copies, and a checker importing setup
 * would invert the dependency.
 */
export const MEX_ANCHOR_START = "<!-- mex-anchor:start -->";
export const MEX_ANCHOR_END = "<!-- mex-anchor:end -->";

/**
 * Delimiters of the short block MEX keeps in a managed instruction file while
 * setup is unfinished (it says how to continue) and removes when setup completes.
 */
export const MEX_SETUP_NOTICE_START = "<!-- mex-setup:start -->";
export const MEX_SETUP_NOTICE_END = "<!-- mex-setup:end -->";

export type AnchorFormat = "markdown" | "json";

export interface AnchorFile {
  /** Project-relative, forward-slash path. */
  readonly path: string;
  readonly format: AnchorFormat;
  readonly displayName: string;
}

/**
 * `CLAUDE.md` and `AGENTS.md` are owned by the agent-skills installer, which
 * maintains its own managed block in them. They are listed because the orphan
 * checker must still see them -- a scaffold is not orphaned when `CLAUDE.md`
 * points at it, whoever wrote that pointer.
 */
export const ANCHOR_FILES: readonly AnchorFile[] = [
  { path: "CLAUDE.md", format: "markdown", displayName: "Claude Code" },
  { path: "AGENTS.md", format: "markdown", displayName: "Codex" },
  { path: ".cursorrules", format: "markdown", displayName: "Cursor" },
  { path: ".windsurfrules", format: "markdown", displayName: "Windsurf" },
  {
    path: ".github/copilot-instructions.md",
    format: "markdown",
    displayName: "GitHub Copilot",
  },
  { path: ".opencode/opencode.json", format: "json", displayName: "OpenCode" },
];

/**
 * A file only counts as a copy of the mex tool config when it carries the
 * sentinel every generated template ships with. Repos commonly have a
 * hand-written `CLAUDE.md` that mentions ROUTER.md in ordinary guidance;
 * only the dedicated sentinel is proof of scaffold origin.
 *
 * Anchored to the start of a line so a file that merely quotes the sentinel in
 * prose is not mistaken for a copy.
 */
export const TOOL_CONFIG_MARKER = /^<!-- mex-tool-config\b/m;

/**
 * Copies installed before the sentinel shipped do not carry it. This
 * frontmatter line has been byte-stable across every tool config template
 * since the initial commit, so it identifies those copies with no migration
 * step. Bridge only: drop it at a major version once installs have turned
 * over, leaving the sentinel as the sole contract.
 */
export const LEGACY_TOOL_CONFIG_MARKER = "Always-loaded project anchor. Read this first.";

/** Whether a file is a copy of the mex tool config, new sentinel or legacy. */
export function isToolConfigCopy(content: string): boolean {
  return TOOL_CONFIG_MARKER.test(content) || content.includes(LEGACY_TOOL_CONFIG_MARKER);
}

/**
 * Any mention of a path inside `.mex/` counts as pointing at the scaffold.
 *
 * Deliberately looser than naming ROUTER.md specifically: a user who wrote
 * their own pointer at `.mex/AGENTS.md`, or who routes through some other
 * scaffold file, has solved the problem this check exists to catch, and
 * failing them for phrasing it differently would be noise. Bare `mex` is not
 * enough -- it appears in prose about the tool without loading anything.
 */
const SCAFFOLD_REFERENCE = /(^|[^\w./-])\.mex\//;

/** Whether a markdown anchor's text points the agent at the scaffold. */
export function referencesScaffold(content: string): boolean {
  return SCAFFOLD_REFERENCE.test(content);
}

/**
 * OpenCode names its instruction files in a JSON array rather than in prose,
 * so its anchor points at the scaffold when that array holds a `.mex/` path.
 * Returns null when the file is not the object shape we know how to read, so
 * callers can stay silent rather than guess.
 */
export function opencodeInstructions(content: string): string[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const instructions = (parsed as Record<string, unknown>).instructions;
  if (instructions === undefined) return [];
  if (!Array.isArray(instructions)) return null;
  return instructions.filter((entry): entry is string => typeof entry === "string");
}
