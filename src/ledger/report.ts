import type { CompactAgent } from "../compaction/settings.js";
import { openHooksReadOnly, openRecordReadOnly, type RecordReader } from "../record/index.js";
import type { LocationOptions } from "../record/location.js";
import { LEDGER_REPORT_SCHEMA_VERSION } from "../record/schema.js";
import { INPUT_MILLITOKENS, LEDGER_PRICE_PROFILE } from "./pricing.js";
import { LEDGER_MODE } from "./view.js";

const maxSessions = 256;
const minimumPerArm = 5;
const earlyEstimatePerArm = 20;

interface Sample {
  agent: CompactAgent;
  model: string;
  trial: string | null;
  holdout: 0 | 1 | null;
  requests: number;
  spend_input_millitokens: number;
  end_input_tokens: number;
  mex_context_tokens: number | null;
  compaction_millitokens: number | null;
  levers_millitokens: number | null;
}

interface StudyProgress {
  agent: CompactAgent;
  holdout: 0 | 1;
  assigned: number;
  measured: number;
}

function recentSessions(hooks: RecordReader, project: string, checkout: string): Sample[] {
  return hooks.all<Sample>(`WITH recent AS (
    SELECT s.session_id,s.agent,l.ended_at,m.model,m.trial,m.holdout,m.requests,m.spend_input_millitokens,m.end_input_tokens,m.mex_context_tokens
    FROM sessions s JOIN ledger_settlements l USING(session_id) JOIN ledger_session_metrics m USING(session_id)
    WHERE s.project_id=? AND s.checkout=? AND s.paused=0 AND l.price_profile=?
      AND julianday(s.last_seen_at)<=julianday(l.ended_at)
    ORDER BY julianday(l.ended_at) DESC,s.session_id LIMIT ?
  )
  SELECT r.agent,r.model,r.trial,r.holdout,r.requests,r.spend_input_millitokens,r.end_input_tokens,r.mex_context_tokens,
    sum(CASE WHEN l.lever='compaction' OR l.lever GLOB 'compaction#[0-9]*'
      THEN l.saved_input_millitokens-l.cost_input_millitokens END) AS compaction_millitokens,
    sum(CASE WHEN l.lever IN ('outline','shell-trim','codex-wrapper')
      OR l.lever GLOB 'outline#[0-9]*' OR l.lever GLOB 'shell-trim#[0-9]*' OR l.lever GLOB 'codex-wrapper#[0-9]*'
      THEN l.saved_input_millitokens-l.cost_input_millitokens END) AS levers_millitokens
  FROM recent r LEFT JOIN ledger l ON l.session_id=r.session_id AND l.agent_id=''
  GROUP BY r.session_id ORDER BY julianday(r.ended_at) DESC,r.session_id`, project, checkout, LEDGER_PRICE_PROFILE, maxSessions + 1);
}

function percentile(sorted: number[], fraction: number): number {
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const from = sorted[lower]!, to = sorted[Math.ceil(position)]!;
  return from + (to - from) * (position - lower);
}

interface Quartiles { p25: number; p75: number }

function distribution(values: number[]): { median: number | null; iqr: Quartiles | null } {
  if (!values.length) return { median: null, iqr: null };
  const sorted = values.sort((a, b) => a - b);
  return { median: percentile(sorted, 0.5), iqr: { p25: percentile(sorted, 0.25), p75: percentile(sorted, 0.75) } };
}

function inputEquivalent(value: number | null): number | null {
  return value === null ? null : value / INPUT_MILLITOKENS;
}

function groups<T>(rows: Sample[], key: (row: Sample) => T): Map<T, Sample[]> {
  const byKey = new Map<T, Sample[]>();
  for (const row of rows) {
    const group = key(row);
    if (!byKey.has(group)) byKey.set(group, []);
    byKey.get(group)!.push(row);
  }
  return byKey;
}

/** A typical actual session, with all its line items from the same row. */
function medianSessions(samples: Sample[]) {
  const active = samples.filter(s => s.holdout !== 1);
  return [...groups(active, s => s.agent + "/" + s.model).values()].map(group => {
    group.sort((a, b) => a.spend_input_millitokens - b.spend_input_millitokens);
    const session = group[Math.floor((group.length - 1) / 2)]!;
    return {
      agent: session.agent, model: session.model, sessions: group.length,
      requests: session.requests, observedInputEquivalent: inputEquivalent(session.spend_input_millitokens)!,
      hostCompactionNet: inputEquivalent(session.compaction_millitokens), mexToolLeversNet: inputEquivalent(session.levers_millitokens),
      finalInputTokens: session.end_input_tokens, mexContextTokens: session.mex_context_tokens,
    };
  });
}

function arm(samples: Sample[]) {
  const requests = distribution(samples.map(s => s.requests));
  const spend = distribution(samples.map(s => s.spend_input_millitokens / INPUT_MILLITOKENS));
  return {
    sessions: samples.length,
    medianRequests: requests.median,
    requestsIqr: requests.iqr,
    medianInputEquivalent: spend.median,
    inputEquivalentIqr: spend.iqr,
  };
}

function compareHoldouts(samples: Sample[], currentTrial: string | undefined) {
  const enrolled = samples.filter(s => s.trial !== null);
  return [...groups(enrolled, s => s.trial + "/" + s.agent + "/" + s.model).values()].map(group => {
    const { agent, model, trial } = group[0]!;
    const active = arm(group.filter(s => s.holdout === 0)), controls = group.filter(s => s.holdout === 1);
    const holdout = arm(controls);
    const comparable = model !== "mixed" && model !== "unknown";
    const ready = comparable && active.sessions >= minimumPerArm && holdout.sessions >= minimumPerArm;
    const earlyEstimate = active.sessions < earlyEstimatePerArm || holdout.sessions < earlyEstimatePerArm;
    const observedDifference = ready ? holdout.medianInputEquivalent! - active.medianInputEquivalent! : null;
    const fewerRequests = ready ? holdout.medianRequests! - active.medianRequests! : null;
    // Price the request-count difference at the median control session's
    // observed per-request cost. This is a component estimate of the same
    // session difference, never an additional term in the observed delta.
    const referenceRequestCost = ready ? distribution(controls.map(s => s.spend_input_millitokens / s.requests)).median : null;
    const avoidedRequestCredit = inputEquivalent(fewerRequests === null ? null : Math.round(fewerRequests * referenceRequestCost!));
    return {
      agent, model, current: trial === currentTrial, active, holdout, comparable, earlyEstimate,
      observedDifference, fewerRequests, avoidedRequestCredit,
    };
  });
}

export function ledgerReport(projectPath: string, options: LocationOptions = {}) {
  const record = openRecordReadOnly(options);
  try {
    if (record?.diagnostic) throw new Error(record.diagnostic);
    const trial = record?.setting("global", "ledger.holdout");
    const holdoutEnabled = !!trial && /^[0-9a-f]{32}$/u.test(trial);
    const checkout = record?.checkout(projectPath);
    let samples: Sample[] = [];
    let studyProgress: StudyProgress[] = [];
    if (checkout) {
      const hooks = openHooksReadOnly(options);
      try {
        if (hooks?.diagnostic) throw new Error(hooks.diagnostic);
        if (hooks && hooks.version >= LEDGER_REPORT_SCHEMA_VERSION) {
          samples = recentSessions(hooks, checkout.project_id, checkout.path);
          if (holdoutEnabled) {
            studyProgress = hooks.all<StudyProgress>(`SELECT s.agent,t.holdout,count(*) AS assigned,count(m.session_id) AS measured
              FROM sessions s JOIN ledger_trials t USING(session_id)
              LEFT JOIN ledger_settlements l ON l.session_id=s.session_id AND l.price_profile=?
                AND s.paused=0 AND julianday(s.last_seen_at)<=julianday(l.ended_at)
              LEFT JOIN ledger_session_metrics m ON m.session_id=l.session_id AND m.trial=t.trial
              WHERE s.project_id=? AND s.checkout=? AND t.trial=? GROUP BY s.agent,t.holdout ORDER BY s.agent,t.holdout`,
            LEDGER_PRICE_PROFILE, checkout.project_id, checkout.path, trial!);
          }
        }
      } finally { hooks?.close(); }
    }
    const limited = samples.length > maxSessions;
    if (limited) samples.length = maxSessions;
    return {
      mode: LEDGER_MODE, priceProfile: LEDGER_PRICE_PROFILE, unit: "input-equivalent tokens",
      holdoutEnabled, minimumPerArm, earlyEstimatePerArm, registered: !!checkout, limited,
      sessions: medianSessions(samples), studyProgress, holdouts: compareHoldouts(samples, holdoutEnabled ? trial : undefined),
    };
  } finally { record?.close(); }
}

export function formatLedgerReport(report: ReturnType<typeof ledgerReport>): string {
  const number = new Intl.NumberFormat("en", { maximumFractionDigits: 1 });
  const amount = (value: number | null) => value === null ? "unavailable" : number.format(value);
  const signed = (value: number | null) => value !== null && value > 0 ? "+" + amount(value) : amount(value);
  const spread = (range: Quartiles | null) => range ? `${amount(range.p25)}–${amount(range.p75)}` : "unavailable";
  const lines = [
    `MEX ledger · ${report.mode}`,
    `Holdout study ${report.holdoutEnabled ? "on · 10% of new eligible sessions" : "off · enable with mex report --holdout on"}`,
    `Reference profile ${report.priceProfile} · spend and net in ${report.unit}`,
  ];
  if (!report.registered) lines.push("This checkout is unregistered.");
  else if (!report.sessions.length) lines.push("No complete MEX-on sessions measured in this checkout yet.");
  for (const session of report.sessions) {
    lines.push("", `${session.agent} / ${session.model} · median-cost session among ${session.sessions}`,
      `  Observed spend ${amount(session.observedInputEquivalent)} across ${session.requests} requests`,
      `  Host compaction net ${signed(session.hostCompactionNet)} · MEX tool-lever net ${signed(session.mexToolLeversNet)}`,
      `  MEX hook context estimate ${amount(session.mexContextTokens)} of ${amount(session.finalInputTokens)} final input tokens`);
  }
  if (report.holdoutEnabled && !report.holdouts.some(group => group.current)) {
    lines.push("", "Waiting for completed sessions in the current holdout study.");
  }
  for (const result of report.studyProgress) {
    lines.push(`${result.agent} · ${result.holdout ? "holdout" : "MEX-on"} · ${result.measured} of ${result.assigned} assigned sessions measured`);
  }
  for (const group of report.holdouts) {
    lines.push("", `${group.agent} / ${group.model} · ${group.current ? "current" : "past"} study · ${group.active.sessions} MEX-on / ${group.holdout.sessions} holdout`);
    for (const [label, data] of [["MEX-on", group.active], ["Holdout", group.holdout]] as const) {
      if (!data.sessions) continue;
      lines.push(`  ${label} median spend ${amount(data.medianInputEquivalent)} (middle 50% ${spread(data.inputEquivalentIqr)})` +
        ` · median requests ${amount(data.medianRequests)} (middle 50% ${spread(data.requestsIqr)})`);
    }
    if (group.observedDifference === null) {
      lines.push(group.comparable ? `  Collecting at least ${report.minimumPerArm} complete sessions per group.` : "  Comparable model IDs are unavailable.");
      continue;
    }
    lines.push(`  Observed spend difference (holdout minus MEX-on) ${signed(group.observedDifference)}`,
      `  Estimated avoided-request credit ${signed(group.avoidedRequestCredit)}, within that comparison`);
  }
  if (report.holdouts.some(group => group.comparable && group.earlyEstimate)) {
    lines.push("", `These estimates are early and noisy until each group has about ${report.earlyEstimatePerArm} sessions.`);
  }
  if (report.holdouts.length) lines.push("", "The study compares sessions. Task outcomes and individual lever effects are unmeasured.");
  if (report.limited) lines.push(`This view covers the latest ${maxSessions} measured sessions.`);
  return lines.join("\n");
}
