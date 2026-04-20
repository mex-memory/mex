import { daysSinceLastChange, commitsSinceLastChange } from "../../git.js";
import type { DriftIssue, Severity, StalenessThresholds } from "../../types.js";

/** Default thresholds. Overridden via MexConfig.stalenessThresholds / CLI flags. */
export const DEFAULT_STALENESS_THRESHOLDS: StalenessThresholds = {
  warnDays: 30,
  errorDays: 90,
  warnCommits: 50,
  errorCommits: 200,
};

type StaleSignal = { severity: Severity; message: string };

function daysSignal(
  days: number,
  warnDays: number,
  errorDays: number
): StaleSignal | null {
  if (days >= errorDays) {
    return {
      severity: "error",
      message: `File hasn't been updated in ${days} days (threshold: ${errorDays}d)`,
    };
  }
  if (days >= warnDays) {
    return {
      severity: "warning",
      message: `File hasn't been updated in ${days} days (threshold: ${warnDays}d)`,
    };
  }
  return null;
}

function commitsSignal(
  commits: number,
  warnCommits: number,
  errorCommits: number
): StaleSignal | null {
  if (commits >= errorCommits) {
    return {
      severity: "error",
      message: `${commits} commits since file was last updated (threshold: ${errorCommits})`,
    };
  }
  if (commits >= warnCommits) {
    return {
      severity: "warning",
      message: `${commits} commits since file was last updated (threshold: ${warnCommits})`,
    };
  }
  return null;
}

const SEVERITY_RANK: Record<Severity, number> = {
  info: 0,
  warning: 1,
  error: 2,
};

/**
 * Check how stale a scaffold file is based on git history.
 *
 * When both the day threshold and the commit threshold are exceeded, this
 * returns a single combined issue at the higher of the two severities —
 * two STALE_FILE issues on the same file are the same underlying condition
 * and should cost the score once, not twice.
 */
export async function checkStaleness(
  filePath: string,
  source: string,
  cwd: string,
  thresholds: StalenessThresholds = DEFAULT_STALENESS_THRESHOLDS
): Promise<DriftIssue[]> {
  const { warnDays, errorDays, warnCommits, errorCommits } = thresholds;

  const days = await daysSinceLastChange(filePath, cwd);
  const commits = await commitsSinceLastChange(filePath, cwd);

  const signals: StaleSignal[] = [];
  if (days !== null) {
    const s = daysSignal(days, warnDays, errorDays);
    if (s) signals.push(s);
  }
  if (commits !== null) {
    const s = commitsSignal(commits, warnCommits, errorCommits);
    if (s) signals.push(s);
  }

  if (signals.length === 0) return [];

  const severity = signals.reduce<Severity>(
    (acc, s) => (SEVERITY_RANK[s.severity] > SEVERITY_RANK[acc] ? s.severity : acc),
    signals[0].severity
  );
  const message = signals.map((s) => s.message).join("; ");

  return [
    {
      code: "STALE_FILE",
      severity,
      file: source,
      line: null,
      message,
    },
  ];
}
