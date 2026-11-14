import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { makePlan, authorize, requireEvidence, optionalFor, TARGETS } from './plan.mjs';
import { checkManifest, verifyBundle } from './bundle.mjs';
import { publishBundle, githubReleaseArgs } from './publish.mjs';
import { localRegistry } from './registry.mjs';
import { npm, run, npmEnvironment } from './commands.mjs';

const commit = 'a'.repeat(40), version = '0.9.0-beta.1';
const input = (extra = {}) => ({ event: 'pull_request', version, commit, platformVersions: Array(6).fill(extra.version || version), ...extra });
const plan = makePlan(input());
const passing = { result: 'success', commit };

test('tags must match all seven versions and select exact dist-tags', () => {
  for (const v of ['0.9.0-beta.1', '0.9.0-beta.2', '0.9.0-rc.3', '0.9.0']) {
    const p = makePlan(input({ version: v, event: 'push', refType: 'tag', refName: 'v' + v }));
    assert.equal(p.distTag, v.includes('-') ? 'next' : 'latest'); assert.equal(p.dryRun, false); assert.equal(p.requireGates, true);
    assert.equal(p.packages.length, 7); assert.equal(p.packages.at(-1).name, 'mex-agent');
  }
  assert.throws(() => makePlan(input({ event: 'push', refType: 'tag', refName: 'v0.9.0' })), /Tag/);
  assert.throws(() => makePlan(input({ platformVersions: [version, version, version, version, version, '0.9.0'] })), /versions/);
  assert.throws(() => makePlan(input({ version: '0.9.0-alpha.1' })), /version/);
  assert.throws(() => makePlan(input({ event: 'push', refType: 'branch' })), /tag/);
});

test('PRs always rehearse; manual defaults require gates; real releases cannot bypass', () => {
  assert.equal(makePlan(input({ dryRun: false, requireGates: true })).dryRun, true);
  assert.equal(plan.requireGates, false);
  const manual = makePlan(input({ event: 'workflow_dispatch' }));
  assert.equal(manual.dryRun, true); assert.equal(manual.requireGates, true);
  assert.throws(() => makePlan(input({ event: 'workflow_dispatch', dryRun: false, requireGates: false })), /cannot bypass/);
  assert.throws(() => authorize({ ...plan, dryRun: false }, {}), /cannot bypass/);
  assert.match(authorize(plan, { result: 'skipped' }), /Gates were skipped.*real release would need/);
});

test('same-commit evidence is mandatory and absence really refuses', () => {
  const real = { ...plan, dryRun: false, requireGates: true };
  for (const evidence of [{}, { result: 'skipped', commit }, { result: 'failure', commit }, { result: 'success', commit: 'b'.repeat(40) }]) {
    assert.throws(() => requireEvidence(real, evidence), /exact commit/);
    assert.throws(() => authorize(real, evidence), /exact commit/);
  }
  assert.match(authorize(real, passing), /passed/);
  assert.throws(() => authorize(plan, passing), /Expected absent/);
});

test('every packed manifest must be exact and cannot omit platform constraints', () => {
  const root = plan.packages.at(-1);
  checkManifest({ name: root.name, version, optionalDependencies: optionalFor(version) }, root, plan);
  assert.throws(() => checkManifest({ name: root.name, version, optionalDependencies: {} }, root, plan), /exactly six/);
  assert.throws(() => checkManifest({ name: root.name, version: '0.9.0', optionalDependencies: optionalFor(version) }, root, plan), /mismatch/);
  const entry = plan.packages[0];
  assert.throws(() => checkManifest({ name: entry.name, version, os: ['linux'], cpu: ['arm64'] }, entry, plan), /constraints/);
});

test('publication rehearses all seven in order with no credentials; retries skip only existing versions', async () => {
  const calls = [];
  const invoke = async (args, options) => { calls.push({ args, options }); return ''; };
  await publishBundle('/bundle', plan, {}, { invoke, log: () => {}, verify: async () => {} });
  assert.equal(calls.length, 7);
  calls.forEach(({ args, options }, index) => {
    assert.ok(args.includes('--dry-run')); assert.ok(args.includes('--provenance')); assert.ok(args.includes(plan.packages[index].file) || args.some((arg) => arg.endsWith(plan.packages[index].file)));
    assert.equal(args[args.indexOf('--tag') + 1], 'next'); assert.equal(options.env.NODE_AUTH_TOKEN, '');
  });
  const published = [];
  const real = { ...plan, dryRun: false, requireGates: true };
  await publishBundle('/bundle', real, passing, { log: () => {}, verify: async () => {}, env: { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'push', GITHUB_SHA: commit }, invoke: async (args) => {
    if (args[0] === 'view') { if (args[1].startsWith(real.packages[0].name + '@')) return JSON.stringify(version); throw Object.assign(new Error('not found'), { stderr: 'E404' }); }
    published.push(args); return '';
  } });
  assert.equal(published.length, 6); assert.ok(published.at(-1)[1].endsWith('mex-agent-' + version + '.tgz'));
  await assert.rejects(publishBundle('/bundle', real, passing, { log: () => {}, verify: async () => {}, env: { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'push', GITHUB_SHA: commit }, invoke: async () => { throw new Error('network unavailable'); } }), /network unavailable/);
});

test('tampered bundle checksum fails before extraction or publishing', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mex-release-checksum-'));
  writeFileSync(join(directory, 'release-plan.json'), JSON.stringify(plan));
  for (const entry of plan.packages) writeFileSync(join(directory, entry.file), 'tampered');
  writeFileSync(join(directory, 'SHA256SUMS'), plan.packages.map((entry) => '0'.repeat(64) + '  ' + entry.file).join('\n'));
  await assert.rejects(verifyBundle(directory, plan), /checksum/);
});

test('read-only registry gives npm all six choices and npm installs only the host', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mex-release-registry-'));
  for (const entry of plan.packages) {
    const source = join(directory, entry.name); mkdirSync(join(source, 'package'), { recursive: true });
    const [os, cpu] = (entry.target || '').split('-');
    writeFileSync(join(source, 'package/package.json'), JSON.stringify({ name: entry.name, version, ...(entry.target ? { os: [os], cpu: [cpu] } : { optionalDependencies: optionalFor(version) }) }));
    await run('tar', ['-czf', '../' + entry.file, 'package'], { cwd: source });
  }
  const registry = await localRegistry(directory, plan);
  try {
    const metadata = await (await fetch(registry.origin + '/mex-agent')).json();
    assert.equal(Object.keys(metadata.versions[version].optionalDependencies).length, 6);
    const project = join(directory, 'consumer'); mkdirSync(project); writeFileSync(join(project, 'package.json'), '{"private":true}');
    await npm(['install', `mex-agent@${version}`, '--registry', registry.origin, '--cache', join(directory, 'cache'), '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: project, env: npmEnvironment() });
    const lock = JSON.parse(readFileSync(join(project, 'package-lock.json')));
    assert.equal(lock.packages['node_modules/mex-agent'].version, version);
    // npm may keep unsupported optional metadata in the lock; actual install is decisive.
    const installed = TARGETS.filter((target) => { try { readFileSync(join(project, 'node_modules/mex-agent-hook-' + target + '/package.json')); return true; } catch { return false; } });
    assert.deepEqual(installed, [`${process.platform}-${process.arch}`]);
  } finally { await registry.close(); }
});

test('workflow authorization, reusable gates, credentials and fast-disk topology stay structural', () => {
  const workflow = parse(readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8'));
  assert.equal(workflow.on.workflow_dispatch.inputs.dry_run.default, true);
  assert.equal(workflow.on.workflow_dispatch.inputs.require_gates.default, true);
  assert.equal(workflow.concurrency['cancel-in-progress'], false);
  for (const name of ['build', 'smoke', 'dry-run', 'publish', 'github-release']) assert.ok(workflow.jobs[name].needs.includes('release-gates'));
  assert.equal(workflow.jobs['gate-checks'].uses, './.github/workflows/gates.yml');
  assert.equal(workflow.jobs['release-gates'].name, 'Release authorization');
  assert.equal(workflow.jobs.publish.environment, 'npm-publish');
  assert.equal(workflow.jobs.publish.permissions['id-token'], 'write');
  assert.match(workflow.jobs.publish.if, /github.event_name != 'pull_request'/);
  assert.equal(workflow.jobs['dry-run'].environment, undefined);
  assert.equal(workflow.jobs['dry-run'].permissions?.['id-token'], undefined);
  for (const [name, job] of Object.entries(workflow.jobs)) if (name !== 'github-release') assert.notEqual(job.permissions?.contents, 'write');
  assert.equal(workflow.jobs.smoke.steps[0].name, 'Keep temporary files on the fast disk');
  const gates = parse(readFileSync(new URL('../../.github/workflows/gates.yml', import.meta.url), 'utf8'));
  assert.ok(gates.on.workflow_call); assert.ok(gates.on.workflow_dispatch); assert.equal(gates.on.push, undefined);
  assert.ok(gates.jobs['release-gates']); assert.equal(gates.jobs.gates.steps[0].name, 'Keep temporary files on the fast disk');
  assert.ok(githubReleaseArgs('/bundle', plan).includes('--prerelease'));
  assert.ok(githubReleaseArgs('/bundle', plan).includes('--verify-tag'));
});
