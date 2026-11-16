import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { groundings, loadCorpus, UPGRADE_CORPUS_SHA256 } from '../upgrade.mjs';

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
