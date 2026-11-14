import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statistics, main } from './codex-command-timing.mjs';

test('nearest-rank p95 and even/odd median retain outliers', () => {
  assert.deepEqual(statistics(Array.from({ length: 100 }, (_, index) => 100 - index)), { samples: 100, p50_ms: 50.5, p95_ms: 95, max_ms: 100 });
  assert.deepEqual(statistics([1, 200, 2]), { samples: 3, p50_ms: 2, p95_ms: 200, max_ms: 200 });
  assert.throws(() => statistics([]));
  assert.throws(() => statistics([NaN]));
});

test('non-Windows invocation refuses rather than emitting substitute measurements', { skip: process.platform === 'win32' }, async () => {
  await assert.rejects(main([]), /Measure on Windows/);
});
