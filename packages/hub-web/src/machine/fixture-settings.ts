import type { MachineProject } from "@mex/hub-contracts/machine";
import type { FixtureVariant } from "./fixtures";
import type { MachineSettings, MachineStorage, MachineUninstallPreview, SettingsWrite } from "./types";

const dayMs = 86_400_000;
const reportFields = [
  "schema_version", "source", "mex_version", "os", "installation_id", "$process_person_profile", "$geoip_disable",
];

const storage: MachineStorage = {
  recordBytes: 92_000_000,
  hooksBytes: 244_000_000,
  indexes: [
    { repoId: "storefront", repo: "Storefront", bytes: 462_000_000 },
    { repoId: "design-kit", repo: "Design kit", bytes: 238_000_000 },
    { repoId: "docs-site", repo: "Docs site", bytes: 105_000_000 },
  ],
  notesBytes: 57_000_000,
  telemetryBytes: 2_000_000,
  totalBytes: 1_200_000_000,
  retention: { deliveryDays: 30, captureDays: 90, captureMegabytes: 200 },
};

function uninstallPreview(dataSize: number): MachineUninstallPreview {
  const claude = "~/.claude/settings.json";
  const codex = "~/.codex/hooks.json";
  const bin = "~/.mex/bin";
  const localExclude = "/work/storefront/.git/info/exclude";
  return {
    changes: [
      {
        id: "claude-session", group: "Claude Code", path: claude, entry: "Session hooks",
        before: "~/.local/bin/session-log",
        mexValue: "~/.local/bin/session-log + mex-hook for SessionStart, SessionEnd, Stop",
        restores: "~/.local/bin/session-log",
      },
      {
        id: "claude-tools", group: "Claude Code", path: claude, entry: "Tool hooks",
        before: null, mexValue: "mex-hook claude-code · PreToolUse, PostToolUse, PostToolUseFailure, PostToolBatch", restores: "Remove 4 MEX entries",
      },
      {
        id: "claude-context", group: "Claude Code", path: claude, entry: "Prompt and context hooks",
        before: null, mexValue: "mex-hook claude-code · UserPromptSubmit, PreCompact, PostCompact, SubagentStart, InstructionsLoaded", restores: "Remove 5 MEX entries",
      },
      {
        id: "codex-session", group: "Codex", path: codex, entry: "Session hooks",
        before: null, mexValue: "mex-hook codex · SessionStart, SessionEnd, Stop, SubagentStart", restores: "Remove 4 MEX entries",
      },
      {
        id: "codex-context", group: "Codex", path: codex, entry: "Prompt, tool and context hooks",
        before: null, mexValue: "mex-hook codex · UserPromptSubmit, PreToolUse, PostToolUse, PreCompact, PostCompact", restores: "Remove 5 MEX entries",
      },
      {
        id: "codex-compaction", group: "Codex", path: "/work/storefront/.codex/config.toml", entry: "model_auto_compact_token_limit",
        before: "96,000 tokens", mexValue: "128,000 tokens", restores: "96,000 tokens",
      },
      ...[
        ["mex-hook", "Hook executable", "MEX 0.9.0 executable · 7.4 MB"],
        ["mex-hook.cjs", "Fallback hook", "MEX 0.9.0 script · 18 KB"],
        ["launcher.json", "Launch configuration", "entry: /opt/homebrew/lib/node_modules/mex-agent/dist/cli.js"],
      ].map(([file, entry, mexValue]) => ({
        id: file, group: "MEX runtime", path: bin + "/" + file, entry,
        before: null, mexValue, restores: "Remove file",
      })),
      ...[
        ["storefront", localExclude],
        ["storefront-checkout", "/work/storefront-checkout/.git/info/exclude"],
        ["design-kit", "/work/design-kit/.git/info/exclude"],
      ].map(([id, path]) => ({
        id, group: "Git exclude entries", path, entry: "MEX repo-start block",
        before: null, mexValue: "/.mex/*\n!/.mex/learned/\n!/.mex/handoffs/\n!/.mex/config.json\n!/.mex/sources.json\n!/.mex/native.json",
        restores: "Remove the repo-start block",
      })),
    ],
    notRemoved: [
      { path: "/work/storefront/.claude/rules/mex-local.md", kind: "personalRule" },
      { path: "/work/storefront/AGENTS.md", kind: "personalRule" },
      { path: localExclude, kind: "gitExclude" },
    ],
    dataPath: "~/.mex",
    dataSize,
  };
}

export function fixtureSettings(now: number, variant: FixtureVariant, projects: MachineProject[], ai: MachineSettings["ai"]) {
  const relative = (days: number) => new Date(now + days * dayMs).toISOString();
  const localTime = (hour: number, minute = 0) => {
    const value = new Date(now);
    value.setHours(hour, minute, 0, 0);
    return value;
  };
  const until = localTime(15);
  if (until.getTime() <= now) until.setDate(until.getDate() + 1);
  const started = localTime(9, 2);
  if (started.getTime() > now) started.setDate(started.getDate() - 1);
  const forcedOff = variant === "settings-forced-off";
  const reports: [string, string[]][] = [
    ["daily", ["counts", "agents", "by_agent"]],
    ["daily", ["counts", "agents", "by_agent"]],
    ["setup.finished", ["agents", "duration", "outcome", "project_id"]],
    ["daily", ["counts", "agents", "by_agent"]],
    ["install.first_run", ["agents"]],
  ];
  const settings: MachineSettings = {
    browser: { signOut: { source: "default" }, signOutEverywhere: { source: "default" } },
    everywhere: { enabled: true, source: "default" },
    capture: { enabled: true, source: "default" },
    repos: projects.map(({ id, name, shared, checkouts }) => ({
      id, name,
      checkouts: checkouts.map(({ path, state, exists }) => ({
        path, source: "checkout",
        power: path === "/work/storefront-checkout"
          ? { state: "offUntil", until: until.toISOString() }
          : state === "off" ? { state: "off" } : { state: "on" },
        disabledReason: exists ? undefined : "This checkout is missing from disk.",
      })),
      capture: {
        enabled: id !== "design-kit", source: id === "design-kit" ? "repo" : "default",
        disabledReason: checkouts.some(({ exists }) => exists) ? undefined : "No checkout for this repo is on disk.",
      },
      sharing: {
        mode: id === "storefront" ? "automatic" : "manual", source: shared ? "repo" : "policy",
        disabledReason: shared ? undefined : "This repo hasn’t been shared with MEX.",
      },
      weekly: shared ? { nextRunAt: relative(id === "storefront" ? 7 : 9) } : null,
    })),
    ai,
    telemetry: forcedOff
      ? { enabled: false, source: "environment", disabledReason: "Off because DO_NOT_TRACK is set" }
      : { enabled: true, source: "global" },
    outbound: {
      telemetry: reports.map(([event, fields], index) => ({
        id: "report-" + index, at: relative(-index - 1), event, fields: [...reportFields, ...fields],
      })),
      modelCalls: [
        { id: "model-1", at: relative(-0.1), purpose: "Check a learned rule", tokens: 2_940, estimated: false, agent: "Claude Code" },
        { id: "model-2", at: relative(-0.6), purpose: "Learn deeper", tokens: 16_420, estimated: true, agent: "Codex" },
        { id: "model-3", at: relative(-1.3), purpose: "Learn from a review", tokens: 8_760, estimated: false, agent: "Claude Code" },
        { id: "model-4", at: relative(-2.5), purpose: "Check a learned rule", tokens: 2_150, estimated: false, agent: "Codex" },
      ],
    },
    hints: { active: 14, confirmed: 6, expiryMonths: 6, source: "default" },
    storage,
    about: {
      version: "0.9.0", homePath: "/Users/sam/.mex", hubMode: "background",
      background: { startedAt: started.toISOString(), version: "0.9.0" },
    },
  };

  return { settings, uninstall: uninstallPreview(storage.totalBytes) };
}

export function updateFixtureSettings(settings: MachineSettings, request: Exclude<SettingsWrite, { type: "signOut" }>): MachineSettings {
  switch (request.type) {
    case "globalPower":
      return { ...settings, everywhere: { enabled: request.enabled, source: "global" } };
    case "telemetry":
      return settings.telemetry.disabledReason ? settings : { ...settings, telemetry: { enabled: request.enabled, source: "global" } };
    case "checkoutPower":
      return {
        ...settings,
        repos: settings.repos.map((repo) => ({
          ...repo, checkouts: repo.checkouts.map((checkout) => checkout.path === request.path && !checkout.disabledReason
            ? { ...checkout, power: request.power }
            : checkout),
        })),
      };
    case "capture":
      if (!request.repoId) return { ...settings, capture: { enabled: request.enabled, source: "global" } };
      return {
        ...settings,
        repos: settings.repos.map((repo) => repo.id === request.repoId && !repo.capture.disabledReason
          ? { ...repo, capture: { enabled: request.enabled, source: "repo" } }
          : repo),
      };
    case "sharing":
      return {
        ...settings,
        repos: settings.repos.map((repo) => repo.id === request.repoId && !repo.sharing.disabledReason
          ? { ...repo, sharing: { mode: request.mode, source: "repo" } }
          : repo),
      };
  }
}
