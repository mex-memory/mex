const PAGE_ROUTES = {
  "/": "home", "/search": "search", "/knowledge": "knowledge", "/code": "code",
  "/workstreams": "workstreams", "/specs": "specs", "/playbooks": "playbooks",
  "/catch-up": "catch_up", "/inbox": "inbox", "/relays": "relays", "/members": "members",
  "/activity": "activity", "/jobs": "jobs", "/health": "health", "/settings": "settings",
  "/setup": "setup",
} as const;

export type HubTelemetryPage = typeof PAGE_ROUTES[keyof typeof PAGE_ROUTES]
  | "knowledge_detail" | "code_symbol" | "spec_detail" | "not_found";

const PAGES = new Set<string>([...Object.values(PAGE_ROUTES), "knowledge_detail", "code_symbol", "spec_detail", "not_found"]);

export function isHubTelemetryPage(page: unknown): page is HubTelemetryPage {
  return typeof page === "string" && PAGES.has(page);
}

/** Team-access card steps, counted without anything the person typed. */
export const HUB_TEAM_ACCESS_STEPS = ["card_viewed", "button_clicked", "dialog_opened", "submitted"] as const;
export type HubTeamAccessStep = typeof HUB_TEAM_ACCESS_STEPS[number];

export function isHubTeamAccessStep(step: unknown): step is HubTeamAccessStep {
  return typeof step === "string" && (HUB_TEAM_ACCESS_STEPS as readonly string[]).includes(step);
}

/** Reduce locally before serialization; identifiers never enter the payload. */
export function hubPageCategory(pathname: string): HubTelemetryPage {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (Object.hasOwn(PAGE_ROUTES, path)) return PAGE_ROUTES[path as keyof typeof PAGE_ROUTES];
  if (/^\/knowledge\/[^/]+$/.test(path)) return "knowledge_detail";
  if (/^\/code\/symbols\/[^/]+$/.test(path)) return "code_symbol";
  if (/^\/specs\/[^/]+$/.test(path)) return "spec_detail";
  return "not_found";
}
