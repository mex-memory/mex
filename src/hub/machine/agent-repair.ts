import type { MachineAgentRepairPreviewSchema } from "@mex/hub-contracts/machine";
import { randomUUID } from "node:crypto";
import type { z } from "zod";
import { installAgents, InstallRevisionConflict, installHookCommands, type InstallChange, type RepairRevision } from "../../install/index.js";
import { snapshotBytes } from "../../install/files.js";
import { recordLocation } from "../../record/location.js";
import type { AgentId, MachineAgentOptions } from "./agents-snapshot.js";
import { hookChanges, visibleValue } from "./install-diff.js";
import { HubRequestError } from "./security.js";

type Preview = z.infer<typeof MachineAgentRepairPreviewSchema>;
const TTL = 5 * 60_000;
const PREVIEW_LIMIT = 128;

function stale(): HubRequestError {
  return new HubRequestError(409, "STALE_PREVIEW", "The repair preview changed", "Open a new repair preview and review the current changes.");
}

function terminal(agentId: AgentId, reason: string): Preview {
  return { type: "terminal", agentId, command: "mex install", reason };
}

function diff(change: InstallChange, home: string) {
  const before = snapshotBytes(change.before), after = snapshotBytes(change.after);
  const scope = change.kind === "settings" ? hookChanges(before, after, installHookCommands(home, process.platform))
    : { before: before?.toString("utf8"), after: after?.toString("utf8") };
  const lines = (value: unknown, prefix: string) => {
    const text = visibleValue(value, 30 << 10);
    return text && text !== "{}" ? text.trimEnd().split("\n").map(line => prefix + line) : [];
  };
  const path = change.path.replace(/[\r\n]/gu, " ");
  return ["--- " + path, "+++ " + path, "@@", ...lines(scope.before, "-"), ...lines(scope.after, "+")].join("\n");
}

export function machineBusy(error: unknown): HubRequestError | undefined {
  const detail = error as { errcode?: number; code?: string; message?: string; title?: string } | undefined;
  if ((detail?.errcode !== undefined && [5, 6].includes(detail.errcode & 0xff))
    || detail?.code === "SQLITE_BUSY" || detail?.code === "STORE_BUSY"
    || detail?.title === "Artifact collection is being updated" || detail?.title === "Artifact lock recovery is in progress") {
    return new HubRequestError(503, "MEX_BUSY", "MEX is busy", "MEX is busy. Try again in a moment.");
  }
}

export class AgentRepair {
  #reviews = new Map<string, { agent: AgentId; session: string; expires: number; expected: RepairRevision }>();
  constructor(private readonly options: MachineAgentOptions, private readonly now: () => number) {}

  async preview(agent: AgentId, session: string): Promise<Preview> {
    try {
      const { repair, changes } = await this.#run(agent);
      if (!repair || !changes.length) throw stale();
      const { home } = recordLocation({ ...this.options, create: false });
      const previewToken = randomUUID();
      const now = this.now();
      for (const [token, saved] of this.#reviews) if (saved.expires <= now) this.#reviews.delete(token);
      if (this.#reviews.size >= PREVIEW_LIMIT) this.#reviews.delete(this.#reviews.keys().next().value!);
      this.#reviews.set(previewToken, { agent, session, expires: now + TTL, expected: repair });
      return { type: "browser", agentId: agent, revision: repair.revision, previewToken, changes: changes.map(change => ({ path: change.path, diff: diff(change, home) })) };
    } catch (error) {
      if (error instanceof HubRequestError) throw error;
      const busy = machineBusy(error);
      if (busy) throw busy;
      if (error instanceof Error && error.message === "This configuration is tracked by Git.") {
        return terminal(agent, "Git tracks this configuration. Review the file in your dotfiles or repo before running install.");
      }
      return terminal(agent, "The Hub couldn’t verify the configuration, installed hook, or MEX launcher. Check the agent’s configuration and permissions, then run MEX’s installer in your terminal.");
    }
  }

  async apply(agent: AgentId, session: string, revision: string, token: string): Promise<InstallChange[]> {
    const saved = this.#reviews.get(token);
    if (!saved || saved.agent !== agent || saved.session !== session || saved.expires <= this.now() || saved.expected.revision !== revision) throw stale();
    try {
      const result = await this.#run(agent, saved.expected);
      this.#reviews.delete(token);
      return result.changes;
    } catch (error) {
      const busy = machineBusy(error);
      if (busy) throw busy;
      this.#reviews.delete(token);
      if (error instanceof InstallRevisionConflict) throw stale();
      if (error instanceof Error && /^(?:record|hooks)\.db schema version \d+ is newer/u.test(error.message)) {
        throw new HubRequestError(409, "STALE_PREVIEW", "MEX needs an upgrade", error.message);
      }
      throw new HubRequestError(409, "STALE_PREVIEW", "MEX couldn’t apply this repair", "Open a new preview, or run mex install in your terminal.");
    }
  }

  #run(agent: AgentId, expected?: RepairRevision) {
    const { cache, isNetwork, ...options } = this.options;
    return installAgents({ ...options, dryRun: expected === undefined, repair: { agent, cache, isNetwork, expected } });
  }
}
