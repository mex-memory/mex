import test from 'node:test';
import assert from 'node:assert/strict';
import { gradeKnowledge, knowledgeEvidence } from '../knowledge-score.mjs';
import { validEvidence } from '../runner.mjs';

function fixture() {
  const expected = { commit: 'a'.repeat(40), corpusSha256: 'b'.repeat(64) };
  const claims = Array.from({ length: 132 }, (_, index) => ({ id: `c${index}`, source: index < 73 ? 'hand' : 'mex' }));
  const checkpoints = Array.from({ length: 6 }, (_, index) => ({ id: `C${index}`, sha: String(index + 1).repeat(40), index: index * 73 }));
  const labels = checkpoints.flatMap(cp => claims.map((claim, index) => ({ claim: claim.id, checkpoint: cp.id, truth: cp.id === 'C0' || index > 1 })));
  const corpus = { manifest: { schema_version: 2, claims: 132, labels: 792, checkpoints: 6, dataset_sha256: expected.corpusSha256 }, claims, checkpoints, labels };
  const observed = { schema_version: 1, format: 'knowledge-0.9-facts', candidate_commit: expected.commit, dataset_sha256: expected.corpusSha256,
    seeded_claims: claims.map(c => c.id), checkpoints: checkpoints.map(cp => ({ id: cp.id, sha: cp.sha, checks_ms: 45,
      results: claims.map((claim, index) => ({ claim: claim.id, verdict: cp.id === 'C0' || index > 1 ? 'held' : 'changed', inputs_changed: cp.id !== 'C0' && index < 2,
        delivery: cp.id === 'C0' || index > 1 ? 'full' : 'pointer', rank: 1, contains_original_claim: cp.id === 'C0' || index > 1 })) })) };
  return { corpus, observed, expected };
}

test('held facts and clean pointers pass; independent labels determine stale delivery', () => {
  const f = fixture(), score = gradeKnowledge(f.corpus, f.observed, f.expected);
  assert.equal(score.pass, true);
  assert.equal(score.all.counts.total, 792);
  assert.equal(score.all.counts.stale, 10);
  assert.equal(score.all.counts.staleFull, 0);
  assert.equal(score.checkpoints.C0.rates.staleServed, null);
  assert.equal(score.checkpoints.C5.rates.staleServed, 0);
  assert.equal(score.checkpoints.C5.rates.freshRetention, 1);
  assert.ok(validEvidence(knowledgeEvidence(f.corpus, f.observed, f.expected)));
  const stale = f.observed.checkpoints[5].results[0];
  Object.assign(stale, { delivery: 'full', verdict: 'held', contains_original_claim: true });
  assert.equal(gradeKnowledge(f.corpus, f.observed, f.expected).all.counts.staleFull, 1);
  assert.deepEqual(knowledgeEvidence(f.corpus, f.observed, f.expected), { status: 'fail', reason: 'checks-failed' });
});

test('broken delivery, changed full text, and unreadable changed full text fail policy', () => {
  for (const update of [{ verdict: 'broken' }, { verdict: 'changed', inputs_changed: true }, { verdict: 'unknown', inputs_changed: true }]) {
    const f = fixture();
    Object.assign(f.observed.checkpoints[1].results[5], update);
    assert.equal(gradeKnowledge(f.corpus, f.observed, f.expected).pass, false);
  }
  const f = fixture();
  Object.assign(f.observed.checkpoints[1].results[0], { verdict: 'broken' });
  assert.equal(gradeKnowledge(f.corpus, f.observed, f.expected).pass, false);
});

test('empty delivery and missing or duplicate observations cannot pass', () => {
  const f = fixture();
  for (const cp of f.observed.checkpoints) for (const row of cp.results) Object.assign(row, { delivery: 'absent', rank: null, contains_original_claim: false });
  assert.equal(gradeKnowledge(f.corpus, f.observed, f.expected).pass, false);
  for (const mutate of [f => f.observed.seeded_claims.pop(), f => f.observed.checkpoints.pop(),
    f => f.observed.checkpoints[1].results.pop(), f => f.observed.checkpoints[1].results[1] = f.observed.checkpoints[1].results[0],
    f => f.corpus.labels.pop(), f => f.corpus.labels[1] = f.corpus.labels[0]]) {
    const f = fixture(); mutate(f);
    assert.deepEqual(knowledgeEvidence(f.corpus, f.observed, f.expected), { status: 'fail', reason: 'invalid-evidence' });
  }
});

test('identity, timing, result bounds and text-bearing pointers fail closed', () => {
  for (const mutate of [f => f.observed.candidate_commit = 'c'.repeat(40), f => f.observed.dataset_sha256 = 'd'.repeat(64),
    f => f.observed.checkpoints[1].sha = 'f'.repeat(40), f => f.observed.checkpoints[1].results[0].contains_original_claim = true,
    f => f.observed.checkpoints[1].results[0].rank = 6, f => f.observed.checkpoints[1].results[0].private_text = 'DO_NOT_EMIT',
    f => f.observed.checkpoints[1].checks_ms = NaN]) {
    const f = fixture(); mutate(f);
    const result = knowledgeEvidence(f.corpus, f.observed, f.expected);
    assert.deepEqual(result, { status: 'fail', reason: 'invalid-evidence' });
    assert.ok(!JSON.stringify(result).includes('DO_NOT_EMIT'));
  }
  const f = fixture();
  f.observed.checkpoints[1].checks_ms = 1000;
  assert.deepEqual(knowledgeEvidence(f.corpus, f.observed, f.expected), { status: 'fail', reason: 'checks-failed' });
});

test('historical reports and old warning-only observations are not release evidence', () => {
  const f = fixture();
  assert.deepEqual(knowledgeEvidence(f.corpus, { version: '0.8.3', accuracy: '62.1%' }, f.expected), { status: 'fail', reason: 'invalid-evidence' });
  f.observed.format = 'legacy-wiki-health';
  assert.deepEqual(knowledgeEvidence(f.corpus, f.observed, f.expected), { status: 'fail', reason: 'invalid-evidence' });
});
