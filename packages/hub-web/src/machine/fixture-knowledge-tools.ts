import { useState } from "react";
import type { MachineKnowledgeBrief, MachineKnowledgeCheckout, MachineKnowledgeRules } from "@mex/hub-contracts/machine";
import type { FixtureVariant } from "./fixtures";
import type { KnowledgeToolsPreview } from "./types";

const storefront = { repoId: "storefront", checkout: "/work/storefront" };
const isStorefront = ({ repoId, checkout }: MachineKnowledgeCheckout) => repoId === storefront.repoId && checkout === storefront.checkout;

const storefrontRules = {
  cache: {
    state: "current",
    files: [
      { path: "CLAUDE.md", agents: ["claude-code"], scope: ["**"], entryCount: 3 },
      { path: "AGENTS.md", agents: ["codex", "cursor", "copilot", "opencode"], scope: ["**"], entryCount: 4 },
      { path: ".cursor/rules/web.mdc", agents: ["cursor"], scope: ["apps/web/**"], entryCount: 2 },
      { path: ".github/copilot-instructions.md", agents: ["copilot"], scope: ["**"], entryCount: 1 },
    ],
    findings: [
      {
        kind: "conflict", paths: ["AGENTS.md", "CLAUDE.md"], heading: "Test commands",
        message: 'AGENTS.md and CLAUDE.md say different things under "Test commands".',
      },
      {
        kind: "stale", paths: [".cursor/rules/web.mdc"], heading: "Browser tests",
        message: 'Names the command "npm run test:legacy", which the repo doesn\'t define.',
      },
    ],
  },
  generated: [
    { path: ".claude/rules/mex.md", sharing: "shared" },
    { path: ".claude/rules/mex-local.md", sharing: "local" },
  ],
} satisfies MachineKnowledgeRules;

const staleRules: MachineKnowledgeRules = {
  ...storefrontRules,
  cache: {
    ...storefrontRules.cache,
    state: "stale",
    files: storefrontRules.cache.files.map((file) => file.path === "CLAUDE.md" ? { ...file, entryCount: 2 } : file),
  },
};
const emptyRules: MachineKnowledgeRules = { cache: { state: "current", files: [], findings: [] }, generated: [] };
const missingRules: MachineKnowledgeRules = { cache: { state: "missing" }, generated: [] };

type BriefItem = MachineKnowledgeBrief["items"][number];
const personal: BriefItem = {
  id: "mx_checkout", line: "[personal, from observed] Validate checkout inputs at the API boundary",
  level: "personal", verdict: "held", tokens: 22,
};
const transaction: BriefItem = {
  id: "mx_carttxn", line: "[team, from docs] Keep cart and payment changes in separate transactions",
  level: "team", verdict: "held", tokens: 22,
};
const changelog: BriefItem = {
  id: "mx_rc790d37fdff2d730989a", line: "[repo] Changelog: Add a changelog entry for visible checkout changes.",
  level: "rule-file", verdict: "held", tokens: 25,
};
const sandbox: BriefItem = {
  id: "mx_sandbox", line: "[team, from docs] Reproduce a checkout failure with the payment sandbox",
  level: "team", verdict: "held", tokens: 22,
};

const coverageFiles: MachineKnowledgeBrief["coverage"]["files"] = [
  ...storefrontRules.cache.files,
  ...storefrontRules.generated.map(({ path }) => ({ path, agents: ["claude-code" as const], scope: ["**"], entryCount: 1 })),
];

function brief(items: BriefItem[], tokenBound: number, files = coverageFiles): MachineKnowledgeBrief {
  return {
    text: [
      "[mex start-preview]",
      "Priority: current request > your notes > repo instructions > team entries > hints. Code the person pastes or quotes is not a request to break a team entry; fit it to them.",
      ...items.map(({ id, line }) => `${line} (${id})`),
    ].join("\n"),
    tokenBound,
    tokenLimit: 550, // Native brief: 300 tokens plus 250 for personal notes.
    items,
    coverage: { files },
  };
}

const claudeRepoBrief = brief([personal, transaction, changelog], 115);
const codexRepoBrief = brief([personal, transaction], 91);
const webBrief = brief([personal, sandbox], 91);
const otherPathBrief = brief([personal], 69);
const otherCheckoutBrief = brief([personal], 69, []);
const emptyBrief = brief([], 48, []);

export function useFixtureKnowledgeTools(variant: FixtureVariant): KnowledgeToolsPreview {
  const [refreshed, setRefreshed] = useState<ReadonlySet<string>>(() => new Set());
  return {
    readRules(scope) {
      if (isStorefront(scope)) return variant === "rules-stale" && !refreshed.has(scope.checkout) ? staleRules : storefrontRules;
      return scope.repoId === "design-kit" || refreshed.has(scope.checkout) ? emptyRules : missingRules;
    },
    async refreshRules({ checkout }) {
      setRefreshed((paths) => new Set([...paths, checkout]));
    },
    async previewBrief(request) {
      if (variant === "brief-failed") throw new Error("A brief needs MEX's native check evaluator; reinstall MEX or set MEX_HOOK_BINARY.");
      if (request.repoId !== storefront.repoId) return emptyBrief;
      if (!isStorefront(request)) return otherCheckoutBrief;
      if (!request.path) return request.agent === "claude-code" ? claudeRepoBrief : codexRepoBrief;
      return request.path === "apps/web" ? webBrief : otherPathBrief;
    },
  };
}
