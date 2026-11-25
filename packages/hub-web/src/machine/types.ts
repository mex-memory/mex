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
  MachineKnowledgeDetailSchema,
  MachineKnowledgeEditRequestSchema,
  MachineKnowledgeForgetRequestSchema,
  MachineKnowledgeItemSchema,
  MachineKnowledgeKindSchema,
  MachineKnowledgeLandingSchema,
  MachineKnowledgePageSchema,
  MachineKnowledgeStatusCountsSchema,
  MachineKnowledgeStatusSchema,
  MachineKnowledgeSummarySchema,
  MachineKnowledgeWritePreviewSchema,
  MachineReviewActionRequest,
  MachineReviewActionResponse,
  MachineReviewQueue,
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
export type KnowledgeCreate = z.infer<typeof MachineKnowledgeCreateRequestSchema> & { scope: string[] };
type EditInput = z.infer<typeof MachineKnowledgeEditRequestSchema>;
export type KnowledgeEdit = Omit<EditInput, "apply" | "previewRevision"> &
  Required<Pick<EditInput, "kind" | "oneLine" | "scope">> & { key: string; confirmRevision?: string };
export type KnowledgeForget = Omit<z.infer<typeof MachineKnowledgeForgetRequestSchema>, "apply" | "previewRevision"> &
  { key: string; expectedRevision: string; confirmRevision?: string };
export type KnowledgeCreateResult = { type: "ok"; item: KnowledgeDetail };
type KnowledgeConflict<T> = { type: "conflict"; current: KnowledgeDetail; attempted: T };
export type KnowledgeWritePreview = z.infer<typeof MachineKnowledgeWritePreviewSchema> & { type: "preview" };
export type KnowledgeEditResult = KnowledgeCreateResult | KnowledgeWritePreview | KnowledgeConflict<KnowledgeEdit>;
export type KnowledgeForgetResult = { type: "ok"; item: ForgottenItem } | KnowledgeWritePreview | KnowledgeConflict<KnowledgeForget>;
export type DailyActivity = z.infer<typeof MachineDailyActivitySchema>;
export type HomeOverview = z.infer<typeof MachineHomeSchema>;
export type HubJob = z.infer<typeof MachineJobSchema>;
export type JobAction = z.infer<typeof MachineJobActionRequestSchema>["action"];
export type ReviewAction = MachineReviewActionRequest["action"];
export type ReviewDraft = NonNullable<MachineReviewActionRequest["edited"]>;
export type ReviewWritePreview = Extract<MachineReviewActionResponse, { type: "preview" }>;
export type ReviewApplied = Extract<MachineReviewActionResponse, { type: "applied" }>;
export type ReviewHandled = Extract<MachineReviewActionResponse, { type: "alreadyHandled" }>;

export interface ReviewPreview {
  queue?: MachineReviewQueue;
  act: (key: string, request: MachineReviewActionRequest, onRetry: () => void) => Promise<MachineReviewActionResponse>;
  dismissHandled: (key: string) => void;
}

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
