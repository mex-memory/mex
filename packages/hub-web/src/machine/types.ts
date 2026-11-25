import type { z } from "zod";
import type {
  MachineDailyActivitySchema,
  MachineHomeSchema,
  MachineJobActionRequestSchema,
  MachineJobSchema,
  MachineKnowledgeKindSchema,
  MachineKnowledgeStatusCountsSchema,
  MachineKnowledgeSummarySchema,
} from "@mex/hub-contracts/machine";

export type KnowledgeStatusCounts = z.infer<typeof MachineKnowledgeStatusCountsSchema>;
export type KnowledgeKind = z.infer<typeof MachineKnowledgeKindSchema>;
export type KnowledgeSummary = z.infer<typeof MachineKnowledgeSummarySchema>;
export type DailyActivity = z.infer<typeof MachineDailyActivitySchema>;
export type HomeOverview = z.infer<typeof MachineHomeSchema>;
export type HubJob = z.infer<typeof MachineJobSchema>;
export type JobAction = z.infer<typeof MachineJobActionRequestSchema>["action"];

export interface HubPreview {
  overview: HomeOverview;
  jobs: readonly HubJob[];
  changeJob: (id: string, action: JobAction) => void;
}
