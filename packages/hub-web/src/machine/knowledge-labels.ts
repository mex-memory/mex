import type { KnowledgeAudience, KnowledgeKind } from "./types";

export const kindLabels = {
  rule: "Rule",
  recipe: "Recipe",
  decision: "Decision",
  pitfall: "Pitfall",
  procedure: "Procedure",
  fact: "Fact",
  hint: "Hint",
} satisfies Record<KnowledgeKind, string>;

export const audienceLabels = {
  personal: "Only you",
  team: "Your team",
  hint: "Hint from your agent",
} satisfies Record<KnowledgeAudience, string>;
