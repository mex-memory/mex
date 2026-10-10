/**
 * Remediation wording for a Wiki index in the `migration_required` state,
 * shared so the CLI capabilities surface, Specs recovery, and Hub Health
 * describe the same next step. The Hub shows the human-facing command; CLI
 * surfaces append `--json` for agent consumption.
 */
export const WIKI_MIGRATION_RECOVERY = {
  label: "Preview the required Wiki migration",
  command: "mex wiki migrate --dry-run",
} as const;
