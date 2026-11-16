/** Producer-verified evidence only. Acquisition belongs to the producing lane. */
export interface Evidence {
  source: "person" | "docs" | "ci" | "review" | "observed" | "agent-memory";
  observations?: Array<{ session: string; verified: boolean; lasting: boolean; marked: boolean; delivered: boolean }>;
  pullRequests?: Array<{ repository: string; number: number; merged: boolean; authorized: boolean }>;
  corroboration?: { kind: "ci" | "script" | "docs"; verified: boolean; sameClaim: boolean };
}
export interface PromotionPolicy {
  evidence: Evidence; shared: boolean; manual: boolean; visibility: "private" | "public" | "unknown";
  authorized: boolean; privacyHolds: string[]; checksHold: boolean; conflict: boolean;
}
export type EvidenceReason = "not-shared" | "manual-sharing" | "privacy" | "source-authority" | "insufficient-evidence" | "public-session" | "checks" | "team-conflict" | "eligible";
export function evidenceHolds(evidence: Evidence): boolean {
  if (evidence.source === "person") {
    const observations = (evidence.observations ?? []).filter(o => o.verified && !o.marked && !o.delivered);
    return observations.some(o => o.lasting) || new Set(observations.map(o => o.session)).size >= 2;
  }
  if (evidence.source === "observed" || evidence.source === "agent-memory") return !!evidence.corroboration && ["ci", "script", "docs"].includes(evidence.corroboration.kind) && evidence.corroboration.verified === true && evidence.corroboration.sameClaim === true;
  if (!["docs", "ci", "review"].includes(evidence.source)) return false;
  const pulls = (evidence.pullRequests ?? []).filter(p => p.merged && p.authorized && Number.isSafeInteger(p.number) && p.number > 0 && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(p.repository));
  // Two PR numbers from unrelated repositories do not corroborate one project.
  return pulls.some(p => new Set(pulls.filter(other => other.repository.toLowerCase() === p.repository.toLowerCase()).map(other => other.number)).size >= 2);
}
export function promotionDecision(policy: PromotionPolicy): { destination: "personal" | "review" | "team"; reason: EvidenceReason } {
  const personal = (reason: EvidenceReason) => ({ destination: "personal" as const, reason });
  if (!policy.shared) return personal("not-shared");
  if (policy.manual) return personal("manual-sharing");
  if (policy.privacyHolds.length) return personal("privacy");
  if (!policy.authorized) return personal("source-authority");
  if (!evidenceHolds(policy.evidence)) return personal("insufficient-evidence");
  if (policy.evidence.source === "person" && policy.visibility !== "private") return { destination: "review", reason: "public-session" };
  if (policy.conflict) return { destination: "review", reason: "team-conflict" };
  if (!policy.checksHold) return { destination: "review", reason: "checks" };
  return { destination: "team", reason: "eligible" };
}
