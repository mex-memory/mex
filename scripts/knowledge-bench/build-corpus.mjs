#!/usr/bin/env node
// Builds the deterministic knowledge corpus from a full clone of the subject:
//   node scripts/knowledge-bench/build-corpus.mjs --subject <hono clone> --out <dir>
// Writes manifest.json, claims.json, checkpoints.json and labels.json. The
// same clone always gives the same files and digest. No model is called.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CLAIMS, SUBJECT } from './claims.mjs';

export const CHECKPOINTS = 6;

export function git(repo, ...args) {
  return execFileSync('git', ['-c', 'safe.directory=*', '-C', repo, ...args], { encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'pipe'] });
}

/** C0 = T0 and Ck = the first-parent commit at position round(k*N/5). */
export function checkpoints(repo) {
  const list = git(repo, 'rev-list', '--first-parent', '--reverse', `${SUBJECT.t0}..${SUBJECT.t1}`).trim().split('\n');
  const out = [{ id: 'C0', sha: SUBJECT.t0, index: 0 }];
  for (let k = 1; k < CHECKPOINTS; k++) {
    const index = Math.round(k * list.length / (CHECKPOINTS - 1));
    out.push({ id: `C${k}`, sha: list[index - 1], index });
  }
  if (out.at(-1).sha !== SUBJECT.t1) throw new Error('subject history does not end at T1');
  return out;
}

export function shower(repo, sha) {
  const cache = new Map();
  return path => {
    if (!cache.has(path)) {
      let text = null;
      try { text = git(repo, 'show', `${sha}:${path}`); } catch { text = null; }
      cache.set(path, text);
    }
    return cache.get(path);
  };
}

const digest = text => createHash('sha256').update(text).digest('hex');

export function datasetDigest(files) {
  return digest(['claims.json', 'checkpoints.json', 'labels.json'].map(f => `${f}:${digest(files[f])}`).join('\n'));
}

export function buildCorpus(repo) {
  const cps = checkpoints(repo);
  const labels = [];
  for (const cp of cps) {
    const show = shower(repo, cp.sha);
    for (const c of CLAIMS) {
      const truth = c.truth(show);
      if (cp.id === 'C0' && !truth) throw new Error(`claim ${c.id} does not hold at T0`);
      labels.push({ claim: c.id, checkpoint: cp.id, truth });
    }
  }
  const claims = CLAIMS.map(c => ({ id: c.id, source: 'hand', category: c.category, one_line: c.oneLine, file: c.file, check: c.check }));
  const files = {
    'claims.json': JSON.stringify(claims, null, 1) + '\n',
    'checkpoints.json': JSON.stringify(cps, null, 1) + '\n',
    'labels.json': JSON.stringify(labels, null, 1) + '\n',
  };
  const manifest = {
    schema_version: 2, kind: 'deterministic-hand-written', subject: SUBJECT,
    note: 'Hand-written claims with checks recorded by the evaluator at T0 and independent truth functions; not a corpus written by setup or capture.',
    claims: claims.length, checkpoints: cps.length, labels: labels.length, dataset_sha256: datasetDigest(files),
  };
  return { files, manifest, corpus: { manifest, claims, checkpoints: cps, labels } };
}

if (import.meta.url === `file://${process.argv[1]?.replaceAll('\\', '/')}` || process.argv[1]?.endsWith('build-corpus.mjs')) {
  const arg = name => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
  const subject = arg('--subject'), out = arg('--out');
  if (!subject || !out) { console.error('usage: build-corpus.mjs --subject <clone> --out <dir>'); process.exit(2); }
  const { files, manifest } = buildCorpus(resolve(subject));
  mkdirSync(out, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(out, name), text);
  writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 1) + '\n');
  const stale = JSON.parse(files['labels.json']).filter(l => !l.truth).length;
  console.log(JSON.stringify({ claims: manifest.claims, labels: manifest.labels, stale, dataset_sha256: manifest.dataset_sha256 }));
}
