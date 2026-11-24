export const MODEL_AGENTS = ["claude", "codex", "gemini", "copilot"] as const;
export type ModelAgent = typeof MODEL_AGENTS[number];
export type ModelRole = "cheap" | "best";
export type ModelSetup = "mixed" | "best-only";
type ModelEntry = Readonly<{ cheap: string | null; best: string | null }>;
export type ModelTable = Readonly<Record<"claude" | "codex", ModelEntry> & Partial<Record<"gemini" | "copilot", ModelEntry>>>;

/** Model names belong only in this replaceable table, never in runner logic. */
export const DEFAULT_MODELS = Object.freeze({
  claude: Object.freeze({ cheap: "haiku", best: "opus" }),
  codex: Object.freeze({ cheap: "gpt-6-luna", best: "gpt-6.1-sol" }),
  gemini: Object.freeze({ cheap: "flash", best: "pro" }),
  copilot: Object.freeze({ cheap: null, best: null }),
}) satisfies ModelTable;

/**
 * A cheap and a best model for every agent MEX supports (plan sheet 16).
 * null means "the agent's own default": the agent has no model flag, or the
 * name is not confirmed yet. Names never live in runner logic.
 *
 * Read 15 Nov 2026 (OSS-49):
 * - Gemini CLI: `gemini -p --model <name>` accepts the aliases `flash` and `pro`.
 * - Cursor: `agent -p --model <slug>`; slugs depend on the account
 *   (`agent models`), so both stay null until release-03-T1 lists them.
 * - Antigravity: `agy -p` documents no model flag; the app's choice is used.
 * Copilot, OpenCode, Devin and Kiro are added by OSS-48.
 */
export type AgentModelTable = Readonly<Record<string, Readonly<{ cheap: string | null; best: string | null }>>>;
export const AGENT_MODELS: AgentModelTable = Object.freeze({
  "claude-code": DEFAULT_MODELS.claude,
  codex: DEFAULT_MODELS.codex,
  cursor: Object.freeze({ cheap: null, best: null }),
  antigravity: Object.freeze({ cheap: null, best: null }),
  gemini: DEFAULT_MODELS.gemini,
  copilot: DEFAULT_MODELS.copilot,
});

export interface ModelSelection { role?: ModelRole; setup?: ModelSetup; models?: ModelTable; }
export function selectModel(agent: ModelAgent, selection: ModelSelection = {}): string {
  const { role = "best", setup = "mixed", models = DEFAULT_MODELS } = selection;
  if (!MODEL_AGENTS.includes(agent) || (role !== "cheap" && role !== "best") || (setup !== "mixed" && setup !== "best-only")) throw new Error("Invalid model selection.");
  const entry = models[agent];
  const model = setup === "mixed" && role === "cheap" ? entry?.cheap ?? entry?.best : entry?.best;
  if (model === null && agent === "copilot") return "default";
  if (typeof model !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/.test(model)) throw new Error("Invalid model table entry.");
  return model;
}
