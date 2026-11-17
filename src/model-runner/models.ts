export type ModelAgent = "claude" | "codex";
export type ModelRole = "cheap" | "best";
export type ModelSetup = "mixed" | "best-only";
export type ModelTable = Readonly<Record<ModelAgent, Readonly<{ cheap: string | null; best: string }>>>;

/** Model names belong only in this replaceable table, never in runner logic. */
export const DEFAULT_MODELS: ModelTable = Object.freeze({
  claude: Object.freeze({ cheap: "haiku", best: "opus" }),
  codex: Object.freeze({ cheap: "gpt-6-luna", best: "gpt-6.1-sol" }),
});

export interface ModelSelection { role?: ModelRole; setup?: ModelSetup; models?: ModelTable; }
export function selectModel(agent: ModelAgent, selection: ModelSelection = {}): string {
  const { role = "best", setup = "mixed", models = DEFAULT_MODELS } = selection;
  if ((agent !== "claude" && agent !== "codex") || (role !== "cheap" && role !== "best") || (setup !== "mixed" && setup !== "best-only")) throw new Error("Invalid model selection.");
  const entry = models[agent];
  const model = setup === "mixed" && role === "cheap" ? entry?.cheap ?? entry?.best : entry?.best;
  if (typeof model !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/.test(model)) throw new Error("Invalid model table entry.");
  return model;
}
