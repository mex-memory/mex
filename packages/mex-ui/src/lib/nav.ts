/**
 * Client-side routes for the companion UI. The server falls unknown paths
 * through to index.html, so a reload on /health still lands on Health.
 */

export const ROUTES = {
  home: "/",
  setup: "/setup",
  setupWizard: "/setup/wizard",
  health: "/health",
  graph: "/graph",
  activity: "/activity",
  settings: "/settings",
} as const;

export type NavId = "dashboard" | "setup" | "health" | "graph" | "activity" | "settings";

export interface NavItem {
  id: NavId;
  label: string;
  path: string;
}

export const NAV_ITEMS: readonly NavItem[] = [
  { id: "dashboard", label: "Dashboard", path: ROUTES.home },
  { id: "setup", label: "Setup", path: ROUTES.setup },
  { id: "health", label: "Health", path: ROUTES.health },
  { id: "graph", label: "Graph", path: ROUTES.graph },
  { id: "activity", label: "Activity", path: ROUTES.activity },
  { id: "settings", label: "Settings", path: ROUTES.settings },
];

/**
 * Which sidebar item is current. `/setup/wizard` stays under Setup so the
 * highlight does not jump while the user is in the wizard.
 */
export function activeNav(path: string): NavId {
  if (path === ROUTES.setup || path.startsWith(`${ROUTES.setup}/`)) return "setup";
  if (path === ROUTES.health) return "health";
  if (path === ROUTES.graph) return "graph";
  if (path === ROUTES.activity) return "activity";
  if (path === ROUTES.settings) return "settings";
  return "dashboard";
}

export function isSetupWizard(path: string): boolean {
  return path === ROUTES.setupWizard;
}
