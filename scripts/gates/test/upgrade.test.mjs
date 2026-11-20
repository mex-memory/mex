import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENTRY_LINE_MAX, groundings, loadCorpus, project, UPGRADE_CORPUS_SHA256 } from '../upgrade.mjs';

const corpus = fileURLToPath(new URL('../upgrade-corpus/', import.meta.url));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
function copy() {
  const dir = mkdtempSync(join(tmpdir(), 'mex-upgrade-corpus-'));
  cpSync(corpus, dir, { recursive: true });
  return dir;
}

test('the pinned corpus loads: three real projects, four scenarios, every bundle hashed', () => {
  const { manifest, bundles } = loadCorpus();
  assert.deepEqual(manifest.subjects.map((s) => s.id), ['hono', 'novu', 'mex']);
  assert.equal(manifest.scenarios.length, 4);
  assert.equal(Object.keys(bundles['hono.json'].files).length, 25);
  assert.equal(Object.values(groundings(bundles['hono.json'].files)).flat().length, 58);
  for (const scenario of manifest.scenarios.filter((s) => s.expect.ready)) {
    assert.ok(Object.keys(scenario.expect.counts).length > 0, `${scenario.id} pins its counts`);
  }
});

test('a changed manifest or bundle is refused before any repository is built', () => {
  const dir = copy();
  try {
    const manifest = readFileSync(join(dir, 'manifest.json'), 'utf8');
    writeFileSync(join(dir, 'manifest.json'), manifest.replace('"ready": true', '"ready": false'));
    assert.throws(() => loadCorpus(dir), /manifest digest/);
    writeFileSync(join(dir, 'manifest.json'), manifest);
    const bundle = JSON.parse(readFileSync(join(dir, 'hono.json'), 'utf8'));
    bundle.files['.mex/ROUTER.md'] += '\nInjected.\n';
    writeFileSync(join(dir, 'hono.json'), JSON.stringify(bundle, null, 1) + '\n');
    assert.throws(() => loadCorpus(dir), /bundle digest/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('bundle paths cannot leave the project', () => {
  const dir = copy();
  try {
    const bundle = JSON.parse(readFileSync(join(dir, 'hono.json'), 'utf8'));
    bundle.files['../escape.md'] = 'x';
    const bytes = JSON.stringify(bundle, null, 1) + '\n';
    writeFileSync(join(dir, 'hono.json'), bytes);
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    manifest.bundles['hono.json'] = sha256(bytes);
    const text = JSON.stringify(manifest, null, 1) + '\n';
    writeFileSync(join(dir, 'manifest.json'), text);
    assert.throws(() => loadCorpus(dir, sha256(text)), /bundle path/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the pinned digest is a sha256', () => assert.match(UPGRADE_CORPUS_SHA256, /^[a-f0-9]{64}$/));

test('fixture clones check out main even when the cached bare HEAD names a missing default', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mex-upgrade-default-'));
  const seed = join(dir, 'seed'), base = join(dir, 'base.git');
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
  try {
    mkdirSync(seed); git(seed, 'init', '-b', 'main');
    writeFileSync(join(seed, 'README.md'), 'Pinned source\n');
    git(seed, 'add', '.');
    git(seed, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Source');
    const head = git(seed, 'rev-parse', 'HEAD');
    git(dir, 'clone', '--bare', seed, base);
    git(base, 'symbolic-ref', 'HEAD', 'refs/heads/master');
    const { checkout } = project(join(dir, 'work'), base, {}, {}, { scaffold: 'uncommitted', autocrlf: false });
    assert.equal(git(checkout, 'rev-parse', 'HEAD'), head);
    assert.equal(git(checkout, 'branch', '--show-current'), 'main');
    assert.equal(readFileSync(join(checkout, 'README.md'), 'utf8'), 'Pinned source\n');
    assert.equal(git(base, 'symbolic-ref', 'HEAD'), 'refs/heads/master');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the groundings an entry line cannot hold are pinned: compact already, and as many as the scenarios allow to be left out', () => {
  const { manifest, bundles } = loadCorpus();
  const tooLong = (bundle) => Object.values(groundings(bundles[bundle].files)).flat().map((pair) => pair.split(' ')[1]).filter((f) => f.length > ENTRY_LINE_MAX);
  for (const [bundle, subject] of [['hono.json', 'hono'], ['novu.json', 'novu']]) {
    const long = tooLong(bundle);
    assert.ok(long.every((f) => f.startsWith('mh2:')), `${bundle}: only compact fingerprints may be left out`);
    for (const scenario of manifest.scenarios.filter((s) => s.subject === subject && s.expect.ready)) {
      assert.equal(scenario.expect.groundingsLeftOut, long.length, scenario.id);
    }
  }
});
