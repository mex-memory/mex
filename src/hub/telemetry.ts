import { z } from "zod";
import type { TelemetryAttributes } from "../telemetry/schema.js";

// Browser input is deliberately a category, never a URL, identifier, or event
// payload. The transport performs its own independent final allowlist check.
export const HubPageViewSchema = z.object({
  page: z.enum([
    "home", "search", "knowledge", "knowledge_detail", "code", "code_symbol",
    "workstreams", "specs", "spec_detail", "playbooks", "catch_up", "inbox",
    "relays", "members", "activity", "jobs", "health", "settings", "setup", "not_found",
  ]),
}).strict();

export const HubTeamAccessEventSchema = z.object({
  step: z.enum(["card_viewed", "button_clicked", "dialog_opened", "submitted"]),
}).strict();

export type HubTelemetrySink = (
  name: "hub.session_started" | "hub.page_viewed" | "hub.action_completed" | "hub.job_completed" | "hub.team_access",
  attributes: TelemetryAttributes,
) => void;

export const HUB_PAGE_EVENT_BODY_BYTES = 128;
const PAGE_EVENTS_PER_MINUTE = 60;
const MAX_DURATION_MS = 86_400_000;

/** Optional sink keeps embedded apps, fixtures, and ordinary read tests quiet. */
export class HubTelemetry {
  private pageWindowStart = 0;
  private pageWindowCount = 0;

  constructor(
    private readonly sink?: HubTelemetrySink,
    private readonly now: () => number = Date.now,
  ) {}

  pageViewed(page: z.infer<typeof HubPageViewSchema>["page"]): void {
    if (this.withinBrowserEventLimit()) emitHubTelemetry(this.sink, "hub.page_viewed", { page });
  }

  teamAccess(step: z.infer<typeof HubTeamAccessEventSchema>["step"]): void {
    if (this.withinBrowserEventLimit()) emitHubTelemetry(this.sink, "hub.team_access", { step });
  }

  /** Browser-reported events share one per-minute budget. */
  private withinBrowserEventLimit(): boolean {
    if (!this.sink) return false;
    const now = this.now();
    if (now < this.pageWindowStart || now - this.pageWindowStart >= 60_000) {
      this.pageWindowStart = now;
      this.pageWindowCount = 0;
    }
    // One process-wide counter: no session, user, URL, or growing key map.
    if (this.pageWindowCount >= PAGE_EVENTS_PER_MINUTE) return false;
    this.pageWindowCount += 1;
    return true;
  }

  async action<T>(
    action: string,
    stage: "preview" | "apply" | "direct",
    run: () => T | Promise<T>,
    replayed?: (result: T) => boolean,
  ): Promise<T> {
    if (!this.sink) return run();
    const started = this.now();
    try {
      const result = await run();
      emitHubTelemetry(this.sink, "hub.action_completed", {
        action, stage, outcome: "success", duration_ms: boundedHubDuration(this.now() - started),
        ...(stage === "apply" && replayed ? { replayed: replayed(result) } : {}),
      });
      return result;
    } catch (error) {
      emitHubTelemetry(this.sink, "hub.action_completed", {
        action, stage, outcome: "failure", duration_ms: boundedHubDuration(this.now() - started),
      });
      throw error;
    }
  }
}

export function boundedHubDuration(duration: number): number {
  return Number.isFinite(duration) ? Math.min(MAX_DURATION_MS, Math.max(0, Math.round(duration))) : 0;
}

export function emitHubTelemetry(
  sink: HubTelemetrySink | undefined,
  name: Parameters<HubTelemetrySink>[0],
  attributes: Parameters<HubTelemetrySink>[1],
): void {
  try { sink?.(name, attributes); } catch { /* Observability never changes Hub behavior. */ }
}
