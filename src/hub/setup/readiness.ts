import type { SetupStatus } from "@mex/hub-contracts/setup";
import { inspectSetupStatus } from "../../setup/headless.js";
import { setupCommitCheckpointCommands } from "../../setup/index.js";
import { describeUnfinishedSetup } from "../../setup/unfinished.js";

/** The unfinished-setup line for the Hub, when setup stopped part-way. */
function unfinishedStatus(projectRoot: string): Pick<SetupStatus, "unfinished"> {
  const unfinished = describeUnfinishedSetup(projectRoot);
  return unfinished === null ? {} : { unfinished: { done: unfinished.done, total: unfinished.total, message: unfinished.line.slice(0, 512) } };
}
import { createRepositoryTeamWorkflowPort } from "../../team/workflow/repository-team-workflow-port.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

/** Finalization changes tracked Knowledge even when the scaffold identity was committed earlier. */
export async function hasPendingSetupChanges(projectRoot: string): Promise<boolean> {
  try {
    await promisify(execFile)("git", ["diff", "--quiet", "HEAD", "--", ".mex"], { cwd: projectRoot, timeout: 10_000 });
    return false;
  } catch {
    return true;
  }
}

/** Use the same read-only authority check as production; never provision state. */
export async function hasCommittedHubIdentity(projectRoot: string): Promise<boolean> {
  try {
    await createRepositoryTeamWorkflowPort(projectRoot);
    return true;
  } catch {
    return false;
  }
}

export async function projectSetupStatus(projectRoot: string): Promise<SetupStatus> {
  const status = inspectSetupStatus(projectRoot);
  const ready = status.ready && status.mode === "code-repo"
    && await hasCommittedHubIdentity(projectRoot);
  // The same status-first summary the terminal prints on a rerun (#284).
  const health = ready || (status.ready && status.mode === "agent-memory")
    ? await import("../../setup/health.js").then(({ assessSetupHealth }) => assessSetupHealth(projectRoot))
    : null;
  return {
    mode: status.mode,
    projectName: status.projectName,
    hasGit: status.hasGit,
    hasScaffold: status.hasScaffold,
    populated: status.populated,
    graphReady: status.graphReady,
    wikiReady: status.wikiReady,
    state: status.state,
    stage: status.ready ? status.mode === "agent-memory" ? "complete" : ready ? "ready" : "needs_commit" : status.stage,
    configuredTools: status.configuredTools,
    tools: [...status.tools],
    ready,
    commitCommands: status.mode === "code-repo" && status.ready
      ? setupCommitCheckpointCommands(status.configuredTools)
      : [],
    ...unfinishedStatus(projectRoot),
    ...(health?.healthy ? { setupHealth: { summary: health.summary, notes: health.notes.slice(0, 4) } } : {}),
  };
}

/** The initial snapshot requires no Git subprocesses or asynchronous constructor. */
export function initialSetupStatus(projectRoot: string): SetupStatus {
  const status = inspectSetupStatus(projectRoot);
  return {
    mode: status.mode,
    projectName: status.projectName,
    hasGit: status.hasGit,
    hasScaffold: status.hasScaffold,
    populated: status.populated,
    graphReady: status.graphReady,
    wikiReady: status.wikiReady,
    state: status.state,
    stage: status.ready ? status.mode === "agent-memory" ? "complete" : "needs_commit" : status.stage,
    configuredTools: status.configuredTools,
    tools: [...status.tools],
    ready: false,
    commitCommands: status.mode === "code-repo" && status.ready
      ? setupCommitCheckpointCommands(status.configuredTools)
      : [],
    ...unfinishedStatus(projectRoot),
  };
}
