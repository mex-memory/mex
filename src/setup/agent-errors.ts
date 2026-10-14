import { AgentAssetsError } from "../agent-skills/installer.js";
import { classifySetupFileSystemError, SetupError } from "./errors.js";

const BACKUP_REVIEW = "Look for hidden entries containing .mex-backup- beside CLAUDE.md or AGENTS.md and in .claude/skills or .agents/skills. Review and reconcile those backups before rerunning setup.";

/** Translate known installer failures without exposing paths or child output. */
export function classifySetupAgentAssetsError(error: unknown): SetupError | null {
  if (!(error instanceof AgentAssetsError)) {
    return classifySetupFileSystemError(error, "Could not install the selected agent integrations.");
  }

  let userMessage: string;
  switch (error.code) {
    case "INVALID_PACKAGED_SKILL":
      userMessage = "The packaged MEX agent skills are missing or invalid. Reinstall MEX, then rerun setup.";
      break;
    case "INVALID_OPTIONS":
      userMessage = "Agent integration setup could not validate the project or installation settings. Check the project directory and selected tools; reinstall MEX if its packaged settings are invalid.";
      break;
    case "IGNORE_CHECK_FAILED":
      userMessage = "Git could not verify the agent integration paths. Make sure Git is available and run git status from the project root to diagnose the repository, then rerun setup.";
      break;
    case "CONCURRENT_MODIFICATION":
      userMessage = "Agent integration files changed during setup. Finish or stop other edits, review the affected files, then rerun setup.";
      break;
    case "PATH_IDENTITY_CHANGED":
      userMessage = `An agent integration path changed during setup. Stop other processes changing the project. ${BACKUP_REVIEW}`;
      break;
    case "REPLACEMENT_ACTIVE_BACKUP_RETAINED":
      userMessage = `Updated agent files are active, but an original backup was retained. ${BACKUP_REVIEW}`;
      break;
    case "APPLY_FAILED":
      // This code also covers failed rollback. Never imply retry alone is safe.
      userMessage = `Agent integration could not finish, and some files or backups may remain. ${BACKUP_REVIEW}`;
      break;
    default:
      // UNKNOWN_PLAN and DRY_RUN_PLAN indicate internal misuse, not a user fix.
      return null;
  }

  return new SetupError(error.message, { cause: error, userMessage });
}
