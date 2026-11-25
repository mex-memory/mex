import type { FixtureVariant } from "./fixtures";
import type { AgentRepairPreview, MachineAgent } from "./types";

const claudeEvents = [
  "SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "PostToolBatch",
  "PreCompact", "PostCompact", "SubagentStart", "Stop", "SessionEnd", "InstructionsLoaded",
];
const codexEvents = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PreCompact", "PostCompact", "SubagentStart", "Stop", "SessionEnd"];
const copilotEvents = ["sessionStart", "userPromptSubmitted", "preToolUse", "postToolUse", "postToolUseFailure", "preCompact", "subagentStart", "agentStop", "sessionEnd"];

const claudeConfig = "~/.claude/settings.json";
const codexConfig = "~/.codex/hooks.json";
const missingEvents = new Set(["PreToolUse", "PostToolUse"]);
const hookBinary = "/Users/sam/.mex/bin/mex-hook";

const claudeRepairDiff = [
  "--- " + claudeConfig,
  "+++ " + claudeConfig,
  "@@",
  ' {',
  '   "hooks": {',
  ...[...missingEvents].flatMap((event) => [
    '+    "' + event + '": [{',
    '+      "hooks": [{',
    '+        "type": "command", "command": "' + hookBinary + '",',
    '+        "args": ["claude-code", "' + event + '"],',
    '+        "timeout": 10, "onFailure": "continue"',
    '+      }]',
    '+    }],',
  ]),
  '     "SessionStart": [{',
  '       "hooks": [{ "type": "command", "command": "' + hookBinary + '",',
  '         "args": ["claude-code", "SessionStart"], "timeout": 10, "onFailure": "continue" }]',
  '     }]',
  '   }',
  ' }',
].join("\n");

export function fixtureAgents(now: number, variant: FixtureVariant) {
  const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
  const broken = variant === "agents-broken";
  const terminal = variant === "agents-terminal";
  const agents: MachineAgent[] = [
    {
      id: "claude-code",
      name: "Claude Code",
      state: broken ? "needsRepair" : "working",
      hooks: { canVerify: true, events: claudeEvents.map((name) => ({ name, status: broken && missingEvents.has(name) ? "missing" : "installed" })) },
      trust: "approved",
      lastFiredAt: ago(broken ? 48 : 2),
      errors: broken ? [
        { message: "Tool hooks are missing", at: ago(18) },
        { message: "Hook timed out", at: ago(52) },
      ] : [],
      files: [
        { path: claudeConfig, kind: "hookConfig", hiddenFromGit: false },
        { path: "/work/storefront/.claude/rules/mex-local.md", kind: "rule", hiddenFromGit: true, repo: "Storefront" },
        { path: "/work/storefront/.git/info/exclude", kind: "gitExclude", hiddenFromGit: false, repo: "Storefront" },
      ],
      repair: broken ? "browser" : "unavailable",
    },
    {
      id: "codex",
      name: "Codex",
      state: "needsRepair",
      hooks: { canVerify: true, events: codexEvents.map((name) => ({ name, status: terminal ? "unverified" : "installed" })) },
      trust: terminal ? "unknown" : "needsApproval",
      lastFiredAt: null,
      errors: terminal ? [{ message: "Couldn’t read hooks.json", at: ago(7) }] : [],
      files: [
        { path: codexConfig, kind: "hookConfig", hiddenFromGit: false },
        { path: "/work/storefront/AGENTS.md", kind: "rule", hiddenFromGit: true, repo: "Storefront" },
        { path: "/work/storefront/.codex/config.toml", kind: "agentSettings", hiddenFromGit: true, repo: "Storefront" },
        { path: "/work/storefront/.git/info/exclude", kind: "gitExclude", hiddenFromGit: false, repo: "Storefront" },
      ],
      repair: terminal ? "terminal" : "unavailable",
    },
    {
      id: "copilot",
      name: "Copilot CLI",
      state: broken ? "notSetUp" : "needsRepair",
      hooks: { canVerify: false, events: copilotEvents.map((name) => ({ name, status: "unverified" })) },
      trust: "unknown",
      lastFiredAt: null,
      errors: broken ? [] : [{ message: "Hook failed its self-test", at: ago(34) }],
      files: [],
      repair: broken ? "unavailable" : "terminal",
    },
    {
      id: "opencode",
      name: "OpenCode",
      state: "notFound",
      hooks: { canVerify: false, events: [] },
      trust: "unknown",
      lastFiredAt: null,
      errors: [],
      files: [],
      repair: "unavailable",
    },
  ];

  const repairPreviews: Partial<Record<MachineAgent["id"], AgentRepairPreview>> = {
    "claude-code": {
      agentId: "claude-code", type: "browser", revision: "claude-hook-entries-1",
      changes: [{ path: claudeConfig, diff: claudeRepairDiff }],
    },
    codex: {
      agentId: "codex", type: "terminal", command: "mex install",
      reason: "The background process can’t read the Codex configuration used by your shell. Run the installer in the terminal where you use Codex.",
    },
    copilot: {
      agentId: "copilot", type: "terminal", command: "mex install",
      reason: "The MEX hook didn’t pass its self-test. Run the installer in the terminal where you use Copilot CLI so it can check the hook there.",
    },
  };

  return { agents, repairPreviews };
}
