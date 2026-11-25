import type { z } from "zod";
import type {
  MachineDailyActivitySchema,
  MachineForgottenItemSchema,
  MachineForgottenPageSchema,
  MachineHomeSchema,
  MachineJobActionRequestSchema,
  MachineJobSchema,
  MachineKnowledgeAudienceSchema,
  MachineKnowledgeCreateRequestSchema,
  MachineKnowledgeCreateResponseSchema,
  MachineKnowledgeDetailSchema,
  MachineKnowledgeEditRequestSchema,
  MachineKnowledgeEditResponseSchema,
  MachineKnowledgeForgetRequestSchema,
  MachineKnowledgeForgetResponseSchema,
  MachineKnowledgeItemSchema,
  MachineKnowledgeKindSchema,
  MachineKnowledgeLandingSchema,
  MachineKnowledgePageSchema,
  MachineKnowledgeStatusCountsSchema,
  MachineKnowledgeStatusSchema,
  MachineKnowledgeSummarySchema,
  MachineKnowledgeWritePreviewSchema,
} from "@mex/hub-contracts/machine";

export type KnowledgeStatusCounts = z.infer<typeof MachineKnowledgeStatusCountsSchema>;
export type KnowledgeStatus = z.infer<typeof MachineKnowledgeStatusSchema>;
export type KnowledgeKind = z.infer<typeof MachineKnowledgeKindSchema>;
export type KnowledgeAudience = z.infer<typeof MachineKnowledgeAudienceSchema>;
export type KnowledgeSummary = z.infer<typeof MachineKnowledgeSummarySchema>;
export type KnowledgeItem = z.infer<typeof MachineKnowledgeItemSchema>;
export type KnowledgeDetail = z.infer<typeof MachineKnowledgeDetailSchema>;
export type KnowledgePageData = z.infer<typeof MachineKnowledgePageSchema>;
export type KnowledgeLandingData = z.infer<typeof MachineKnowledgeLandingSchema>;
export type ForgottenPageData = z.infer<typeof MachineForgottenPageSchema>;
export type ForgottenItem = z.infer<typeof MachineForgottenItemSchema>;
export type KnowledgeCreate = z.infer<typeof MachineKnowledgeCreateRequestSchema>;
export type KnowledgeEdit = z.infer<typeof MachineKnowledgeEditRequestSchema> & { checkout?: string };
export type KnowledgeForget = z.infer<typeof MachineKnowledgeForgetRequestSchema> & { checkout?: string };
export type KnowledgeCreateResult = z.infer<typeof MachineKnowledgeCreateResponseSchema>;
type FixtureEditResult = z.infer<typeof MachineKnowledgeEditResponseSchema>;
export type KnowledgeEditResult = Exclude<FixtureEditResult, { type: "conflict" }>
  | { type: "conflict"; current: KnowledgeDetail; attempted: KnowledgeEdit };
export type KnowledgeForgetResult = z.infer<typeof MachineKnowledgeForgetResponseSchema>;
export type KnowledgeWritePreview = z.infer<typeof MachineKnowledgeWritePreviewSchema>;
export type DailyActivity = z.infer<typeof MachineDailyActivitySchema>;
export type HomeOverview = z.infer<typeof MachineHomeSchema>;
export type HubJob = z.infer<typeof MachineJobSchema>;
export type JobAction = z.infer<typeof MachineJobActionRequestSchema>["action"];

export interface KnowledgeFilters {
  scopeId?: string;
  repoId?: string;
  kind?: KnowledgeKind;
  audience?: KnowledgeAudience;
  status?: KnowledgeStatus | "needs-look";
  area?: string;
  query: string;
}

export interface KnowledgeActions {
  createNote: (request: KnowledgeCreate, onRetry?: () => void) => KnowledgeCreateResult | Promise<KnowledgeCreateResult>;
  editNote: (request: KnowledgeEdit, onRetry?: () => void) => KnowledgeEditResult | Promise<KnowledgeEditResult>;
  forgetItem: (request: KnowledgeForget, onRetry?: () => void) => KnowledgeForgetResult | Promise<KnowledgeForgetResult>;
}

export interface KnowledgePreview {
  getLanding: (scopeId?: string) => KnowledgeLandingData;
  getPage: (filters: KnowledgeFilters, cursor?: string) => KnowledgePageData;
  getDetail: (key: string) => KnowledgeDetail | undefined;
  forgotten: readonly ForgottenItem[];
  createNote: (request: KnowledgeCreate) => KnowledgeCreateResult;
  editNote: (request: KnowledgeEdit) => KnowledgeEditResult;
  forgetItem: (request: KnowledgeForget) => KnowledgeForgetResult;
}

export interface HubPreview {
  overview: HomeOverview;
  jobs: readonly HubJob[];
  knowledge: KnowledgePreview;
  changeJob: (id: string, action: JobAction) => void;
}
