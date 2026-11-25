import type { FixtureReviewQueue } from "./types";
import type { MachineProject, MachineSession, MachineSetup } from "@mex/hub-contracts/machine";
import { fixtureHomeReview, fixtureReviewQueue } from "./fixture-review-data";
import { fixtureAgents } from "./fixture-agents";
import { fixtureSettings } from "./fixture-settings";
import { fixtureSetup, fixtureSetupJobs, localSetupProject } from "./fixture-setup";
import type { ForgottenItem, HomeOverview, HubJob, KnowledgeDetail, KnowledgeStatusCounts } from "./types";

export type FixtureVariant = "home" | "populated" | "empty" | "stale" | "updating" | "conflict" | "calm"
  | "review-empty" | "review-handled" | "review-handled-unknown" | "review-busy" | "review-loading"
  | "agents-broken" | "agents-terminal" | "settings-forced-off" | "setup";

export interface KnowledgeFixture {
  items: readonly KnowledgeDetail[];
  forgotten: readonly ForgottenItem[];
  generatedAt: string;
  updatingSince?: string;
}

interface HubFixture {
  session: MachineSession;
  projects: MachineProject[];
  overview: HomeOverview;
  jobs: readonly HubJob[];
  knowledge: KnowledgeFixture;
  review?: FixtureReviewQueue;
  agents: ReturnType<typeof fixtureAgents>;
  settings: ReturnType<typeof fixtureSettings>;
  setup?: MachineSetup;
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

type NoteSeed = readonly [
  id: string,
  kind: KnowledgeDetail["kind"],
  audience: KnowledgeDetail["audience"],
  status: KnowledgeDetail["status"],
  oneLine: string,
  text: string,
  scope?: string[],
];

const storefrontNotes: readonly NoteSeed[] = [
  ["checkout", "rule", "onlyYou", "upToDate", "Validate checkout inputs at the API boundary",
    "Return field errors before loading the cart or calling the payment provider.\n\nUse one schema for guest and signed-in checkout.", ["apps/api/**"]],
  ["checkout", "rule", "team", "codeChanged", "Keep the checkout total in integer cents",
    "Calculate and store the checkout total in integer cents. Format it for display only when rendering the order summary.\n\nSend the total in cents to the payment provider so the amount charged matches the amount stored.", ["apps/api/**", "packages/money/**"]],
  ["sandbox", "recipe", "team", "upToDate", "Reproduce a checkout failure with the payment sandbox",
    "Seed a guest cart and use the sandbox’s declined-card example. Check that the cart is still open and the retry button stays available.", ["apps/web/**"]],
  ["carttxn", "decision", "team", "upToDate", "Keep cart and payment changes in separate transactions",
    "Persist cart changes before contacting the payment provider. Record the payment outcome in a second transaction so provider timeouts cannot hold the cart lock."],
  ["oldseed", "pitfall", "onlyYou", "outOfDate", "Avoid reusing checkout fixtures after a schema change",
    "Regenerate the checkout fixtures when the order schema changes. Old fixtures can hide a required field because they bypass the request parser."],
  ["smoketest", "procedure", "team", "upToDate", "Run the checkout smoke test before tagging a release",
    "Place a sandbox order in staging and confirm the order reference appears in both the dashboard and the confirmation email."],
  ["taxcalc", "fact", "team", "upToDate", "The checkout tax total is calculated on the server",
    "The order API returns the tax total with the cart estimate. The web app displays that amount directly."],
  ["anonfixtures", "rule", "team", "upToDate", "Keep real customer names out of test fixtures",
    "Use generated customer details in seed data, snapshots, and examples shared with support."],
  ["guestcart", "recipe", "onlyYou", "codeChanged", "Use the checkout seed when testing the guest cart",
    "Load the guest checkout seed before running the cart spec. It fills in the shipping region and starts the cart without an account.", ["apps/web/**", "apps/api/src/checkout.ts"]],
  ["retrykey", "rule", "team", "notChecked", "Keep the retry key across checkout requests",
    "Send the original retry key when the customer retries after a timeout. Create a new key after they change the cart."],
  ["snapshot", "decision", "onlyYou", "upToDate", "Start checkout from a saved cart snapshot",
    "Read the frozen cart snapshot when starting checkout. Editing the active cart can then leave an order already in progress alone."],
  ["taxround", "pitfall", "team", "upToDate", "Round tax once after adding the line items",
    "Add the unrounded tax for each line item and round the sum. Rounding each line can shift the total by a cent."],
  ["replay", "recipe", "team", "upToDate", "Use the sandbox webhook to replay a failed payment",
    "Replay the original sandbox event and verify the payment status changes once. Keep the event ID the same to exercise deduplication."],
  ["typecheck", "rule", "team", "upToDate", "Run the type checker before opening a pull request",
    "Run the workspace type check from the repository root. The package test command only checks its own imports."],
  ["migrationresult", "procedure", "onlyYou", "notChecked", "Record the migration result before resuming checkout",
    "Note the row counts and the last applied migration in the release checklist before reopening checkout."],
  ["apiseed", "recipe", "team", "upToDate", "Refresh API fixtures after changing the order schema",
    "Generate fresh fixtures from staging seed data and include the changed payloads with the schema change.", ["apps/api/**", "test/fixtures/orders/*.json"]],
  ["ordernumber", "decision", "team", "upToDate", "Generate order numbers on the server",
    "Assign the order number in the create-order transaction and return it with the completed order."],
  ["refunds", "rule", "onlyYou", "upToDate", "Keep refund inputs consistent across the checkout API and the billing tools that handle partial returns",
    "Use the shared refund input schema for checkout and billing. Keep the original currency and order reference on every partial return.", ["apps/api/**", "tools/billing/**"]],
  ["maskpayment", "rule", "team", "upToDate", "Log masked payment identifiers",
    "Include only the last four characters of the payment identifier in support logs. Use the order reference for joins."],
  ["migrationcopy", "procedure", "onlyYou", "upToDate", "Run migrations against a copy before release",
    "Run the migration on a recent staging copy and record the duration and final row counts in the release checklist."],
  ["taxhint", "hint", "hint", "notChecked", "Check the shipping region before debugging tax",
    "With the guest seed, tax stays at zero until a shipping region is selected."],
  ["retryhint", "hint", "hint", "notChecked", "Replay the original event to investigate duplicate charges",
    "The sandbox replay tool can send the same event ID as the first delivery."],
];

const designKitNotes: readonly NoteSeed[] = [
  ["spacing", "rule", "team", "upToDate", "Use the shared spacing scale in new components",
    "Use the spacing tokens for component padding and gaps. This keeps the same rhythm when a component moves into a denser layout.", ["packages/ui/**"]],
  ["dialogfocus", "rule", "team", "upToDate", "Return focus to the button that opened the dialog",
    "Pass the trigger to the dialog’s focus-return option. When the trigger disappears after an action, focus the next item in the list."],
  ["menufocus", "rule", "team", "codeChanged", "Keep the keyboard focus ring on menu items",
    "Use the focus token for menu items reached by keyboard. Reserve the hover background for the pointer.", ["packages/ui/**"]],
  ["dangercolour", "rule", "onlyYou", "upToDate", "Use the destructive colour for destructive actions",
    "Use the destructive button style for the final delete action. The button that opens the confirmation can stay neutral."],
  ["headings", "rule", "team", "upToDate", "Keep heading sizes independent of component sizes",
    "Pick the heading level based on page structure and the size token based on the layout."],
  ["iconname", "rule", "team", "upToDate", "Name icon buttons with the action they perform",
    "Give icon-only buttons names such as Close or Copy link so their purpose is clear to screen reader users."],
  ["tables", "recipe", "team", "upToDate", "Test compact tables with long labels",
    "Use the customer export example to check labels at narrow widths and at 200% zoom."],
  ["darkforms", "recipe", "team", "upToDate", "Preview form errors in the dark theme",
    "Open the invalid form example in dark mode and check that the error copy and field outline are readable.", ["packages/ui/**"]],
  ["tokens", "decision", "team", "upToDate", "Use semantic colour tokens for control states",
    "Use the success, warning and danger tokens on controls so the same state reads consistently across themes."],
  ["cardpad", "decision", "onlyYou", "notChecked", "Keep card padding on the container",
    "Set horizontal padding on the card so header and body content share the same edge."],
  ["hintmenu", "hint", "hint", "notChecked", "Try the compact menu story when checking keyboard focus",
    "Open Compact menu and use the arrow keys to move the focus ring across the first and last items."],
  ["hintfieldset", "hint", "hint", "notChecked", "Use the field group example for paired date inputs",
    "The field group example shows how to label a date range while retaining a separate label for each input."],
];

const docsNotes: readonly NoteSeed[] = [
  ["movingpages", "rule", "onlyYou", "upToDate", "Check links when moving a page",
    "Run the link checker after moving a page. Add a redirect for the old address when it is linked from a published guide."],
  ["diagrams", "rule", "onlyYou", "upToDate", "Describe diagrams in their image captions",
    "Include the main point of the diagram in its caption so the guide makes sense when the image is unavailable."],
  ["examples", "rule", "onlyYou", "notChecked", "Keep examples runnable without credentials",
    "Use the development sandbox in examples. Put authenticated calls in the separate deployment guide."],
  ["navfile", "fact", "onlyYou", "upToDate", "Sidebar labels come from the navigation file",
    "Change the label in the navigation file when renaming a page in the sidebar."],
  ["redirects", "fact", "onlyYou", "upToDate", "Redirects are read from redirects.json",
    "Give each moved page a single redirect to its new canonical URL.", ["redirects.json"]],
  ["previewhint", "hint", "hint", "notChecked", "Check the generated navigation in a local preview",
    "The local preview lists orphaned pages that do not appear in the navigation file."],
];

function knowledgeFixture(now: number, generatedAt: string, variant: FixtureVariant): KnowledgeFixture {
  if (variant === "empty") return { items: [], forgotten: [], generatedAt };

  const hoursAgo = (hours: number) => new Date(now - hours * 3_600_000).toISOString();
  const noteSets = [
    { repoId: "storefront", checkout: "/work/storefront", file: "apps/api/src/checkout.ts", seeds: storefrontNotes },
    { repoId: "design-kit", checkout: "/work/design-kit", file: "packages/ui/src/index.ts", seeds: designKitNotes },
    { repoId: "docs-site", checkout: "/work/docs-site", file: "docs/navigation.yml", seeds: docsNotes },
  ];
  const items = noteSets.flatMap(({ repoId, checkout, file, seeds }, repoIndex) => seeds.map(
    ([slug, kind, audience, status, oneLine, text, scope = ["**"]], index): KnowledgeDetail => {
      const id = `mx_${slug}`;
      const at = hoursAgo((12 + index) * 24);
      const target = slug === "menufocus" ? "packages/ui/src/menu.tsx" : file;
      const checkedAt = hoursAgo(slug === "menufocus" ? 12 : 2 + index);
      const path = `.mex/learned/${id}.md`;
      const source: KnowledgeDetail["source"] = audience === "team" ? { type: "team", path, checkout }
        : audience === "hint" ? { type: "agent-memory", agent: repoIndex === 1 ? "Codex" : "Claude Code", observations: 3 }
        : { type: "note", at, via: "cli" };
      const history: KnowledgeDetail["history"] = audience === "team"
        ? [{ type: "git", action: "added", actor: "Priya", sha: "a1b2c3d", at }]
        : [{ type: "added", at }];
      const result = { upToDate: "held", codeChanged: "changed", outOfDate: "broken", notChecked: null } as const;
      return {
        id, key: `${repoId}:${audience}:${id}`, repoId, kind, audience, status, oneLine, text, scope,
        revision: "r1", source, history,
        checks: status === "notChecked" ? [] : [{ kind: "source", target, result: result[status], checkedAt }],
        lastUsedAt: audience === "hint" || status === "notChecked" ? null : hoursAgo(2 + index * 3 + repoIndex),
        useCount30Days: audience === "hint" || status === "notChecked" ? 0 : 14 - index % 10,
      };
    },
  ));
  const personal = items[0];
  const team = items[1];
  personal.source = { type: "session", at: hoursAgo(6 * 24), checkedByModel: true };
  personal.evidence = "The provider got an invalid address from guest checkout.";
  personal.checks = [
    { kind: "symbol", target: "parseCheckoutRequest in apps/api/src/checkout.ts", result: "held", checkedAt: hoursAgo(2) },
    { kind: "key", target: "checkout.inputSchema in apps/api/config.json", result: "held", checkedAt: hoursAgo(2) },
  ];
  personal.history = [
    { type: "model-check", outcome: "still true", at: hoursAgo(2) },
    { type: "edited", at: hoursAgo(4 * 24) },
    { type: "model-check", outcome: "still true", at: hoursAgo(5 * 24) },
    { type: "added", at: hoursAgo(6 * 24) },
  ];
  team.checks = [{ kind: "symbol", target: "checkoutTotal in packages/money/src/totals.ts", result: "changed", checkedAt: hoursAgo(18) }];
  team.history = [
    { type: "git", action: "edited", actor: "Mateo", sha: "f42c9ae", at: hoursAgo(4 * 24) },
    { type: "git", action: "added", actor: "Priya", sha: "a1b2c3d", at: hoursAgo(21 * 24) },
  ];
  items[6].history = [
    ...[2, 26, 50, 74, 98, 122].map((hour) => ({
      type: "git" as const, action: "edited" as const, actor: "Priya", sha: (0xce62acd + hour).toString(16), at: hoursAgo(hour),
    })),
    ...items[6].history,
  ];
  // Put a few examples from each repo in the first screenful.
  const featured = [0, 1, 22, 2, 34, 3, 4, 32, 5];
  const ordered = [...featured.map((index) => items[index]), ...items.filter((_, index) => !featured.includes(index))];
  return {
    items: variant === "calm" ? ordered.map((item) => item.status === "outOfDate" || item.status === "codeChanged"
      ? { ...item, status: "upToDate", checks: item.checks.map((check) => ({ ...check, result: "held" })) }
      : item) : ordered,
    forgotten: [
      { id: "mx_legacycart", repoId: "storefront", audience: "onlyYou", at: hoursAgo(8) },
      { id: "mx_oldtokens", repoId: "design-kit", audience: "team", at: hoursAgo(3 * 24) },
      { id: "mx_navhint", repoId: "docs-site", audience: "hint", at: hoursAgo(6 * 24) },
    ],
    generatedAt,
    updatingSince: variant === "stale" || variant === "updating" ? hoursAgo(0) : undefined,
  };
}

export function getFixture(variant: FixtureVariant): HubFixture {
  const now = Date.now();
  const generatedAt = new Date(now - 120_000).toISOString();
  const notes = knowledgeFixture(now, generatedAt, variant);
  const review = fixtureReviewQueue(now, notes.items, variant);
  const waiting = fixtureHomeReview(review);
  const agents = fixtureAgents(now, variant);
  const listedProjects = variant === "setup" ? [...projects, localSetupProject] : projects;
  const settings = fixtureSettings(now, variant, variant === "empty" ? [] : listedProjects, week);
  if (variant === "empty") {
    return {
      session,
      projects: [],
      overview: { ...homeMetrics(now, []), week: { ...week, percent: 0 }, generatedAt, byRepo: {}, needs: [], needsCount: {}, knowledge: {}, sessions: [] },
      jobs: [],
      knowledge: notes,
      review, agents, settings, setup: { repos: [] },
    };
  }
  const scopedKnowledge = variant === "stale" || variant === "updating"
    ? Object.fromEntries(Object.entries(knowledge).map(([id, summary]) => (
      [id, { ...summary, updatingSince: new Date(now).toISOString() }]
    )))
    : knowledge;
  const sessions = recentSessions(now);
  const byRepo = Object.fromEntries(listedProjects.map(({ id }) => (
    [id, homeMetrics(now, sessions.filter(({ repoId }) => id === repoId))]
  )));
  const setup = variant === "setup" ? fixtureSetup(now) : undefined;
  return {
    session, projects: listedProjects, jobs: setup ? fixtureSetupJobs(setup) : jobs,
    knowledge: notes, review, agents, settings, setup,
    overview: { ...homeMetrics(now, sessions), generatedAt, byRepo, ...waiting, knowledge: scopedKnowledge, sessions },
  };
}
