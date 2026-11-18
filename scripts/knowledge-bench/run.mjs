#!/usr/bin/env node
// Runs the knowledge bench through the real product:
//   node scripts/knowledge-bench/run.mjs --subject <hono clone> --corpus <dir>
//        [--binary <mex-hook>] [--work <dir>] [--out observed.json]
//
// At C0 it registers a worktree of the subject with MEX (`mex index`), records
// each claim's check with the real evaluator and writes the claims as team
// entries. At each checkpoint it moves the worktree, refreshes the file index,
// runs the evaluator (`mex-hook --check-run`, storing verdicts) and asks the
// delivery controller what it would send (`mex-hook --delivery-probe`). The
// observations are scored by scripts/gates/knowledge-score.mjs.
//
// Swap in another corpus with --corpus: any directory with the same four
// files and a matching digest works, including one written by setup.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { datasetDigest, git } from './build-corpus.mjs';
import { gradeKnowledge } from '../gates/knowledge-score.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export function loadCorpus(dir) {
  const files = Object.fromEntries(['claims.json', 'checkpoints.json', 'labels.json'].map(f => [f, readFileSync(join(dir, f), 'utf8')]));
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  if (datasetDigest(files) !== manifest.dataset_sha256) throw new Error('corpus files do not match their manifest digest');
  return { manifest, claims: JSON.parse(files['claims.json']), checkpoints: JSON.parse(files['checkpoints.json']), labels: JSON.parse(files['labels.json']) };
}

export const entryId = claim => `mx_kbx${claim.replace(/[^a-z0-9]/g, '')}`;

function hook(binary, flag, request, env) {
  const r = spawnSync(binary, [flag], { input: JSON.stringify(request), encoding: 'utf8', env: { ...env, MEX_BACKGROUND: '1' }, maxBuffer: 64 << 20, timeout: 120_000, windowsHide: true });
  const line = (r.stdout || '').trim().split('\n').at(-1) || '';
  let out;
  try { out = JSON.parse(line); } catch { throw new Error(`${flag} gave no answer: ${r.stderr || r.error}`); }
  if (!out.ok) throw new Error(`${flag}: ${out.error}`);
  return out;
}

function entryFile(claim, check) {
  const mex = {
    id: entryId(claim.id), kind: 'fact', scope: [claim.file],
    source: { type: 'docs', ref: claim.file }, evidence: 'docs', one_line: claim.one_line,
    checks: [check], status: 'active', created: '2026-11-14',
  };
  return `---\nmex: ${JSON.stringify(mex)}\n---\n${claim.one_line}\n`;
}

export function runBench({ subject, corpusDir, binary, work, cli = join(root, 'dist', 'cli.js') }) {
  const corpus = loadCorpus(corpusDir);
  mkdirSync(work, { recursive: true });
  const checkout = join(work, 'subject');
  const home = join(work, 'home');
  if (!existsSync(checkout)) git(subject, 'worktree', 'add', '--detach', checkout, corpus.checkpoints[0].sha);
  else git(checkout, 'checkout', '-f', '--detach', corpus.checkpoints[0].sha);
  // Every run starts from nothing: no MEX home and no entries from an earlier
  // run. Both folders hold only MEX's own files.
  rmSync(home, { recursive: true, force: true });
  rmSync(join(checkout, '.mex'), { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
  const env = { ...process.env, MEX_HOME: home, MEX_TELEMETRY: '0', MEX_HOOK_BINARY: binary };
  const mexCli = (...args) => execFileSync(process.execPath, [cli, ...args], { cwd: checkout, env, encoding: 'utf8', maxBuffer: 64 << 20 });
  mexCli('index', '--json');
  const recordDirectory = join(home, '.mex');
  const mirrors = readdirSync(join(recordDirectory, 'hook-checkouts'));
  const registered = mirrors.map(f => JSON.parse(readFileSync(join(recordDirectory, 'hook-checkouts', f), 'utf8')));
  const reg = registered.find(r => resolve(r.root).toLowerCase() === resolve(checkout).toLowerCase()) ?? registered[0];
  const base = { checkout: reg.root, project_id: reg.project_id, mex_home: home, record_directory: recordDirectory };

  // Seed at C0: each claim's check, recorded by the evaluator on today's code.
  const learned = join(checkout, '.mex', 'learned');
  mkdirSync(learned, { recursive: true });
  const past = new Date(Date.now() - 10_000);
  for (const claim of corpus.claims) {
    const { check } = hook(binary, '--check-run', { action: 'record', ...base, kind: claim.check.kind, role: claim.check.role, target: claim.check.target }, env);
    const path = join(learned, `${entryId(claim.id)}.md`);
    writeFileSync(path, entryFile(claim, check));
    utimesSync(path, past, past);
  }

  const ids = corpus.claims.map(c => entryId(c.id));
  const byEntry = new Map(corpus.claims.map(c => [entryId(c.id), c]));
  const observed = [];
  for (const cp of corpus.checkpoints) {
    git(checkout, 'checkout', '-f', '--detach', cp.sha);
    mexCli('index', '--json');
    const t0 = performance.now();
    const evaluated = hook(binary, '--check-run', { action: 'evaluate', ...base, store: true, team_only: false }, env);
    const checksMs = Math.round(performance.now() - t0);
    const verdicts = new Map((evaluated.results ?? []).map(r => [r.entry_id, r]));
    const probe = hook(binary, '--delivery-probe', { ...base, entries: ids }, env);
    const results = probe.results.map(p => {
      const claim = byEntry.get(p.id);
      const v = verdicts.get(p.id);
      const verdict = v?.verdict ?? 'unknown';
      const inputsChanged = verdict === 'changed' || (v?.checks ?? []).some(c => (c.files_changed ?? []).length > 0);
      const delivered = p.form === 'full' || p.form === 'pointer';
      return {
        claim: claim.id, verdict, inputs_changed: inputsChanged, delivery: p.form,
        rank: delivered ? 1 : null, contains_original_claim: delivered && (p.text ?? '').includes(claim.one_line),
      };
    });
    observed.push({ id: cp.id, sha: cp.sha, checks_ms: checksMs, results });
  }
  const candidate = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  return {
    corpus,
    observed: {
      schema_version: 1, format: 'knowledge-0.9-facts', candidate_commit: candidate,
      dataset_sha256: corpus.manifest.dataset_sha256, seeded_claims: corpus.claims.map(c => c.id), checkpoints: observed,
    },
    expected: { commit: candidate, corpusSha256: corpus.manifest.dataset_sha256 },
  };
}

if (process.argv[1]?.endsWith('run.mjs')) {
  const arg = name => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
  const subject = arg('--subject'), corpusDir = arg('--corpus');
  if (!subject || !corpusDir) { console.error('usage: run.mjs --subject <clone> --corpus <dir> [--binary <mex-hook>] [--work <dir>] [--out <file>]'); process.exit(2); }
  const binary = resolve(arg('--binary') ?? join(root, 'native', 'bin', process.platform === 'win32' ? 'mex-hook.exe' : 'mex-hook'));
  const work = resolve(arg('--work') ?? join(root, '.cache', 'knowledge-bench'));
  const { corpus, observed, expected } = runBench({ subject: resolve(subject), corpusDir: resolve(corpusDir), binary, work });
  if (arg('--out')) writeFileSync(arg('--out'), JSON.stringify(observed, null, 1) + '\n');
  const score = gradeKnowledge(corpus, observed, expected);
  const rows = Object.entries(score.checkpoints).map(([id, s]) => ({ id, ...s.counts, staleServed: s.rates.staleServed, freshRetention: s.rates.freshRetention }));
  console.log(JSON.stringify({ pass: score.pass, failed: score.checks.failed, policyViolations: score.policyViolations, c0Ready: score.c0Ready, all: score.all, timings: score.timings }, null, 1));
  console.table(rows);
  process.exitCode = score.pass ? 0 : 1;
}
