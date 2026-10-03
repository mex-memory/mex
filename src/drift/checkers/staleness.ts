import { daysSinceLastChange, commitsSinceLastChange, commitsTouchingPathsSinceLastChange } from "../../git.js";
import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { toPosix } from "../../paths.js";
import type { Claim, DriftIssue, Severity, StalenessThresholds } from "../../types.js";

/** Default thresholds. Overridden via MexConfig.stalenessThresholds / CLI flags. */
export const DEFAULT_STALENESS_THRESHOLDS: StalenessThresholds = {
  warnDays: 30,
  errorDays: 90,
  warnCommits: 50,
  errorCommits: 200,
};

/**
 * Scaffold files whose content mex ships rather than the project authors
 * (#237). They describe mex, or are kept in step by `mex pattern add` and the
 * index-sync checker, so their age says nothing about the project. Paths are
 * relative to the scaffold root.
 */
export const TEMPLATE_OWNED_SCAFFOLD_FILES: readonly string[] = [
  "SETUP.md",
  "SYNC.md",
  "patterns/README.md",
  "patterns/INDEX.md",
];

export function isTemplateOwnedScaffoldFile(scaffoldRelativePath: string): boolean {
  return TEMPLATE_OWNED_SCAFFOLD_FILES.includes(scaffoldRelativePath.replaceAll("\\", "/"));
}

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
  errorCommits: number,
  scoped: boolean
): StaleSignal | null {
  const what = scoped ? "commits to referenced paths" : "commits";
  if (commits >= errorCommits) {
    return {
      severity: "error",
      message: `${commits} ${what} since file was last updated (threshold: ${errorCommits})`,
    };
  }
  if (commits >= warnCommits) {
    return {
      severity: "warning",
      message: `${commits} ${what} since file was last updated (threshold: ${warnCommits})`,
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
 *
 * `referencedPaths` scopes the commit signal to what the file describes
 * (#237): only commits touching those paths count, because a commit elsewhere
 * in the repository is not a change to anything the file claims. An empty
 * list means the file references nothing, so only its age is judged. Omit it
 * for the historical whole-repository count.
 */
export async function checkStaleness(
  filePath: string,
  source: string,
  cwd: string,
  thresholds: StalenessThresholds = DEFAULT_STALENESS_THRESHOLDS,
  opts: { lastUpdated?: string; referencedPaths?: readonly string[] } = {}
): Promise<DriftIssue[]> {
  const { warnDays, errorDays, warnCommits, errorCommits } = thresholds;

  const days = await daysSinceLastChange(filePath, cwd);
  const scoped = opts.referencedPaths !== undefined;
  const commits = !scoped
    ? await commitsSinceLastChange(filePath, cwd)
    : opts.referencedPaths!.length === 0
      ? null
      : await commitsTouchingPathsSinceLastChange(filePath, opts.referencedPaths!, cwd);

  const signals: StaleSignal[] = [];
  if (days !== null) {
    const s = daysSignal(days, warnDays, errorDays);
    if (s) signals.push(s);
  }
  if (commits !== null) {
    const s = commitsSignal(commits, warnCommits, errorCommits, scoped);
    if (s) signals.push(s);
  }
  const fieldDays = daysSinceFrontmatterDate(opts.lastUpdated);
  if (fieldDays !== null) {
    const s = daysSignal(fieldDays, warnDays, errorDays);
    if (s) {
      signals.push({
        severity: s.severity,
        message: `last_updated is ${fieldDays} days old (threshold: ${
          s.severity === "error" ? errorDays : warnDays
        }d)`,
      });
    }
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

export function daysSinceFrontmatterDate(value: string | undefined, now = new Date()): number | null {
  if (!value || value.includes("[") || value.includes("]")) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return null;
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const dateUtc = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const days = Math.floor((todayUtc - dateUtc) / 86_400_000);
  return days < 0 ? null : days;
}

const URL_LIKE = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * The repository paths a scaffold file describes, as git pathspecs (#237).
 *
 * Path claims are resolved the way the path checker reads them: against the
 * project root, or against the scaffold root when only that resolves. Grounded
 * code contributes the file of each grounded node. Paths that are scaffold
 * knowledge themselves are dropped — another document changing is not a change
 * to the code this one describes — as is anything that is not a plain
 * repository-relative path, since a pathspec like `.` or `..` would count every
 * commit and bring back the noise this exists to remove.
 *
 * A bare filename such as `tsconfig.json` is matched at any depth, mirroring
 * the path checker's recursive search for the same claim.
 */
export function stalenessReferencedPaths(input: {
  claims: readonly Claim[];
  groundedFiles: readonly string[];
  projectRoot: string;
  scaffoldRoot: string;
  /** Project-relative POSIX paths of every scaffold file. */
  scaffoldFiles: ReadonlySet<string>;
}): string[] {
  const { projectRoot, scaffoldRoot } = input;
  const scaffoldPrefix = scaffoldRoot === projectRoot
    ? null
    : `${toPosix(relative(projectRoot, scaffoldRoot))}/`;
  // A bare `ROUTER.md` or `architecture.md` in prose names a scaffold file.
  const scaffoldBasenames = new Set([...input.scaffoldFiles].map((file) => file.slice(file.lastIndexOf("/") + 1)));
  const paths = new Set<string>();
  const add = (raw: string) => {
    let value = raw.trim().replaceAll("\\", "/").replace(/^(?:\.\/)+/, "");
    if (!value || URL_LIKE.test(value) || isAbsolute(value) || /^[~:]/.test(value)) return;
    if (!existsSync(resolve(projectRoot, value)) && scaffoldPrefix !== null
      && existsSync(resolve(scaffoldRoot, value))) {
      value = `${scaffoldPrefix}${value}`;
    }
    const segments = value.replace(/\/+$/, "").split("/");
    if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return;
    const normalized = segments.join("/");
    if (input.scaffoldFiles.has(normalized) || scaffoldBasenames.has(normalized)) return;
    if (scaffoldPrefix !== null && input.scaffoldFiles.has(`${scaffoldPrefix}${normalized}`)) return;
    if (scaffoldPrefix !== null && `${normalized}/`.startsWith(scaffoldPrefix)) return;
    paths.add(value);
    if (segments.length === 1 && !value.endsWith("/")) paths.add(`*/${value}`);
  };
  for (const claim of input.claims) {
    if (claim.kind === "path" && !claim.negated) add(claim.value);
  }
  for (const file of input.groundedFiles) add(file);
  return [...paths].sort();
}
