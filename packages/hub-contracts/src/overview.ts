import { z } from "zod";
import {
  ActivityItemSchema,
  ActivityResponseSchema,
  GraphHealthDetailsSchema,
  HomeResponseSchema,
  HubBoundedReasonSchema,
  HubDiagnosticSchema,
  HubIsoTimestampSchema,
  HubJobSnapshotSchema,
  HUB_LIMITS,
  HubRevisionSchema,
  InboxProposalSummarySchema,
  RelaySummarySchema,
  TeamCurrentActorResponseSchema,
  WikiHealthDetailsSchema,
} from "./index.js";

const overviewUnavailablePanel = z.object({
  availability: z.literal("unavailable"),
  observedAt: HubIsoTimestampSchema,
  reason: HubBoundedReasonSchema,
}).strict();

export const OverviewIdentityPanelSchema = z.discriminatedUnion("availability", [
  z.object({
    availability: z.literal("available"),
    observedAt: HubIsoTimestampSchema,
    current: TeamCurrentActorResponseSchema,
  }).strict(),
  overviewUnavailablePanel,
]);

export const OverviewFocusIdentitySourceSchema = z.discriminatedUnion("availability", [
  z.object({
    availability: z.literal("available"),
    observedAt: HubIsoTimestampSchema,
    requiresAttention: z.boolean(),
  }).strict(),
  overviewUnavailablePanel,
]);

const overviewUnavailableCorpusSource = overviewUnavailablePanel.extend({
  deterministicRevision: HubRevisionSchema.optional(),
  truncated: z.boolean().optional(),
  sourceTruncated: z.boolean().optional(),
  diagnostics: z.array(HubDiagnosticSchema).max(HUB_LIMITS.maxDiagnosticCount).optional(),
  diagnosticsTruncated: z.boolean().optional(),
}).strict();

export const OverviewFocusInboxSourceSchema = z.discriminatedUnion("availability", [
  z.object({
    availability: z.literal("available"),
    observedAt: HubIsoTimestampSchema,
    teamReviewCount: z.number().int().nonnegative(),
    items: z.array(InboxProposalSummarySchema).max(3),
    deterministicRevision: HubRevisionSchema,
    sourceTruncated: z.literal(false),
    diagnostics: z.array(HubDiagnosticSchema).max(HUB_LIMITS.maxDiagnosticCount),
    diagnosticsTruncated: z.boolean(),
  }).strict(),
  overviewUnavailableCorpusSource,
]);

export const OverviewFocusRelaySourceSchema = z.discriminatedUnion("availability", [
  z.object({
    availability: z.literal("available"),
    observedAt: HubIsoTimestampSchema,
    readyToTakeCount: z.number().int().nonnegative(),
    inYourHandsCount: z.number().int().nonnegative(),
    readyToTake: z.array(RelaySummarySchema).max(3),
    inYourHands: z.array(RelaySummarySchema).max(3),
    deterministicRevision: HubRevisionSchema,
    sourceTruncated: z.literal(false),
    diagnostics: z.array(HubDiagnosticSchema).max(HUB_LIMITS.maxDiagnosticCount),
    diagnosticsTruncated: z.boolean(),
  }).strict(),
  overviewUnavailableCorpusSource,
]);

const overviewFocusAvailable = z.object({
  availability: z.literal("available"),
  observedAt: HubIsoTimestampSchema,
  identity: OverviewFocusIdentitySourceSchema,
  inbox: OverviewFocusInboxSourceSchema,
  relays: OverviewFocusRelaySourceSchema,
}).strict().superRefine((value, context) => {
  if ([value.identity, value.inbox, value.relays].every(
    (source) => source.availability === "unavailable",
  )) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "An available Overview focus panel requires at least one available source.",
    });
  }
});

export const OverviewFocusPanelSchema = z.union([
  overviewFocusAvailable,
  overviewUnavailablePanel,
]);

const overviewActivityAvailable = ActivityResponseSchema.innerType().extend({
  availability: z.literal("available"),
  observedAt: HubIsoTimestampSchema,
  items: z.array(ActivityItemSchema).max(5),
}).strict().superRefine((value, context) => {
  if (value.hasMore !== (value.nextCursor !== null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["hasMore"],
      message: "hasMore must match nextCursor presence.",
    });
  }
});

export const OverviewActivityPanelSchema = z.union([
  overviewActivityAvailable,
  overviewUnavailablePanel,
]);

export const OverviewGraphHealthDetailsSchema = GraphHealthDetailsSchema.innerType().omit({
  activeJobId: true,
}).strict().superRefine((value, context) => {
  if (
    value.recommendedJobKind !== null
    && !value.allowedJobKinds.includes(value.recommendedJobKind)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["recommendedJobKind"],
      message: "A recommended graph operation must also be allowed.",
    });
  }
  if (value.parseHealth.ok + value.parseHealth.partial + value.parseHealth.failed
    !== value.parseHealth.total) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["parseHealth"],
      message: "Graph parse-health counts must sum to the total.",
    });
  }
});

export const OverviewWikiHealthDetailsSchema = WikiHealthDetailsSchema.innerType().omit({
  activeJobId: true,
}).strict().superRefine((value, context) => {
  if (
    value.recommendedJobKind !== null
    && !value.allowedJobKinds.includes(value.recommendedJobKind)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["recommendedJobKind"],
      message: "A recommended Wiki operation must also be allowed.",
    });
  }
});

const overviewGraphAvailable = z.object({
  availability: z.literal("available"),
  observedAt: HubIsoTimestampSchema,
  status: z.enum(["healthy", "degraded"]),
  summary: z.string().min(1).max(1_024),
  diagnostics: z.array(HubDiagnosticSchema).max(HUB_LIMITS.maxDiagnosticCount),
  diagnosticsTruncated: z.boolean(),
  repairJobKind: z.enum(["graph_refresh", "graph_rebuild"]).nullable(),
  details: OverviewGraphHealthDetailsSchema,
}).strict();

const overviewWikiAvailable = z.object({
  availability: z.literal("available"),
  observedAt: HubIsoTimestampSchema,
  status: z.enum(["healthy", "degraded"]),
  summary: z.string().min(1).max(1_024),
  diagnostics: z.array(HubDiagnosticSchema).max(HUB_LIMITS.maxDiagnosticCount),
  diagnosticsTruncated: z.boolean(),
  repairJobKind: z.enum(["wiki_refresh", "wiki_rebuild"]).nullable(),
  details: OverviewWikiHealthDetailsSchema,
}).strict();

export const OverviewContextPanelSchema = z.union([
  z.object({
    availability: z.literal("available"),
    observedAt: HubIsoTimestampSchema,
    graph: z.discriminatedUnion("availability", [overviewGraphAvailable, overviewUnavailablePanel]),
    wiki: z.discriminatedUnion("availability", [overviewWikiAvailable, overviewUnavailablePanel]),
  }).strict().superRefine((value, context) => {
    if (value.graph.availability === "unavailable" && value.wiki.availability === "unavailable") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "An available Overview context panel requires one available index source.",
      });
    }
  }),
  overviewUnavailablePanel,
]);

export const OverviewOperationPanelSchema = z.discriminatedUnion("availability", [
  z.object({
    availability: z.literal("available"),
    observedAt: HubIsoTimestampSchema,
    active: HubJobSnapshotSchema.nullable(),
    latestRelevantFailure: HubJobSnapshotSchema.nullable(),
  }).strict(),
  overviewUnavailablePanel,
]);

/** Bounded dashboard aggregate; it is intentionally separate from the shell. */
export const OverviewResponseSchema = z.object({
  observedAt: HubIsoTimestampSchema,
  shell: HomeResponseSchema,
  identity: OverviewIdentityPanelSchema,
  focus: OverviewFocusPanelSchema,
  activity: OverviewActivityPanelSchema,
  context: OverviewContextPanelSchema,
  operation: OverviewOperationPanelSchema,
  /** Signals for asking about team sharing again; no Relay or author details. */
  sharing: z.object({
    relayPublished: z.boolean(),
    moreThanOneContributor: z.boolean(),
  }).strict().optional(),
}).strict();

export type OverviewIdentityPanel = z.infer<typeof OverviewIdentityPanelSchema>;
export type OverviewFocusIdentitySource = z.infer<typeof OverviewFocusIdentitySourceSchema>;
export type OverviewFocusInboxSource = z.infer<typeof OverviewFocusInboxSourceSchema>;
export type OverviewFocusRelaySource = z.infer<typeof OverviewFocusRelaySourceSchema>;
export type OverviewFocusPanel = z.infer<typeof OverviewFocusPanelSchema>;
export type OverviewActivityPanel = z.infer<typeof OverviewActivityPanelSchema>;
export type OverviewGraphHealthDetails = z.infer<typeof OverviewGraphHealthDetailsSchema>;
export type OverviewWikiHealthDetails = z.infer<typeof OverviewWikiHealthDetailsSchema>;
export type OverviewContextPanel = z.infer<typeof OverviewContextPanelSchema>;
export type OverviewOperationPanel = z.infer<typeof OverviewOperationPanelSchema>;
export type OverviewResponse = z.infer<typeof OverviewResponseSchema>;
