export interface SessionEvidence {
  session: string;
  model: string;
  capacity: number;
  peak: number;
  compactions: CompactionEvidence[];
}

export interface CompactionEvidence {
  at: number;
  tokensAfter?: number;
  rereads?: { before: number; after: number };
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

export function windowOffer(sessions: SessionEvidence[], model: string, minCapacity = 1_000_000) {
  const eligible = [...new Map(sessions.filter(s => s.model === model && s.capacity >= minCapacity && s.peak > 300_000)
    .map(s => [s.session, s])).values()];
  const after = eligible.flatMap(s => {
    const last = [...s.compactions].reverse().find(c => c.tokensAfter !== undefined);
    return last?.tokensAfter === undefined ? [] : [last.tokensAfter];
  });
  if (eligible.length < 3 || after.length === 0) return undefined;
  const postCompaction = median(after);
  const window = Math.round(Math.min(500_000, Math.max(200_000, 3 * postCompaction)));
  return { window, postCompaction, peak: median(eligible.map(s => s.peak)), capacity: median(eligible.map(s => s.capacity)),
    sessions: eligible.length, samples: after.length };
}

export type PauseReason = "kept-rate" | "rereads" | "ledger";

export interface KeptRateCheck {
  at: number;
  kept: number;
  checked: number;
  estimated: boolean;
  partial?: boolean;
}

export function pauseReason(evidence: {
  checks?: KeptRateCheck[];
  rereads?: { before: number; after: number };
  net?: number;
}): PauseReason | undefined {
  const { checks = [], rereads, net } = evidence;
  const recent = checks.filter(check => check.estimated && !check.partial && check.checked >= 5 &&
    check.kept >= 0 && check.kept <= check.checked).sort((a, b) => b.at - a.at).slice(0, 3);
  if (recent.filter(check => check.kept * 10 < check.checked * 9).length >= 2) return "kept-rate";
  if (rereads && rereads.after >= Math.max(5, 2 * rereads.before + 3)) return "rereads";
  if (net !== undefined && Number.isFinite(net) && net < 0) return "ledger";
  return undefined;
}
