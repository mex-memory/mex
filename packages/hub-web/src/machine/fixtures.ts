import type { MachineProject, MachineSession } from "@mex/hub-contracts/machine";
import type { HomeOverview, HubJob, KnowledgeStatusCounts } from "./types";

export type FixtureVariant = "home" | "populated" | "empty" | "stale" | "updating";

interface HubFixture {
  session: MachineSession;
  projects: MachineProject[];
  overview: HomeOverview;
  jobs: readonly HubJob[];
}

const session = {
  csrfToken: "fixture",
  expiresAt: "2027-01-01T00:00:00Z",
  mode: "background",
  version: __MEX_HUB_VERSION__,
} satisfies MachineSession;

const projects = [
  {
    id: "storefront",
    name: "Storefront",
    kind: "git",
    shared: true,
    provisional: null,
    checkouts: [
      { path: "/work/storefront", state: "on", offUntil: null, exists: true },
      { path: "/work/storefront-checkout", state: "off", offUntil: null, exists: true },
    ],
  },
  {
    id: "design-kit",
    name: "Design kit",
    kind: "git",
    shared: true,
    provisional: null,
    checkouts: [{ path: "/work/design-kit", state: "on", offUntil: null, exists: true }],
  },
  {
    id: "docs-site",
    name: "Docs site",
    kind: "git",
    shared: false,
    provisional: "shallow",
    checkouts: [{ path: "/work/docs-site", state: "off", offUntil: null, exists: false }],
  },
] satisfies MachineProject[];

const week = { percent: 1.2, capPercent: 3 };

function statuses(upToDate: number, codeChanged = 0, outOfDate = 0, notChecked = 0): KnowledgeStatusCounts {
  return { upToDate, codeChanged, outOfDate, notChecked };
}

const knowledge: HomeOverview["knowledge"] = {
  storefront: {
    total: 20, ...statuses(15, 2, 1, 2), onlyYou: 7, team: 13,
    byKind: {
      rule: statuses(5, 1, 0, 1),
      recipe: statuses(3, 1),
      decision: statuses(3),
      pitfall: statuses(1, 0, 1),
      procedure: statuses(2, 0, 0, 1),
      fact: statuses(1),
    },
  },
  "design-kit": {
    total: 10, ...statuses(8, 1, 0, 1), onlyYou: 2, team: 8,
    byKind: { rule: statuses(5, 1), recipe: statuses(2), decision: statuses(1, 0, 0, 1) },
  },
  "docs-site": {
    total: 5, ...statuses(4, 0, 0, 1), onlyYou: 5, team: 0,
    byKind: { rule: statuses(2, 0, 0, 1), fact: statuses(2) },
  },
};

function waitingRules(now: number): HomeOverview["needs"] {
  const ago = (days: number) => new Date(now - days * 86_400_000).toISOString();
  return [
    { id: "type-check", repoId: "storefront", rule: "Run the type checker before opening a pull request", waitingSince: ago(6) },
    { id: "spacing", repoId: "design-kit", rule: "Use the shared spacing scale in new components", waitingSince: ago(5) },
    { id: "links", repoId: "docs-site", rule: "Check links when moving a page", waitingSince: ago(4) },
    { id: "prices", repoId: "storefront", rule: "Use the shared price formatter at checkout", waitingSince: ago(3) },
    { id: "examples", repoId: "design-kit", rule: "Add a keyboard example for new controls", waitingSince: ago(2) },
    { id: "migrations", repoId: "storefront", rule: "Run migrations against a copy before release", waitingSince: ago(1.5) },
    { id: "fixtures", repoId: "storefront", rule: "Keep real customer names out of test data", waitingSince: ago(1) },
    { id: "alt-text", repoId: "docs-site", rule: "Describe diagrams in their image captions", waitingSince: ago(0.25) },
  ];
}

function localDay(now: number, daysAgo: number) {
  const date = new Date(now);
  date.setDate(date.getDate() - daysAgo);
  return date;
}

function dayKey(date: Date) {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function recentSessions(now: number): HomeOverview["sessions"] {
  const minutesAgo = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
  const daysAgo = (days: number, hour: number) => {
    const date = localDay(now, days);
    date.setHours(hour, 0, 0, 0);
    return date.toISOString();
  };
  return [
    { id: "storefront-review", agent: "Claude Code", repoId: "storefront", at: minutesAgo(42), gave: 6, heldBack: 2, replaced: 0 },
    { id: "design-kit-spacing", agent: "Codex", repoId: "design-kit", at: minutesAgo(180), gave: 4, heldBack: 0, replaced: 0 },
    { id: "storefront-schema", agent: "Claude Code", repoId: "storefront", at: minutesAgo(300), gave: 3, heldBack: 0, replaced: 0 },
    { id: "docs-site-guide", agent: "Codex", repoId: "docs-site", at: minutesAgo(24 * 60), gave: 0, heldBack: 0, replaced: 0 },
    { id: "design-kit-controls", agent: "Claude Code", repoId: "design-kit", at: minutesAgo(25 * 60), gave: 5, heldBack: 2, replaced: 0 },
    { id: "storefront-fixtures", agent: "Codex", repoId: "storefront", at: minutesAgo(26 * 60), gave: 4, heldBack: 0, replaced: 2 },
    { id: "storefront-cart", agent: "Claude Code", repoId: "storefront", at: daysAgo(2, 17), gave: 12, heldBack: 4, replaced: 1 },
    { id: "storefront-tests", agent: "Codex", repoId: "storefront", at: daysAgo(2, 15), gave: 8, heldBack: 4, replaced: 0 },
    { id: "design-kit-menu", agent: "Codex", repoId: "design-kit", at: daysAgo(2, 13), gave: 6, heldBack: 3, replaced: 2 },
    { id: "storefront-api", agent: "Claude Code", repoId: "storefront", at: daysAgo(3, 16), gave: 7, heldBack: 2, replaced: 0 },
    { id: "design-kit-forms", agent: "Codex", repoId: "design-kit", at: daysAgo(3, 14), gave: 4, heldBack: 2, replaced: 0 },
    { id: "docs-site-nav", agent: "Codex", repoId: "docs-site", at: daysAgo(3, 10), gave: 3, heldBack: 1, replaced: 1 },
    { id: "design-kit-input", agent: "Codex", repoId: "design-kit", at: daysAgo(5, 15), gave: 8, heldBack: 3, replaced: 0 },
    { id: "storefront-release", agent: "Claude Code", repoId: "storefront", at: daysAgo(5, 12), gave: 12, heldBack: 7, replaced: 1 },
    { id: "storefront-price", agent: "Claude Code", repoId: "storefront", at: daysAgo(6, 16), gave: 7, heldBack: 3, replaced: 0 },
    { id: "design-kit-docs", agent: "Codex", repoId: "design-kit", at: daysAgo(6, 12), gave: 2, heldBack: 1, replaced: 0 },
  ];
}

function homeMetrics(now: number, sessions: HomeOverview["sessions"]) {
  const activity = Array.from({ length: 7 }, (_, index) => ({
    day: dayKey(localDay(now, 6 - index)), sessions: 0, gave: 0, heldBack: 0, replaced: 0,
  }));
  const byDay = new Map(activity.map((day) => [day.day, day]));
  const agents = new Set<string>();
  for (const session of sessions) {
    const day = byDay.get(dayKey(new Date(session.at)));
    if (!day) continue;
    agents.add(session.agent);
    day.sessions += 1;
    day.gave += session.gave;
    day.heldBack += session.heldBack;
    day.replaced += session.replaced;
  }
  return { activity, agents: [...agents], week };
}

function fixtureTime(hour: number, minute: number, daysAgo = 0) {
  const date = localDay(Date.now(), daysAgo);
  date.setHours(hour, minute, 0, 0);
  return date.toISOString();
}

const jobs: readonly HubJob[] = [
  {
    id: "storefront-map", repoId: "storefront", label: "Building the code map", kind: "Code map",
    state: { phase: "running" }, activity: "Reading 412 of 1,180 files", progress: { completed: 412, total: 1_180 },
    result: { verb: "Mapped", count: 412, unit: "file" }, cost: null, started: fixtureTime(15, 16),
  },
  {
    id: "storefront-learn", repoId: "storefront", label: "Learning from your code", kind: "Deeper learning",
    state: { phase: "running" }, activity: "Reading recent pull requests",
    result: { verb: "Learned", count: 9, unit: "rule" },
    cost: { usedTokens: 12_400, estimatedTokens: 40_000 }, started: fixtureTime(15, 8),
  },
  {
    id: "design-kit-check", repoId: "design-kit", label: "Checking what MEX knows", kind: "Knowledge check",
    state: { phase: "paused" }, activity: "Read button styles",
    result: { verb: "Checked", count: 5, unit: "rule" }, cost: null, started: fixtureTime(14, 54),
  },
  {
    id: "design-kit-learn", repoId: "design-kit", label: "Learning from code changes", kind: "Deeper learning",
    state: { phase: "waiting", reason: "you're coding — resumes when idle" },
    activity: "Waiting to read recent changes", cost: { estimatedTokens: 24_000 }, started: fixtureTime(14, 41),
  },
  {
    id: "storefront-check", repoId: "storefront", label: "Checking shared rules", kind: "Knowledge check",
    state: { phase: "waiting", reason: "offline" }, activity: "Waiting to read shared rules",
    result: { verb: "Checked", count: 4, unit: "rule" }, cost: null, started: fixtureTime(14, 28),
  },
  {
    id: "design-kit-map", repoId: "design-kit", label: "Updating the code map", kind: "Code map",
    state: { phase: "queued" }, cost: null, started: fixtureTime(14, 12),
  },
  {
    id: "storefront-tests", repoId: "storefront", label: "Learning from your tests", kind: "Deeper learning",
    state: { phase: "queued" }, cost: { estimatedTokens: 38_000, startsWhenIdle: true }, started: fixtureTime(14, 4),
  },
  {
    id: "storefront-rules", repoId: "storefront", label: "Checking checkout rules", kind: "Knowledge check",
    state: { phase: "done" }, activity: "Finished checking checkout rules",
    result: { verb: "Checked", count: 12, unit: "rule" }, cost: null, started: fixtureTime(11, 22),
  },
  {
    id: "design-kit-examples", repoId: "design-kit", label: "Mapping component examples", kind: "Code map",
    state: { phase: "doneWithGaps" }, activity: "Skipped 4 files that couldn’t be opened",
    result: { verb: "Mapped", count: 72, unit: "file" }, cost: null, started: fixtureTime(10, 42),
  },
  {
    id: "docs-site-map", repoId: "docs-site", label: "Building the code map", kind: "Code map",
    state: { phase: "failed", cause: "couldn’t read the repo folder", identicalFailures: 3 },
    activity: "The same problem happened 3 times", cost: null, started: fixtureTime(16, 18, 1),
  },
  {
    id: "design-kit-rules", repoId: "design-kit", label: "Learning component rules", kind: "Deeper learning",
    state: { phase: "stopped" }, result: { verb: "Learned", count: 9, unit: "rule" },
    cost: { usedTokens: 10_600, estimatedTokens: 28_000 }, started: fixtureTime(15, 14, 1),
  },
];

export function getFixture(variant: FixtureVariant): HubFixture {
  const now = Date.now();
  const generatedAt = new Date(now - 120_000).toISOString();
  if (variant === "empty") {
    return {
      session,
      projects: [],
      overview: { ...homeMetrics(now, []), week: { ...week, percent: 0 }, generatedAt, byRepo: {}, needs: [], needsCount: {}, knowledge: {}, sessions: [] },
      jobs: [],
    };
  }
  const scopedKnowledge = variant === "stale" || variant === "updating"
    ? Object.fromEntries(Object.entries(knowledge).map(([id, summary]) => (
      [id, { ...summary, updatingSince: new Date(now).toISOString() }]
    )))
    : knowledge;
  const sessions = recentSessions(now);
  const byRepo = Object.fromEntries(projects.map(({ id }) => (
    [id, homeMetrics(now, sessions.filter(({ repoId }) => id === repoId))]
  )));
  const needs = waitingRules(now);
  const needsCount: Record<string, { count: number; oldest: string }> = {};
  for (const { repoId, waitingSince } of needs) {
    const count = (needsCount[repoId]?.count ?? 0) + 1;
    needsCount[repoId] = { count, oldest: needsCount[repoId]?.oldest ?? waitingSince };
  }
  return {
    session, projects, jobs,
    overview: { ...homeMetrics(now, sessions), generatedAt, byRepo, needs, needsCount, knowledge: scopedKnowledge, sessions },
  };
}
