import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { priceSession } from '../../delivery-replay/cost.mjs';
import { checkReplaySession, loadReplayCorpus, replayEvidence, replayGate } from '../replay.mjs';

const corpusDir = fileURLToPath(new URL('../replay-corpus/', import.meta.url));
const failed = { status: 'fail', reason: 'checks-failed' };
const outcome = (session, replies = session.expected, receipts = []) => ({
  replies, receipts, probes: session.entries.filter(({ verdict }) => verdict !== 'held')
    .map(({ id, verdict }) => ({ id, verdict, form: 'withheld' })),
});

test('replay refuses a tampered manifest and a tampered file under the pinned manifest', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mex-replay-tamper-'));
  const manifest = join(dir, 'manifest.json');
  const source = join(corpusDir, 'manifest.json');
  const data = JSON.parse(readFileSync(source));
  const file = Object.keys(data.files)[0];
  const folder = join(dir, file.split('/')[0]);
  mkdirSync(folder);
  try {
    const diagnostics = [];
    const invoke = () => replayGate({ root: '.', directory: dir, diagnose: (reason) => diagnostics.push(reason) });
    writeFileSync(manifest, JSON.stringify(data));
    assert.deepEqual(await invoke(), failed);
    assert.deepEqual(diagnostics, ['Manifest digest differs']);
    copyFileSync(source, manifest);
    writeFileSync(join(dir, file), 'tampered');
    assert.deepEqual(await invoke(), failed);
    assert.deepEqual(diagnostics, ['Manifest digest differs', 'Corpus file digest differs']);
  } finally {
    unlinkSync(manifest);
    unlinkSync(join(dir, file));
    rmdirSync(folder);
    rmdirSync(dir);
  }
});

test('a stale claim in the reviewed replies or a full stale receipt fails the gate', () => {
  const [session] = loadReplayCorpus(corpusDir).sessions;
  const stale = session.entries.find(({ verdict }) => verdict === 'changed');
  const replies = structuredClone(session.expected);
  replies[0].reply = { context: stale.forbidden[0] };
  const leaked = outcome(session, replies);
  const checks = checkReplaySession({ ...session, expected: replies }, leaked, leaked);
  assert.deepEqual(replayEvidence(checks), failed);
  assert.match(checks.find(({ failed }) => failed).failed, /entry text/);

  const full = outcome(session, session.expected, [{ entry_id: stale.id, action: 'given', form: 'full' }]);
  assert.deepEqual(replayEvidence(checkReplaySession(session, full, full)), failed);
  const pointer = outcome(session, session.expected, [{ entry_id: stale.id, action: 'replaced', form: 'pointer' }]);
  assert.deepEqual(replayEvidence(checkReplaySession(session, pointer, pointer)), {
    status: 'pass', reason: 'checked', checks: { total: 5, failed: 0, skipped: 0 },
  });
});

test('nondeterminism fails even when the first run matches the expected bytes', () => {
  const [session] = loadReplayCorpus(corpusDir).sessions;
  const first = outcome(session);
  const second = structuredClone(first);
  second.replies[0].reply = { context: 'Changed on the second run.' };
  const checks = checkReplaySession(session, first, second);
  assert.deepEqual(replayEvidence(checks), failed);
  assert.match(checks.find(({ failed }) => failed).failed, /nondeterministic/);
});

test('both native sessions have four priced classes and missing usage fails', () => {
  const [claude, codex] = loadReplayCorpus(corpusDir).sessions;
  const classes = ['input', 'cache_write', 'cache_read', 'output'];
  assert.deepEqual(Object.keys(priceSession(claude.records, claude.agent)), classes);
  const cost = priceSession(codex.records, codex.agent);
  assert.deepEqual(Object.keys(cost), classes);
  assert.deepEqual(cost, {
    input: { tokens: 64, dollars: 0.000128 },
    cache_write: { tokens: 0, dollars: 0 },
    cache_read: { tokens: 96, dollars: 0.000009600000000000001 },
    output: { tokens: 52, dollars: 0.00052 },
  });
  assert.deepEqual(priceSession([...codex.records, codex.records.at(-1)], codex.agent), cost);
  assert.throws(() => priceSession([], codex.agent), /Missing priced usage/);
});

test('the pinned replies cover the recorded delivery moments', () => {
  const [claude, codex] = loadReplayCorpus(corpusDir).sessions;
  const reply = (session, index) => session.expected[index].reply.hookSpecificOutput;
  assert.match(reply(claude, 0).additionalContext, /mx_brief01/);
  assert.deepEqual(claude.expected[1], { event: 'UserPromptSubmit', reply: {} });
  assert.match(reply(claude, 2).additionalContext, /^\[mex block\]\npool\.ts:1 export function rotatePool\(\) \{$/);
  assert.match(reply(claude, 4).additionalContext, /mx_recipe01/);
  assert.match(reply(claude, 6).additionalContext, /mx_fix001/);
  assert.match(reply(claude, 8).additionalContext, /mx_pool01/);
  assert.equal(reply(claude, 9).permissionDecision, 'deny');
  assert.match(reply(claude, 9).permissionDecisionReason, /openRawPool/);
  assert.deepEqual(claude.expected[15], { event: 'PostCompact', reply: {} });
  assert.match(reply(codex, 0).additionalContext, /mx_brief01/);
  assert.match(reply(codex, 3).additionalContext, /cache\.ts:1-3\n.*openCache/);
});
