// The three-repo upgrade gate's live adapter. It rebuilds real 0.8 projects
// (Hono, novu and MEX itself) at pinned public commits with their preserved
// 0.8 scaffolds, behind local Git origins, and runs the built `mex upgrade`
// through preview, exact apply, recovery and pull-request publication with a
// stand-in `gh`. Corpus files are data: they are hashed, written and read,
// never executed. Only the reduced pass/fail result leaves this module.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CORPUS = join(HERE, 'upgrade-corpus');
// A corpus change is a reviewed code change: update this digest with it.
export const UPGRADE_CORPUS_SHA256 = '7c41fc96088c585fbf864d8b782f04a4f778d5637e54875e77bbfc88ebbe2505';
const unavailable = { status: 'unavailable', reason: 'tool-unavailable' };
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const IDENTITY = ['-c', 'user.name=mex upgrade gate', '-c', 'user.email=gate@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=.git/hooks'];

class Refusal extends Error {}

/** Verifies the pinned manifest and every bundle it names. */
export function loadCorpus(dir = CORPUS, expected = UPGRADE_CORPUS_SHA256) {
  const manifestBytes = readFileSync(join(dir, 'manifest.json'));
  if (sha256(manifestBytes) !== expected) throw new Refusal('corpus manifest digest');
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (manifest.schema_version !== 1 || !Array.isArray(manifest.subjects) || manifest.subjects.length !== 3) throw new Refusal('corpus manifest shape');
  const bundles = {};
  for (const name of Object.keys(manifest.bundles)) {
    const bytes = readFileSync(join(dir, name));
    if (sha256(bytes) !== manifest.bundles[name]) throw new Refusal(`bundle digest ${name}`);
    bundles[name] = JSON.parse(bytes.toString('utf8'));
  }
  for (const subject of manifest.subjects) {
    if (!/^[a-f0-9]{40}$/.test(subject.commit) || !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\.git$/.test(subject.repository)) throw new Refusal('subject pin');
    for (const [path] of Object.entries(subject.bundle ? bundles[subject.bundle].files : {})) {
      if (path.split('/').some((part) => !part || part === '..') || /^[\\/]|:/.test(path)) throw new Refusal('bundle path');
    }
  }
  return { manifest, bundles };
}

function git(cwd, args, options = {}) {
  return execFileSync('git', [...IDENTITY, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 600_000, maxBuffer: 64 << 20, ...options }).trim();
}

/** One shallow fetch of the pinned public commit per cache; later runs reuse it. */
function pristine(cache, subject) {
  const dir = join(cache, `${subject.id}-${subject.commit.slice(0, 12)}.git`);
  if (!existsSync(join(dir, 'HEAD'))) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    git(dir, ['init', '--quiet', '--bare']);
    git(dir, ['fetch', '--quiet', '--depth=1', subject.repository, subject.commit]);
    git(dir, ['update-ref', 'refs/heads/main', subject.commit]);
  }
  if (git(dir, ['rev-parse', 'refs/heads/main^{commit}']) !== subject.commit) throw new Error('pinned commit');
  return dir;
}

function writeFiles(root, files) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

/**
 * A 0.8 user's checkout: a local origin whose main is the pinned commit (plus
 * the scaffold commit when the team committed it), cloned with the requested
 * line-ending setting. Throwaway caches are labelled and never claimed as
 * historical databases.
 */
function project(work, base, subject, bundles, { scaffold, autocrlf, hook }) {
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const origin = join(work, 'origin.git'), checkout = join(work, 'repo');
  cpSync(base, origin, { recursive: true });
  const files = subject.bundle ? bundles[subject.bundle].files : {};
  if (scaffold === 'committed') {
    // The team's commit, built with plumbing so the exact bytes are stored
    // without checking out a large repository twice.
    const env = { ...process.env, GIT_INDEX_FILE: join(work, 'scaffold.index') };
    git(origin, ['read-tree', 'main'], { env });
    for (const [path, text] of Object.entries(files)) {
      const blob = git(origin, ['hash-object', '-w', '--stdin'], { env, input: text, stdio: ['pipe', 'pipe', 'pipe'] });
      git(origin, ['update-index', '--add', '--cacheinfo', `100644,${blob},${path}`], { env });
    }
    const tree = git(origin, ['write-tree'], { env });
    git(origin, ['update-ref', 'refs/heads/main', git(origin, ['commit-tree', tree, '-p', 'main', '-m', '0.8 scaffold (preserved input)'], { env })]);
  }
  git(work, ['-c', `core.autocrlf=${autocrlf}`, 'clone', '--quiet', `file://${origin.replace(/\\/g, '/')}`, checkout]);
  git(checkout, ['config', 'core.autocrlf', String(autocrlf)]);
  if (scaffold === 'uncommitted') writeFiles(checkout, files);
  mkdirSync(join(checkout, '.mex'), { recursive: true });
  writeFileSync(join(checkout, '.mex', 'wiki.db'), 'mex upgrade gate: throwaway stand-in for the 0.8 Wiki index cache\n');
  if (hook) {
    const path = join(checkout, '.git', 'hooks', 'post-commit');
    writeFileSync(path, hook);
    chmodSync(path, 0o755);
  }
  return { origin, checkout };
}

/** Bytes of everything the upgrade must not touch on its own: scaffold, root instructions, Git status and hook. */
function observe(checkout) {
  const files = {};
  const walk = (dir, rel) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { if (!['local', 'learned'].includes(entry.name)) walk(join(dir, entry.name), path); }
      else files[path] = sha256(readFileSync(join(dir, entry.name)));
    }
  };
  walk(join(checkout, '.mex'), '.mex');
  for (const name of ['AGENTS.md', 'CLAUDE.md']) if (existsSync(join(checkout, name))) files[name] = sha256(readFileSync(join(checkout, name)));
  const hook = join(checkout, '.git', 'hooks', 'post-commit');
  return { files, status: git(checkout, ['status', '--porcelain', '--untracked-files=all']), hook: existsSync(hook) ? sha256(readFileSync(hook)) : null,
    branches: git(checkout, ['for-each-ref', '--format=%(refname)', 'refs/heads']) };
}

/**
 * The original (node, fingerprint) pairs of each source document, in either
 * 0.8 spelling (a YAML list or an HTML-comment record, ids quoted or not).
 * Template placeholders such as `function:<tier-1-id>` are not groundings.
 */
export function groundings(files) {
  const byPath = {};
  const unquote = (value) => value.replace(/^(["'])(.*)\1$/, '$2');
  for (const [path, text] of Object.entries(files)) {
    const pairs = [...text.replace(/\r\n/g, '\n').matchAll(/\bnode: (\S+)\n\s+fingerprint: (\S+)/g)]
      .map((m) => [unquote(m[1]), unquote(m[2])]).filter(([node]) => /^[a-z_]+:[0-9a-f]{16,64}$/.test(node)).map(([node, fingerprint]) => `${node} ${fingerprint}`);
    if (pairs.length) byPath[path] = pairs;
  }
  return byPath;
}

function fakeGh(cache) {
  const dir = join(cache, 'fake-gh');
  const binary = join(dir, process.platform === 'win32' ? 'gh.exe' : 'gh');
  if (existsSync(binary)) return dir;
  mkdirSync(dir, { recursive: true });
  // A stand-in for the GitHub CLI: records its arguments and fails or
  // answers as told. It never reaches a network or account.
  writeFileSync(join(dir, 'go.mod'), 'module fakegh\n\ngo 1.21\n');
  writeFileSync(join(dir, 'main.go'), `package main

import (
	"fmt"
	"os"
	"strings"
)

func main() {
	if log := os.Getenv("MEX_GATE_GH_LOG"); log != "" {
		f, err := os.OpenFile(log, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
		if err == nil {
			fmt.Fprintln(f, strings.Join(os.Args[1:], " "))
			f.Close()
		}
	}
	if os.Getenv("MEX_GATE_GH") != "ok" || (len(os.Args) > 2 && os.Args[1] == "pr" && os.Args[2] == "view") {
		os.Exit(1)
	}
	fmt.Println("https://example.invalid/pull/1")
}
`);
  execFileSync('go', ['build', '-trimpath', '-o', binary, '.'], { cwd: dir, stdio: 'ignore', timeout: 300_000, env: { ...process.env, CGO_ENABLED: '0', GOFLAGS: '-mod=mod' } });
  return dir;
}

/** Runs every scenario; returns the number of checks and the failed ones. */
export function runUpgradeScenarios({ root, cache, corpus = loadCorpus(), log = () => {} }) {
  const { manifest, bundles } = corpus;
  const cli = join(root, 'dist', 'cli.js');
  const ghDir = fakeGh(cache);
  let total = 0;
  const failures = [];
  const check = (ok, what) => { total++; if (!ok) { failures.push(what); log(`FAIL ${what}`); } };
  const subjects = Object.fromEntries(manifest.subjects.map((s) => [s.id, { ...s, base: pristine(cache, s) }]));

  for (const scenario of manifest.scenarios) {
    const subject = subjects[scenario.subject], expect = scenario.expect;
    const name = scenario.id, work = join(cache, 'work', name), home = join(work, 'home');
    const hook = scenario.hook ? bundles['watch-hook-0.8.5.json']['post-commit'] : undefined;
    const { origin, checkout } = project(work, subject.base, subject, bundles, { scaffold: scenario.scaffold, autocrlf: scenario.autocrlf, hook });
    const ghLog = join(work, 'gh.log');
    // A person running the upgrade has a Git identity; CI runners don't.
    const env = { ...process.env, MEX_HOME: home, MEX_TELEMETRY: '0', DO_NOT_TRACK: '1', MEX_BACKGROUND: '1', MEX_GATE_GH_LOG: ghLog,
      GIT_AUTHOR_NAME: 'Gate Person', GIT_AUTHOR_EMAIL: 'person@example.invalid', GIT_COMMITTER_NAME: 'Gate Person', GIT_COMMITTER_EMAIL: 'person@example.invalid',
      PATH: ghDir + delimiter + (process.env.PATH ?? process.env.Path ?? ''), NODE_OPTIONS: '--max-old-space-size=4096' };
    delete env.Path;
    const upgrade = (args, extra = {}) => {
      try { return JSON.parse(execFileSync(process.execPath, [cli, 'upgrade', ...args, '--json'], { cwd: checkout, env: { ...env, ...extra }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 900_000, maxBuffer: 256 << 20 })); }
      catch (error) { if (error.stdout) return JSON.parse(error.stdout); throw error; }
    };
    const before = observe(checkout);
    const plan = upgrade([]);
    log(`${name}: ${plan.ok ? `${plan.entries?.length} entries, ${plan.tracked?.length} tracked, ready=${plan.ready}` : plan.error?.code}`);
    check(plan.ok === true && plan.present === true, `${name}: preview reads the 0.8 scaffold`);
    check(JSON.stringify(observe(checkout)) === JSON.stringify(before), `${name}: preview changes nothing`);
    check(!existsSync(home), `${name}: preview creates no machine state`);
    const blocking = (plan.issues ?? []).filter((i) => i.blocking).map((i) => `${i.code} ${i.path}`).sort();
    check(JSON.stringify(blocking) === JSON.stringify(expect.blocking), `${name}: blocking issues ${JSON.stringify(blocking)}`);
    if (!plan.ok) continue;
    if (!expect.ready) {
      check(plan.ready === false, `${name}: refuses to apply`);
      const refused = upgrade(['--apply', '--expect', plan.revision ?? '0']);
      check(refused.ok === false && refused.error?.code === 'STALE_PREVIEW', `${name}: apply refuses`);
      check(JSON.stringify(observe(checkout)) === JSON.stringify(before), `${name}: refusal changes nothing`);
      continue;
    }
    const entries = plan.entries ?? [], review = (plan.issues ?? []).filter((i) => i.code === 'ENTRY_NEEDS_REVIEW');
    const counted = { entries: entries.length, team: entries.filter((e) => e.level === 'team').length, personal: plan.personal.length,
      tracked: plan.tracked.length, local: plan.local.length, review: review.length, caches: plan.assets.caches.length, hook: !!plan.assets.hook };
    check(plan.ready === true, `${name}: preview is ready`);
    log(`${name}: counts ${JSON.stringify(counted)}`);
    check(Object.keys(expect.counts).length === Object.keys(counted).length, `${name}: every count is pinned`);
    for (const [key, value] of Object.entries(expect.counts)) check(counted[key] === value, `${name}: ${key} ${counted[key]} (expected ${value})`);

    // Content: what an agent would receive.
    const texts = [...plan.tracked.filter((c) => /^\.mex\/learned\//.test(c.path) && c.after).map((c) => c.after), ...plan.personal.map((c) => c.after)];
    check(texts.length === entries.length, `${name}: one file per entry`);
    const body = texts.join('\n');
    check(!/Length: 1 sentence maximum|\[Project Name\]|How many patterns to generate|read ROUTER\.md before doing anything else|run GROW/.test(body), `${name}: no 0.8 template or workflow text`);
    check(texts.every((t) => !/^ {2}one_line: "?#/m.test(t)), `${name}: no heading as a one-line summary`);
    check(texts.every((t) => !/^ {4}ref: \.mex\/(?:\.tool-configs\/|patterns\/(?:README|INDEX)\.md)/m.test(t)), `${name}: no entry from a template file`);
    const removed = (body.match(/\[unverified command removed\]/g) ?? []).length;
    check(removed <= expect.removedCommandsMax, `${name}: ${removed} unverified commands removed (at most ${expect.removedCommandsMax})`);
    const reviewed = new Set(review.map((i) => i.path));
    const sources = subject.bundle ? bundles[subject.bundle].files : {};
    let kept = 0, owed = 0;
    for (const [path, pairs] of Object.entries(groundings(sources))) {
      if (reviewed.has(path)) continue;
      for (const pair of pairs) {
        owed++;
        const [node, fingerprint] = pair.split(' ');
        if (texts.some((t) => t.includes(`node: ${node}`) && t.includes(`fingerprint: ${fingerprint}`))) kept++;
      }
    }
    check(kept === owed && owed === expect.groundingsKept, `${name}: ${kept}/${owed} original groundings kept byte-for-byte (expected ${expect.groundingsKept})`);

    // Apply exactly the preview, optionally through a failed and retried PR.
    const pr = scenario.publish === 'pr';
    const applied = upgrade(['--apply', '--expect', plan.revision, ...(pr ? ['--pr'] : [])], { MEX_GATE_GH: 'fail' });
    let result = applied;
    if (pr) {
      check(applied.ok === false && applied.error?.code === 'UPGRADE_PR', `${name}: a failed PR keeps the pushed branch for retry`);
      check(git(origin, ['for-each-ref', '--format=%(refname)', 'refs/heads/mex']).length > 0, `${name}: branch pushed before the PR`);
      result = upgrade(['--finish', '--pr'], { MEX_GATE_GH: 'ok' });
      check(result.ok === true && result.pr === 'https://example.invalid/pull/1', `${name}: --finish --pr opens the PR`);
      const calls = existsSync(ghLog) ? readFileSync(ghLog, 'utf8') : '';
      check(/pr create --base main --head mex\/upgrade-/.test(calls), `${name}: PR targets the default branch`);
    } else {
      check(applied.ok === true && applied.applied === true, `${name}: apply succeeds`);
      check(!existsSync(ghLog), `${name}: no gh without --pr`);
      check(git(origin, ['for-each-ref', '--format=%(refname)', 'refs/heads']) === 'refs/heads/main', `${name}: nothing pushed without --pr`);
    }
    if (!result.ok) continue;
    check(JSON.stringify([...result.files].sort()) === JSON.stringify(plan.tracked.map((c) => c.path).sort()), `${name}: tracked output is exactly the preview`);
    if (result.commit) {
      const changed = git(checkout, ['diff', '--name-only', '--no-renames', plan.base, result.commit]).split('\n').filter(Boolean).sort();
      check(JSON.stringify(changed) === JSON.stringify(plan.tracked.map((c) => c.path).sort()), `${name}: the commit changes only previewed files`);
      const mismatched = plan.tracked.filter((c) => {
        if (c.after === null) return git(checkout, ['ls-tree', '--name-only', result.commit, '--', c.path]) !== '';
        const blob = execFileSync('git', ['cat-file', 'blob', `${result.commit}:${c.path}`], { cwd: checkout });
        return blob.toString('utf8').replace(/\r\n/g, '\n') !== c.after.replace(/\r\n/g, '\n');
      });
      check(mismatched.length === 0, `${name}: committed bytes equal the preview (${mismatched.length} differ)`);
    }
    // The checkout itself: local changes only; human documents retained.
    const after = observe(checkout);
    const local = new Set([...plan.local.map((c) => c.path), ...plan.assets.caches.map((c) => c.path)]);
    const touched = Object.keys({ ...before.files, ...after.files }).filter((p) => before.files[p] !== after.files[p]).sort();
    check(touched.every((p) => local.has(p)), `${name}: only local changes touched the checkout ${JSON.stringify(touched.filter((p) => !local.has(p)))}`);
    check(!existsSync(join(checkout, '.mex', 'wiki.db')), `${name}: the old index cache is deleted`);
    check(scenario.hook ? after.hook === null : true, `${name}: the generated watch hook is removed`);
    for (const path of plan.retained ?? []) check(before.files[path] !== undefined && after.files[path] === before.files[path], `${name}: retained ${path}`);
    const notes = join(home, '.mex', 'projects');
    const personal = existsSync(notes) ? readdirSync(notes).flatMap((p) => existsSync(join(notes, p, 'notes')) ? readdirSync(join(notes, p, 'notes')) : []) : [];
    check(personal.length === plan.personal.length, `${name}: ${personal.length} personal entries stored`);
    const again = upgrade([]);
    check(again.ok === true && again.alreadyUpgraded === true, `${name}: a second run reports the finished upgrade`);
  }
  return { total, failures };
}

export async function upgradeGate({ root, cache = process.env.MEX_GATE_CACHE ? join(process.env.MEX_GATE_CACHE, 'upgrade') : join(tmpdir(), 'mex-upgrade-gate') }) {
  if (!existsSync(join(root, 'dist', 'cli.js'))) return unavailable;
  let corpus;
  try { corpus = loadCorpus(); } catch { return { status: 'fail', reason: 'invalid-evidence' }; }
  mkdirSync(cache, { recursive: true });
  try {
    for (const subject of corpus.manifest.subjects) pristine(cache, subject);
    fakeGh(cache);
  } catch { return unavailable; }
  try {
    const { total, failures } = runUpgradeScenarios({ root, cache, corpus });
    if (failures.length || total === 0) return { status: 'fail', reason: 'checks-failed' };
    return { status: 'pass', reason: 'checked', checks: { total, failed: 0, skipped: 0 } };
  } catch {
    return { status: 'fail', reason: 'checks-failed' };
  }
}

// Local diagnosis: `node scripts/gates/upgrade.mjs` prints each check that fails.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = join(HERE, '..', '..');
  const cache = process.env.MEX_GATE_CACHE ? join(process.env.MEX_GATE_CACHE, 'upgrade') : join(tmpdir(), 'mex-upgrade-gate');
  mkdirSync(cache, { recursive: true });
  const { total, failures } = runUpgradeScenarios({ root, cache, log: (line) => console.error(line) });
  console.log(`${total - failures.length}/${total} upgrade checks passed`);
  process.exitCode = failures.length ? 1 : 0;
}
