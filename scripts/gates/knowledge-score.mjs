// Knowledge-03 supplies observations from the real evaluator/delivery path.
// This module scores them; it is not registered as a live adapter by itself.
// Historical percentages and legacy health flags are never current evidence.
const CLAIMS = 132;
const CHECKPOINTS = 6;
const CHECK_BUDGET_MS = 1000;
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const DIGEST = /^[0-9a-f]{64}$/;
const invalid = () => { throw new Error('Invalid knowledge benchmark evidence'); };
const keys = (value, allowed) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === allowed.length && allowed.every(key => Object.hasOwn(value, key));
const fraction = (numerator, denominator) => denominator ? numerator / denominator : null;

function corpusRows(corpus, expected) {
  if (!expected || typeof expected.commit !== 'string' || typeof expected.corpusSha256 !== 'string'
    || !SHA.test(expected.commit) || !DIGEST.test(expected.corpusSha256)
    || corpus?.manifest?.schema_version !== 2 || corpus.manifest.claims !== CLAIMS
    || corpus.manifest.labels !== CLAIMS * CHECKPOINTS || corpus.manifest.checkpoints !== CHECKPOINTS
    || corpus.manifest.dataset_sha256 !== expected.corpusSha256
    || !Array.isArray(corpus.claims) || corpus.claims.length !== CLAIMS
    || !Array.isArray(corpus.checkpoints) || corpus.checkpoints.length !== CHECKPOINTS
    || !Array.isArray(corpus.labels) || corpus.labels.length !== CLAIMS * CHECKPOINTS) invalid();
  const claimIds = new Set();
  for (const claim of corpus.claims) {
    if (typeof claim.id !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(claim.id)
      || !['hand', 'mex'].includes(claim.source) || claimIds.has(claim.id)) invalid();
    claimIds.add(claim.id);
  }
  for (const [index, cp] of corpus.checkpoints.entries()) {
    if (cp.id !== `C${index}` || typeof cp.sha !== 'string' || !SHA.test(cp.sha) || !Number.isSafeInteger(cp.index)
      || (index === 0 ? cp.index !== 0 : cp.index <= corpus.checkpoints[index - 1].index)) invalid();
  }
  const labels = new Map();
  for (const label of corpus.labels) {
    const key = `${label.claim}/${label.checkpoint}`;
    if (!claimIds.has(label.claim) || !corpus.checkpoints.some(cp => cp.id === label.checkpoint)
      || typeof label.truth !== 'boolean' || labels.has(key) || label.checkpoint === 'C0' && !label.truth) invalid();
    labels.set(key, label.truth);
  }
  return { claimIds, labels };
}

export function gradeKnowledge(corpus, observed, expected) {
  const { claimIds, labels } = corpusRows(corpus, expected);
  if (!keys(observed, ['schema_version', 'format', 'candidate_commit', 'dataset_sha256', 'seeded_claims', 'checkpoints'])
    || observed.schema_version !== 1 || observed.format !== 'knowledge-0.9-facts'
    || observed.candidate_commit !== expected.commit || observed.dataset_sha256 !== expected.corpusSha256
    || !Array.isArray(observed.seeded_claims) || observed.seeded_claims.length !== CLAIMS
    || new Set(observed.seeded_claims).size !== CLAIMS || observed.seeded_claims.some(id => !claimIds.has(id))
    || !Array.isArray(observed.checkpoints) || observed.checkpoints.length !== CHECKPOINTS) invalid();
  const flat = [];
  const timings = [];
  let policyViolations = 0;
  let failedRows = 0;
  for (const [index, checkpoint] of observed.checkpoints.entries()) {
    const pin = corpus.checkpoints[index];
    if (!keys(checkpoint, ['id', 'sha', 'checks_ms', 'results']) || checkpoint.id !== pin.id || checkpoint.sha !== pin.sha
      || !Number.isFinite(checkpoint.checks_ms) || checkpoint.checks_ms < 0
      || !Array.isArray(checkpoint.results) || checkpoint.results.length !== CLAIMS) invalid();
    timings.push({ checkpoint: pin.id, checks_ms: checkpoint.checks_ms });
    const seen = new Set();
    for (const row of checkpoint.results) {
      if (!keys(row, ['claim', 'verdict', 'inputs_changed', 'delivery', 'rank', 'contains_original_claim'])
        || !claimIds.has(row.claim) || seen.has(row.claim)
        || !['held', 'changed', 'broken', 'unknown'].includes(row.verdict)
        || typeof row.inputs_changed !== 'boolean' || row.verdict === 'changed' && !row.inputs_changed
        || !['full', 'pointer', 'withheld', 'absent'].includes(row.delivery)
        || typeof row.contains_original_claim !== 'boolean'
        || row.rank !== null && (!Number.isInteger(row.rank) || row.rank < 1 || row.rank > 5)) invalid();
      const delivered = row.delivery === 'full' || row.delivery === 'pointer';
      if (delivered !== (row.rank !== null) || row.contains_original_claim !== (row.delivery === 'full')) invalid();
      const policyViolation = delivered && row.verdict === 'broken'
        || row.delivery === 'full' && (row.verdict === 'changed' || row.verdict === 'unknown' && row.inputs_changed);
      if (policyViolation) policyViolations++;
      const truth = labels.get(`${row.claim}/${pin.id}`);
      if (policyViolation || !truth && row.delivery === 'full') failedRows++;
      seen.add(row.claim);
      flat.push({ ...row, checkpoint: pin.id, truth });
    }
  }
  const summarize = rows => {
    const n = predicate => rows.filter(predicate).length;
    const counts = { total: rows.length, true: n(r => r.truth), stale: n(r => !r.truth),
      trueFull: n(r => r.truth && r.delivery === 'full'), staleFull: n(r => !r.truth && r.delivery === 'full'),
      pointers: n(r => r.delivery === 'pointer'), withheld: n(r => r.delivery === 'withheld'), absent: n(r => r.delivery === 'absent'),
      brokenDelivered: n(r => r.verdict === 'broken' && r.rank !== null) };
    return { counts, rates: { staleServed: fraction(counts.staleFull, counts.stale),
      freshRetention: fraction(counts.trueFull, counts.true),
      accuracy: fraction(counts.trueFull + counts.stale - counts.staleFull, counts.total) } };
  };
  const all = summarize(flat);
  const checkpoints = Object.fromEntries(corpus.checkpoints.map(cp => [cp.id, summarize(flat.filter(row => row.checkpoint === cp.id))]));
  // Seed/read integrity at C0 cannot be replaced by an empty search result.
  const c0Ready = flat.filter(r => r.checkpoint === 'C0').every(r => r.verdict === 'held') && checkpoints.C0.counts.trueFull > 0;
  const slowCheckpoints = timings.filter(t => t.checks_ms >= CHECK_BUDGET_MS).length;
  const failed = failedRows + slowCheckpoints + (c0Ready ? 0 : 1);
  return { pass: failed === 0, checks: { total: CLAIMS * CHECKPOINTS + CHECKPOINTS + 1, failed, skipped: 0 },
    all, checkpoints, timings, checkBudgetMs: CHECK_BUDGET_MS, c0Ready, policyViolations };
}

// Only this narrow result belongs in the public three-OS report. The caller
// must first verify corpus file hashes and collect actual product observations
// on the current clean checkout; a JSON file alone is not a live adapter.
export function knowledgeEvidence(corpus, observed, expected) {
  try {
    const score = gradeKnowledge(corpus, observed, expected);
    return score.pass ? { status: 'pass', reason: 'checked', checks: score.checks }
      : { status: 'fail', reason: 'checks-failed' };
  } catch {
    return { status: 'fail', reason: 'invalid-evidence' };
  }
}
