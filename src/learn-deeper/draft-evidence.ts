import { backedBy, type Cluster } from "./cluster.js";
import { claimClauseCount, quoteChecks, stoppingType } from "./prove.js";
import { corroboratedLesson, learnedStatus } from "./route.js";
import type { WriterEntry } from "./write.js";

type Check = ReturnType<typeof quoteChecks>[number]["citations"][number];
type Eligible = Check & { question: NonNullable<Check["question"]> };
const eligible = (check: Check): check is Eligible => check.question !== undefined;

/** Keep one citation per member and claim clause. Ask only when the answer can matter. */
export function draftEvidence(draft: WriterEntry, cluster: Cluster) {
  const rows = quoteChecks(draft, cluster);
  const eligibleQuotes = rows.flatMap(row => row.citations.filter(eligible));
  const supportingQuotes = new Set(eligibleQuotes.filter(check => check.exact).map(check => check.citation));
  const claims = rows.slice(0, claimClauseCount(draft));
  const choices = new Map<string, Eligible[]>();
  if (claims.length) {
    for (const { candidate } of cluster.members) {
      const selected = claims.map(row => {
        const options = row.citations.filter(eligible).filter(check => check.citation.id === candidate.id);
        return options.find(check => check.exact) ?? options[0];
      });
      if (selected.every((check): check is Eligible => check !== undefined)) choices.set(candidate.id, selected);
    }
  }

  const exact = new Set([...choices].filter(([, checks]) => checks.every(check => check.exact)).map(([id]) => id));
  const local = backedBy(cluster, exact);
  const possible = backedBy(cluster, new Set(choices.keys()), true);
  const stop = stoppingType(draft);
  const canProve = !!draft.fix && stop !== undefined && draft.when.some(item => item.type === stop);
  const canActivate = (value: Cluster) =>
    learnedStatus(value.waiting, corroboratedLesson(value), canProve, false, value.support) === "active";

  const asked: Eligible[] = [];
  if (possible.decision !== "drop") {
    const needsBacking = !exact.size || local.decision === "drop";
    const mayActivate = canActivate(possible);
    for (const [id, checks] of choices) {
      if (exact.has(id)) continue;
      if (!needsBacking) {
        if (!mayActivate) continue;
        const extra = backedBy(cluster, new Set([...exact, id]));
        if (extra.support === local.support && extra.reviewers === local.reviewers
          && canActivate(extra) === canActivate(local)) continue;
      }
      asked.push(...checks.filter(check => !check.exact));
    }
  }

  const requested = new Set(asked.map(check => check.citation));
  const skippedQuotes = new Set(eligibleQuotes.map(check => check.citation)
    .filter(citation => !supportingQuotes.has(citation) && !requested.has(citation)));
  return { asked, supportingQuotes, skippedQuotes };
}
