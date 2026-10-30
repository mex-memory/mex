/**
 * One benchmark identity for every operational workbench in Hub AppRoutes.
 *
 * Several routes intentionally share one lazy module. They still receive
 * separate measurements and budgets: this is a per-route contract, not a
 * per-chunk inventory.
 */
export const RELEASE_ROUTE_MANIFEST_HINTS = Object.freeze({
  home: Object.freeze(["HomePage", "hub-contracts/dist/overview"]),
  search: Object.freeze(["SearchPage"]),
  knowledge: Object.freeze(["ContextPage"]),
  knowledgeDetail: Object.freeze(["KnowledgePage"]),
  code: Object.freeze(["SearchPage"]),
  codeSymbol: Object.freeze(["SymbolPage"]),
  workstreams: Object.freeze(["WorkstreamsPage"]),
  diagrams: Object.freeze(["DiagramsPage", "hub-contracts/dist/statechart"]),
  diagramDetail: Object.freeze(["DiagramsPage", "StatechartCanvas", "stateDiagram-v2-", "hub-contracts/dist/statechart"]),
  specs: Object.freeze(["SpecsPage"]),
  specsDetail: Object.freeze(["SpecsPage"]),
  playbooks: Object.freeze(["CapabilityPage"]),
  catchUp: Object.freeze(["CapabilityPage"]),
  inbox: Object.freeze(["InboxPage"]),
  relays: Object.freeze(["RelayPage"]),
  members: Object.freeze(["MembersPage"]),
  activity: Object.freeze(["ActivityPage"]),
  jobs: Object.freeze(["JobsPage"]),
  health: Object.freeze(["HealthPage"]),
  settings: Object.freeze(["SettingsPage"]),
  notFound: Object.freeze(["CapabilityPage"]),
});

export const RELEASE_ROUTE_KEYS = Object.freeze(Object.keys(RELEASE_ROUTE_MANIFEST_HINTS));

// In a completed project, /setup only replaces the URL with Home. The setup
// wizard is a separate lazy application boundary and has its own asset checks.
export const RELEASE_ROUTE_REDIRECTS = Object.freeze({ setup: "/" });

export const RELEASE_ROUTE_PATTERNS = Object.freeze({
  home: "(index)",
  search: "search",
  knowledge: "knowledge",
  knowledgeDetail: "knowledge/:id",
  code: "code",
  codeSymbol: "code/symbols/:id",
  workstreams: "workstreams",
  diagrams: "diagrams",
  diagramDetail: "diagrams/:kind/:id",
  specs: "specs",
  specsDetail: "specs/:id",
  playbooks: "playbooks",
  catchUp: "catch-up",
  inbox: "inbox",
  relays: "relays",
  members: "members",
  activity: "activity",
  jobs: "jobs",
  health: "health",
  settings: "settings",
  notFound: "*",
});

export function releaseWorkbenchPaths({ knowledgeEntityId, specEntityId, codeSymbolId }) {
  const knowledgeId = boundedIdentifier(knowledgeEntityId, "Knowledge entity");
  const specId = boundedIdentifier(specEntityId, "Spec entity");
  const symbolId = boundedIdentifier(codeSymbolId, "Code symbol");
  return {
    home: "/",
    search: "/search?q=releaseBenchmarkNeedle",
    knowledge: "/knowledge",
    knowledgeDetail: `/knowledge/${encodeURIComponent(knowledgeId)}`,
    code: "/code?q=releaseBenchmarkNeedle",
    codeSymbol: `/code/symbols/${encodeURIComponent(symbolId)}`,
    workstreams: "/workstreams",
    diagrams: "/diagrams",
    diagramDetail: `/diagrams/saved/${"d".repeat(32)}`,
    specs: "/specs",
    specsDetail: `/specs/${encodeURIComponent(specId)}`,
    playbooks: "/playbooks",
    catchUp: "/catch-up",
    inbox: "/inbox",
    relays: "/relays",
    members: "/members",
    activity: "/activity",
    jobs: "/jobs",
    health: "/health",
    settings: "/settings",
    notFound: "/release-benchmark-not-found",
  };
}

function boundedIdentifier(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) {
    throw new Error(`${label} ID must contain between 1 and 512 characters.`);
  }
  return value;
}
