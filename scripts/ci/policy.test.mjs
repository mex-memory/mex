import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classify, changedPaths } from './scope.mjs';
import { assertPassed } from './passed.mjs';
import { trackPerformanceFailure } from './performance-issue.mjs';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { matchesGlob } from 'node:path';
import CISequencer, { shardForPath } from './sequencer.mjs';

test('scope exempts only unconsumed prose and runs everything on pushes', () => {
  for (const path of ['docs/extractors.md', 'docs/design/new-note.md', 'docs/diagrams/readme/setup.svg']) assert.equal(classify([path]).docsOnly, true, path);
  for (const path of ['README.md', 'TELEMETRY.md', 'COMPATIBILITY.md', 'THIRD_PARTY_NOTICES.md', 'docs/design/release-0.9-calibration.json', 'docs/example.ts', 'skills/mex-statechart/SKILL.md', 'test/a.test.ts', '.github/workflows/ci.yml']) assert.equal(classify([path]).docsOnly, false, path);
  assert.equal(classify([]).docsOnly, false);
  assert.equal(classify(['docs/extractors.md'], 'push').docsOnly, false);
  assert.equal(classify(['.github/workflows/ci.yml']).workflows, true);
  assert.equal(classify(['docs/extractors.md', 'src/cli.ts']).docsOnly, false);
});

test('diff uses the merge base, NUL paths, and both sides of renames', () => {
  const calls = [];
  const paths = changedPaths('a'.repeat(40), 'b'.repeat(40), (args) => {
    calls.push(args); return calls.length === 1 ? 'c'.repeat(40) + '\n' : 'src/old.ts\0docs/new.md\0docs/a b.md\0';
  });
  assert.deepEqual(paths, ['src/old.ts', 'docs/new.md', 'docs/a b.md']);
  assert.deepEqual(calls[1], ['diff', '--no-renames', '--name-only', '-z', 'c'.repeat(40), 'b'.repeat(40)]);
  assert.equal(classify(paths).docsOnly, false);
  assert.throws(() => changedPaths('--bad', 'b'.repeat(40)));
});

function needs(docsOnly = false) {
  return Object.fromEntries(['changes', 'check', 'package', 'go', 'storage-portability', 'hub-browser', 'actionlint'].map((job) => [job, { result: 'success', ...(job === 'changes' ? { outputs: { docs_only: String(docsOnly) } } : {}) }]));
}

test('aggregate refuses failures, cancellations and unexpected skips', () => {
  assertPassed(needs());
  for (const job of Object.keys(needs())) for (const result of ['failure', 'cancelled', 'skipped']) {
    const jobs = needs(); jobs[job].result = result;
    assert.throws(() => assertPassed(jobs), undefined, `${job}: ${result}`);
  }
  const docs = needs(true);
  for (const job of ['check', 'package', 'go', 'storage-portability', 'hub-browser']) docs[job].result = 'skipped';
  assertPassed(docs);
  docs.go.result = 'failure'; assert.throws(() => assertPassed(docs));
  docs.go.result = 'skipped'; docs.actionlint.result = 'skipped'; assert.throws(() => assertPassed(docs));
});


test('shards cover every file exactly once and separate the two slowest files', async () => {
  const paths = ['test/setup-e2e-matrix.test.ts', 'test/team-inbox-spec-authoring-real.contract.test.ts', 'src/new.test.ts', 'test/path with spaces.test.ts'];
  assert.notEqual(shardForPath(paths[0], 2), shardForPath(paths[1], 2));
  assert.equal(shardForPath('test\\new.test.ts', 2), shardForPath('test/new.test.ts', 2));
  for (const count of [1, 2, 3, 4]) {
    const specs = paths.map((path) => ({ moduleId: new URL('../../' + path, import.meta.url).pathname }));
    const root = new URL('../../', import.meta.url).pathname;
    const buckets = await Promise.all(Array.from({ length: count }, (_, i) => new CISequencer({ config: { root, shard: { index: i + 1, count } } }).shard(specs)));
    assert.equal(buckets.flat().length, specs.length);
    assert.equal(new Set(buckets.flat()).size, specs.length);
  }
});


test('performance failures create one tracking issue then comment on it', () => {
  const issues = []; const calls = []; let body;
  const options = { env: { GITHUB_SHA: 'a'.repeat(40), GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'example/project', GITHUB_RUN_ID: '123' }, write: (_path, value) => { body = value; }, run: (args) => {
    calls.push(args);
    if (args[1] === 'list') return JSON.stringify(issues);
    if (args[1] === 'create') issues.push({ number: 7, title: args[args.indexOf('--title') + 1] });
    return '';
  } };
  trackPerformanceFailure(options); trackPerformanceFailure(options);
  assert.equal(calls.filter((args) => args[1] === 'create').length, 1);
  assert.equal(calls.filter((args) => args[1] === 'comment').length, 1);
  assert.match(body, /https:\/\/github.com\/example\/project\/actions\/runs\/123/);
  assert.ok(calls.at(-1).includes('--body-file'));
  assert.throws(() => trackPerformanceFailure({ ...options, run: () => JSON.stringify(Array.from({ length: 1000 }, (_, number) => ({ number, title: 'Other issue' }))) }), /limit reached/);
});

test('the aggregate covers every gating job and advisory performance has no PR trigger', () => {
  const workflow = parse(readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8'));
  const jobs = workflow.jobs;
  for (const name of Object.keys(jobs)) {
    if (name === 'ci-passed') continue;
    assert.ok(jobs['ci-passed'].needs.includes(name), `${name} missing from aggregate`);
    assert.equal(jobs[name].permissions?.issues, undefined);
  }
  assert.equal(jobs['ci-passed'].if, 'always()');
  const advisory = parse(readFileSync(new URL('../../.github/workflows/release-performance.yml', import.meta.url), 'utf8'));
  assert.equal(advisory.on.pull_request, undefined);
  assert.deepEqual(advisory.on.push.branches, ['main', 'next']);
  assert.ok('workflow_dispatch' in advisory.on);
  assert.deepEqual(advisory.on.push.tags, ['v0.9.0*', '0.9.0*']);
  assert.equal(Object.keys(advisory.jobs).length, 3);
  assert.equal(advisory.jobs['release-performance'].permissions.issues, 'write');
  assert.equal(advisory.jobs['release-performance'].concurrency['cancel-in-progress'], false);
  for (const [name, job] of Object.entries(advisory.jobs)) if (name !== 'release-performance') assert.equal(job.permissions?.issues, undefined);
});


test('statechart qualification includes every skill surface and excludes ordinary prose', () => {
  const workflow = parse(readFileSync(new URL('../../.github/workflows/statechart-checker.yml', import.meta.url), 'utf8'));
  const triggers = (path) => workflow.on.pull_request.paths.some((pattern) => matchesGlob(path, pattern));
  for (const path of ['src/statechart/checker.ts', 'skills/mex-statechart/upstream/scripts/lib.mjs', '.claude/skills/mex-statechart/SKILL.md', '.agents/skills/mex-statechart/SKILL.md', 'packages/hub-contracts/src/statechart.ts', 'packages/hub-web/src/pages/DiagramsPage.tsx', 'packages/hub-web/src/components/StatechartCanvas.tsx', 'scripts/statechart-pack-smoke.mjs', 'vitest.statechart.config.ts', 'package.json', 'package-lock.json', '.github/workflows/statechart-checker.yml']) assert.equal(triggers(path), true, path);
  for (const path of ['docs/extractors.md', 'src/knowledge/store.ts', 'packages/hub-web/src/pages/RelaysPage.tsx', 'src/hub/setup/engine.ts', 'packages/hub-web/src/styles/relay.module.css']) assert.equal(triggers(path), false, path);
  assert.deepEqual(workflow.on.push.branches, ['main', 'next']);
  assert.equal(workflow.concurrency['cancel-in-progress'], true);
});
