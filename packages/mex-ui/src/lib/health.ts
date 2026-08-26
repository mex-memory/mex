/**
 * Turning engine numbers into words a human can act on. Pure functions so the
 * judgement calls ("is 74 fine?") are testable and stated in exactly one place.
 */

import type { DriftIssue, GraphStats, GroundingCoverage, ProjectSnapshot, Severity } from "./types";

/** Maps a drift severity onto the CSS marker class used by issue rows. */
export const SEVERITY_CLASS: Record<Severity, string> = {
  error: "sev--error",
  warning: "sev--warning",
  info: "sev--info",
};

export type Tone = "good" | "warn" | "bad" | "neutral" | "info";

/** Same marker classes, addressed by tone for rows that carry no severity. */
export const TONE_CLASS: Record<Tone, string> = {
  bad: "sev--error",
  warn: "sev--warning",
  good: "sev--good",
  info: "sev--info",
  neutral: "sev--info",
};

export interface ScoreVerdict {
  tone: Tone;
  /** One or two words for a badge. */
  label: string;
  /** A sentence explaining what the score means right now. */
  headline: string;
}

/**
 * Thresholds follow the drift scoring model in `src/drift/scoring.ts`: an error
 * costs 10 points and a warning 3, so 90+ means at most a few warnings and
 * below 70 means multiple real errors.
 */
export function describeScore(score: number, issues: readonly DriftIssue[]): ScoreVerdict {
  const errors = issues.filter((issue) => issue.severity === "error").length;
  const warnings = issues.filter((issue) => issue.severity === "warning").length;

  if (errors === 0 && warnings === 0) {
    return {
      tone: "good",
      label: "Healthy",
      headline: "Your scaffold matches the codebase. Nothing to fix.",
    };
  }
  if (errors === 0) {
    return {
      tone: "good",
      label: "Healthy",
      headline: `No errors — ${warnings === 1 ? "one warning" : `${warnings} warnings`} worth a look.`,
    };
  }
  if (score >= 70) {
    return {
      tone: "warn",
      label: "Drifting",
      headline: `${errors === 1 ? "One claim" : `${errors} claims`} in your docs no longer match the code.`,
    };
  }
  return {
    tone: "bad",
    label: "Out of date",
    headline: `${errors} claims are wrong. Run \`mex sync\` to have your agent fix them.`,
  };
}

export interface IssueGroup {
  code: string;
  severity: Severity;
  count: number;
  /** Representative issues, capped for display. */
  samples: DriftIssue[];
}

export interface IssueSummary {
  total: number;
  errors: number;
  warnings: number;
  infos: number;
  /** Grouped by code, most severe and most numerous first. */
  groups: IssueGroup[];
}

const SEVERITY_RANK: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

/**
 * Collapse a flat issue list into per-code groups. A drift report can contain
 * dozens of instances of the same problem; the grouped view is what makes it
 * readable without hiding anything.
 */
export function summarizeIssues(issues: readonly DriftIssue[], sampleLimit = 4): IssueSummary {
  const groups = new Map<string, IssueGroup>();

  for (const issue of issues) {
    const existing = groups.get(issue.code);
    if (existing) {
      existing.count += 1;
      // Keep the worst severity seen for a code, so a group is never
      // presented as gentler than its most serious member.
      if (SEVERITY_RANK[issue.severity] < SEVERITY_RANK[existing.severity]) {
        existing.severity = issue.severity;
      }
      if (existing.samples.length < sampleLimit) existing.samples.push(issue);
      continue;
    }
    groups.set(issue.code, {
      code: issue.code,
      severity: issue.severity,
      count: 1,
      samples: [issue],
    });
  }

  return {
    total: issues.length,
    errors: issues.filter((issue) => issue.severity === "error").length,
    warnings: issues.filter((issue) => issue.severity === "warning").length,
    infos: issues.filter((issue) => issue.severity === "info").length,
    groups: [...groups.values()].sort(
      (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.count - a.count,
    ),
  };
}

export interface Recommendation {
  id: string;
  tone: Tone;
  title: string;
  body: string;
  /** Command to run, when the fix is a CLI action. */
  command?: string;
  /** In-app action id the dashboard knows how to perform. */
  action?: "build-graph" | "run-setup" | "open-setup" | "capture-grounding";
}

/**
 * The prioritized list of what to do next. Ordered by how much it unblocks:
 * a broken scaffold beats unfilled wiki files (a human + agent job), which
 * beats a missing graph, which beats drift.
 */
export function buildRecommendations(input: {
  snapshot: ProjectSnapshot;
  graph: GraphStats | null;
  issues: readonly DriftIssue[] | null;
  grounding?: GroundingCoverage | null;
  /** Hide the build-graph action while a build is already on screen. */
  graphBuilding?: boolean;
}): Recommendation[] {
  const { snapshot, graph, issues, grounding, graphBuilding } = input;
  const out: Recommendation[] = [];

  if (snapshot.status === "error" && snapshot.error?.canRunSetup) {
    out.push({
      id: "repair-scaffold",
      tone: "bad",
      title: "Repair the scaffold",
      body: snapshot.error.hint ?? snapshot.error.message,
      action: "run-setup",
    });
  }

  const unfilled = snapshot.scaffold.total - snapshot.scaffold.populated;
  if (snapshot.status === "ready" && unfilled > 0) {
    out.push({
      id: "populate-scaffold",
      tone: "warn",
      title: `${unfilled === 1 ? "One wiki file is" : `${unfilled} wiki files are`} still a template`,
      body: "Copy the prompt on Setup and paste it into your coding agent from this project. mex will not fill those files itself.",
      action: "open-setup",
    });
  }

  if (graph && !graph.available && graph.unavailable && !graphBuilding) {
    out.push(
      graph.unavailable.reason === "needs-rebuild"
        ? {
            id: "rebuild-graph",
            tone: "warn",
            title: "Rebuild the code graph",
            body: "The index was built by a different mex version, so grounding checks are skipped until it is rebuilt.",
            action: "build-graph",
          }
        : {
            id: "build-graph",
            tone: "info",
            title: "Build the code graph",
            body: "Without it, your agent can't resolve symbols or verify that documented claims still point at real code.",
            action: "build-graph",
          },
    );
  }

  // Ranked above drift on purpose: uncaptured grounding means the drift report
  // itself is incomplete, so acting on it first makes everything below truer.
  if (grounding?.needsCapture) {
    const missing = grounding.authored - grounding.captured;
    out.push({
      id: "capture-grounding",
      tone: "warn",
      title: `${missing === 1 ? "One grounded claim has" : `${missing} grounded claims have`} no baseline`,
      body: "Your agent anchored these claims to real symbols, but mex hasn't fingerprinted the code behind them yet — so it can't tell you when that code changes.",
      action: "capture-grounding",
    });
  }

  if (issues && issues.some((issue) => issue.severity === "error")) {
    out.push({
      id: "sync-drift",
      tone: "bad",
      title: "Fix drifted claims",
      body: "Your scaffold documents things the code no longer does. Sync rewrites only the files that are wrong.",
      command: "mex sync",
    });
  }

  if (graph?.available && graph.health.failedFiles > 0) {
    out.push({
      id: "parse-failures",
      tone: "warn",
      title: `${graph.health.failedFiles} file${graph.health.failedFiles === 1 ? "" : "s"} failed to parse`,
      body: "Those files are missing from the graph, so calls into them are invisible to your agent.",
    });
  }

  return out;
}
