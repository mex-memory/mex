import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GATES, required, releaseForTag, selectRelease } from '../catalog.mjs';
import { runGates, releaseReady, validReport, table } from '../runner.mjs';
import { validateMatrix } from '../matrix.mjs';
import { hookTiming } from '../hook-timing.mjs';

const commit = 'a'.repeat(40);
const source = () => ({ commit, dirty: false });
const pass = { status: 'pass', reason: 'checked', checks: { total: 1, failed: 0, skipped: 0 } };
const timing = { samples: 200, p50_ms: 3, p95_ms: 4, max_ms: 5, bare_p50_ms: 2, bare_p95_ms: 3 };
const hookPass = { ...pass, timings: { TestNoOpTiming: timing } };
const adapters = Object.fromEntries(['knowledge', 'hook-timing', 'upgrade'].map((id) => [id, async () => id === 'hook-timing' ? hookPass : pass]));
const beta = () => runGates({ root: '.', release: 'beta.1', platform: 'linux', source, adapters });

test('beta.1 requires its features and preserves visibly not-built later gates', async () => {
  assert.deepEqual(GATES.filter((gate) => required(gate, 'beta.1')).map((gate) => gate.id), ['knowledge', 'hook-timing', 'upgrade']);
  const report = await beta();
  assert.equal(releaseReady(report), true);
  assert.equal(report.gates.length, 7);
  assert.deepEqual(report.gates.filter((gate) => !gate.required).map((gate) => gate.status), Array(4).fill('not-built'));
  assert.match(table(report), /Graph quality\s+later\s+not built/);
  assert.equal(releaseReady(await runGates({ root: '.', release: 'beta.2', source, adapters })), false);
  assert.ok(GATES.every((gate) => required(gate, 'final')));
});

test('missing required adapters and failed later checks block release', async () => {
  const missing = await runGates({ root: '.', source, adapters: {} });
  assert.equal(missing.gates.every((gate) => gate.status === 'not-built'), true);
  assert.equal(releaseReady(missing), false);
  const report = await runGates({ root: '.', source, adapters: { ...adapters, replay: async () => ({ status: 'fail', reason: 'checks-failed' }) } });
  assert.equal(releaseReady(report), false);
});

test('hook timing validates the same p95 budget as the native process gate', async () => {
  for (const [p95, bareP95, ready] of [
    [17, 3, true],
    [17.02, 3, false],
    [20, 17, true],
    [20.02, 17, false],
  ]) {
    const evidence = { ...hookPass, timings: { TestNoOpTiming: {
      ...timing, p95_ms: p95, max_ms: p95, bare_p95_ms: bareP95,
    } } };
    const report = await runGates({ root: '.', source, adapters: {
      ...adapters, 'hook-timing': async () => evidence,
    } });
    assert.equal(releaseReady(report), ready, `p95=${p95}, bare p95=${bareP95}`);
  }
});

test('empty, skipped, malformed and private evidence cannot pass or leak', async () => {
  for (const evidence of [
    {}, { ...pass, checks: { total: 0, failed: 0, skipped: 0 } },
    { ...pass, checks: { total: 1, failed: 0, skipped: 1 } },
    { ...pass, reason: 'PRIVATE_SESSION' }, { ...pass, stdout: '/PRIVATE_PATH' },
    { ...hookPass, timings: { TestNoOpTiming: { ...timing, p50_ms: 100, p95_ms: 101, max_ms: 102 } } },
  ]) {
    const report = await runGates({ root: '.', source, adapters: { ...adapters, knowledge: async () => evidence } });
    assert.equal(releaseReady(report), false);
    assert.equal(report.gates[0].reason, 'invalid-evidence');
    assert.doesNotMatch(JSON.stringify(report) + table(report), /PRIVATE_/);
  }
  const report = await beta();
  assert.equal(validReport({ ...report, extra: 'PRIVATE' }), false);
  const forged = structuredClone(report);
  delete forged.gates[5].timings;
  assert.equal(validReport(forged), false);
});

test('dirty or changed checkouts cannot produce release evidence', async () => {
  const report = await runGates({ root: '.', source: () => ({ commit, dirty: true }), adapters });
  assert.equal(releaseReady(report), false);
  let calls = 0;
  await assert.rejects(runGates({ root: '.', source: () => ({ commit: (++calls === 1 ? 'a' : 'b').repeat(40), dirty: false }), adapters }), /changed/);
});

test('tagged releases select their actual feature scope and exact version', () => {
  for (const [tag, release] of [['v0.9.0-beta.1', 'beta.1'], ['0.9.0-beta.2', 'beta.2'], ['v0.9.0-rc.1', 'final'], ['v0.9.0', 'final']]) {
    assert.equal(releaseForTag(tag), release);
    assert.equal(selectRelease(undefined, { GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: tag }, tag.replace(/^v/, '')), release);
  }
  assert.throws(() => selectRelease('beta.1', { GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v0.9.0' }, '0.9.0'), /profile/);
  assert.throws(() => selectRelease(undefined, { GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v0.9.0-beta.1' }, '0.9.0-beta.0'), /version/);
  assert.throws(() => releaseForTag('v0.9.0-beta.10'));
  assert.throws(() => selectRelease('anything', {}, '0.9.0'));
});

test('matrix requires exactly three valid, clean OS reports for this commit and scope', async () => {
  const base = await beta();
  const reports = ['linux', 'darwin', 'win32'].map((platform) => ({ ...structuredClone(base), platform }));
  const expected = { commit, release: 'beta.1' };
  assert.equal(validateMatrix(reports, expected), true);
  for (const invalid of [
    reports.slice(1), [...reports, reports[0]], [reports[0], reports[0], reports[2]],
    reports.map((report, index) => index ? report : { ...report, commit: 'b'.repeat(40) }),
    reports.map((report, index) => index ? report : { ...report, dirty: true }),
    reports.map((report, index) => index ? report : { ...report, release: 'final' }),
    [null, reports[1], reports[2]],
  ]) assert.equal(validateMatrix(invalid, expected), false);
  const forged = structuredClone(reports);
  forged[0].gates[0].required = false;
  assert.equal(validateMatrix(forged, expected), false);
});

function goEvents({ skip = false, empty = false } = {}) {
  const Package = 'github.com/mex-memory/mex/native/cmd/mex-hook';
  if (empty) return JSON.stringify({ Package, Action: 'pass' });
  return [
    { Package, Test: 'TestNoOpTiming', Action: 'run' },
    { Package, Test: 'TestNoOpTiming', Action: 'output', Output: 'mex-hook no-op: runs=200 p50=3.00ms p95=4.00ms max=5.00ms | bare process p50=2.00ms p95=3.00ms' },
    { Package, Test: 'TestNoOpTiming', Action: skip ? 'skip' : 'pass' },
    { Package, Action: 'pass' },
  ].map((event) => JSON.stringify(event)).join('\n');
}

test('hook adapter requires actual named timing tests and pins budget and cache controls', async () => {
  let options;
  const result = await hookTiming({ root: '/fixture', run: async (command, args, opts) => {
    assert.equal(command, 'go');
    assert.ok(args.includes('-count=1'));
    assert.match(args[args.indexOf('-run') + 1], /WithCounters/);
    options = opts;
    return { code: 0, stdout: goEvents() };
  } });
  assert.deepEqual(result, hookPass);
  assert.equal(options.env.MEX_HOOK_BUDGET_MS, '');
  assert.equal(options.env.GOFLAGS, '');
  for (const result of [{ code: 0, stdout: goEvents({ empty: true }) }, { code: 0, stdout: goEvents({ skip: true }) }, { code: 1, stdout: 'PRIVATE_SESSION' }, { reason: 'timeout', code: null, stdout: 'PRIVATE_SESSION' }]) {
    const evidence = await hookTiming({ root: '.', run: async () => result });
    assert.equal(evidence.status, 'fail');
    assert.doesNotMatch(JSON.stringify(evidence), /PRIVATE_/);
  }
});
