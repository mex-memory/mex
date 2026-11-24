import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { priceSession } from '../delivery-replay/cost.mjs';
import { runProcess } from './process.mjs';
import { replayEvents } from './replay-events.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const corpusDir = join(root, 'scripts', 'gates', 'replay-corpus');
export const REPLAY_CORPUS_SHA256 = 'ae7107dd30ace831cce37e66aedc28dce2723ef7b9683797e84738ba3b5f8945';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const maxFileBytes = 8 << 20;
const fail = (condition, message) => { if (!condition) throw new Error(message); };

function components(name) {
  const parts = name.split('/');
  fail(parts.every((part) => /^[\w.-]+$/.test(part) && !part.endsWith('.') && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)),
    'Invalid corpus path');
  return parts;
}

function readCorpusFile(directory, name) {
  let file = directory;
  const parts = components(name);
  for (const [index, part] of parts.entries()) {
    file = join(file, part);
    const info = lstatSync(file);
    fail(index < parts.length - 1 ? info.isDirectory() : info.isFile() && info.size <= maxFileBytes, 'Invalid corpus file');
  }
  return readFileSync(file);
}

export function loadReplayCorpus(directory, { refresh = false, pin = REPLAY_CORPUS_SHA256 } = {}) {
  fail(lstatSync(directory).isDirectory(), 'Invalid corpus directory');
  const raw = readCorpusFile(directory, 'manifest.json');
  fail(refresh || sha256(raw) === pin, 'Manifest digest differs');
  const manifest = JSON.parse(raw);
  fail(manifest.version === 1 && Array.isArray(manifest.sessions) && manifest.sessions.length > 0 && manifest.sessions.length <= 64, 'Invalid replay manifest');
  const files = new Map();
  let bytes = 0;
  const names = new Set();
  for (const [name, hash] of Object.entries(manifest.files)) {
    const key = name.toLowerCase();
    fail(!names.has(key), 'Duplicate corpus path');
    names.add(key);
    const body = readCorpusFile(directory, name);
    bytes += body.length;
    fail(bytes <= (32 << 20), 'Corpus exceeds byte limit');
    const actual = sha256(body);
    fail(refresh || actual === hash, 'Corpus file digest differs');
    if (refresh) manifest.files[name] = actual;
    files.set(name, body);
  }
  const read = (name) => {
    fail(files.has(name), 'File absent from digest list');
    return files.get(name);
  };
  const agents = new Set();
  const logs = new Set();
  const sessions = manifest.sessions.map((session) => {
    const { agent, repo, commit, file, entries, expected } = session;
    fail(['claude-code', 'codex'].includes(agent) && typeof file === 'string' && file.endsWith('.jsonl') && !logs.has(file), 'Invalid session identity');
    agents.add(agent);
    logs.add(file);
    const subject = manifest.subjects.find((item) => item.repo === repo && item.commit === commit);
    fail(subject && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit), 'Unknown subject snapshot');
    const source = Object.entries(subject.files);
    const names = new Set();
    for (const [path, data] of source) {
      fail(!components(path).some((part) => ['.git', '.mex', 'node_modules'].includes(part.toLowerCase()))
        && !names.has(path.toLowerCase()), 'Invalid subject path');
      names.add(path.toLowerCase());
      read(data);
    }
    fail(source.length > 0, 'Empty subject snapshot');
    if (subject.fixture) {
      const snapshot = source.slice().sort().map(([path, data]) => sha256(read(data)) + ' ' + path + '\n').join('');
      fail(sha256(snapshot) === commit, 'Fixture snapshot digest differs');
    }
    const ids = new Set();
    fail(Array.isArray(entries) && entries.length > 0, 'Missing replay entries');
    for (const entry of entries) {
      fail(/^mx_[a-z0-9]+$/.test(entry.id) && !ids.has(entry.id)
        && ['held', 'changed', 'broken'].includes(entry.verdict), 'Invalid replay entry');
      ids.add(entry.id);
      read(entry.file);
      if (entry.verdict !== 'held') {
        fail(Array.isArray(entry.forbidden) && entry.forbidden.length > 0
          && entry.forbidden.every((text) => typeof text === 'string' && text.length > 0
            && read(entry.file).includes(text)), 'Missing stale text to guard');
      }
    }
    fail(refresh || Array.isArray(expected) && expected.length > 0, 'Missing expected replies');
    const records = read(file).toString('utf8').split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line));
    fail(records.length > 0, 'Empty session log');
    return { ...session, source, records };
  });
  fail(agents.size === 2 && sessions.some(({ entries }) => entries.some(({ verdict }) => verdict === 'changed'))
    && sessions.some(({ entries }) => entries.some(({ verdict }) => verdict === 'broken')), 'Missing agent or stale coverage');
  return { manifest, sessions, read };
}

// Receipt IDs are per-run metadata. Keep every other byte of the agent reply.
function canonicalReply(reply) {
  return JSON.parse(JSON.stringify(reply, (_key, value) => typeof value === 'string'
    ? value.replace(/^\[mex [a-f0-9]+\]$/gm, '[mex block]') : value));
}

function guardStale(entries, { replies, receipts, probes }) {
  const emitted = JSON.stringify(replies);
  for (const { id, verdict, forbidden } of entries.filter(({ verdict }) => verdict !== 'held')) {
    fail(forbidden.every((text) => !emitted.includes(JSON.stringify(text).slice(1, -1))), 'Stale or broken entry text was delivered');
    fail(receipts.every((row) => row.entry_id !== id || !['given', 'replaced'].includes(row.action) || row.form === 'pointer'),
      'Stale or broken entry receipt was delivered in full');
    const checked = probes.filter((probe) => probe.id === id);
    fail(checked.length === 1 && checked[0].verdict === verdict, 'Missing stale delivery probe');
    const [{ form, text = '' }] = checked;
    fail((form === 'withheld' && text === '' || form === 'pointer' && text.length > 0) && forbidden.every((claim) => !text.includes(claim)),
      'Stale or broken entry probe would deliver its claim');
  }
}

export function checkReplaySession(session, first, second, { refresh = false } = {}) {
  const checks = [
    ['both runs contain every reply', () => {
      fail(first.replies.length > 0 && first.replies.length === second.replies.length, 'Missing hook replies');
      fail(first.replies.some(({ reply }) => Object.keys(reply).length > 0), 'The hook delivered no evidence');
    }],
    ['no stale or broken delivery', () => {
      guardStale(session.entries, first);
      guardStale(session.entries, second);
    }],
    ['both runs match byte for byte', () => {
      fail(JSON.stringify(first.replies) === JSON.stringify(second.replies), 'Replay output is nondeterministic');
    }],
  ];
  if (!refresh) checks.push(['replies match the reviewed expected set', () => {
    fail(JSON.stringify(first.replies) === JSON.stringify(session.expected), 'Replay differs from expected replies');
  }]);
  checks.push(['usage is priced in four classes', () => priceSession(session.records, session.agent)]);
  return checks.map(([name, check]) => {
    try { check(); return { name }; }
    catch (error) { return { name, failed: error.message }; }
  });
}

export function replayEvidence(checks) {
  if (!checks.length || checks.some(({ failed }) => failed)) return { status: 'fail', reason: 'checks-failed' };
  return { status: 'pass', reason: 'checked', checks: { total: checks.length, failed: 0, skipped: 0 } };
}

function isolatedEnv(directory) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:MEX_|GIT_)/i.test(key)));
  for (const name of ['MEX_HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'HOME', 'USERPROFILE', 'LOCALAPPDATA']) {
    env[name] = join(directory, name);
    mkdirSync(env[name], { recursive: true });
  }
  return { ...env, MEX_OFFLINE: '1', MEX_TELEMETRY: '0', DO_NOT_TRACK: '1',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(directory, 'gitconfig'),
    MEX_DELIVERY_SURFACES: '{"search-span":"on"}' };
}

class ProcessFailure extends Error {
  constructor(step, reason) {
    super(step);
    this.reason = reason;
  }
}

async function run(command, args, options, step) {
  const result = await runProcess(command, args, options);
  if (result.reason || result.code !== 0) throw new ProcessFailure(step, result.reason ?? 'checks-failed');
  return result.stdout;
}

function writeData(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
}

async function runSession(corpus, session, directory, binary, cli) {
  const env = { ...isolatedEnv(directory), MEX_HOOK_BINARY: binary };
  const cwd = join(directory, 'repo');
  const log = join(directory, 'session.jsonl');
  writeData(log, corpus.read(session.file));
  for (const [path, data] of session.source) writeData(join(cwd, path), corpus.read(data));
  const options = { cwd, env, timeoutMs: 30_000 };
  await run('git', ['init', '-q', '--template='], options, 'Initialize subject');
  await run('git', ['-c', 'core.autocrlf=false', 'add', '--', ...session.source.map(([path]) => path)], options, 'Stage subject');
  const index = JSON.parse(await run(process.execPath, [cli, 'index', '--json', '--workers', '1'], options, 'Build subject index'));
  fail(index.indexed > 0, 'Empty subject index');
  const home = join(env.MEX_HOME, '.mex');
  const launcher = join(home, 'bin', 'launcher.json');
  // The replay uses the real hook shim. Keep its asynchronous jobs offline too.
  if (existsSync(launcher)) unlinkSync(launcher);
  const mirrors = join(home, 'hook-checkouts');
  const names = readdirSync(mirrors);
  fail(names.length === 1, 'Expected one checkout mirror');
  const checkout = JSON.parse(readFileSync(join(mirrors, names[0]), 'utf8'));
  const request = { checkout: checkout.root, project_id: checkout.project_id, mex_home: home, record_directory: home };
  for (const { id, file } of session.entries) writeData(join(cwd, '.mex', 'learned', id + '.md'), corpus.read(file));
  const evaluation = JSON.parse(await run(binary, ['--check-run'], { ...options, input: JSON.stringify({
    action: 'evaluate', ...request, store: true,
  }) }, 'Evaluate subject entries'));
  fail(evaluation.ok && evaluation.stored, 'Entry verdicts were not stored');
  const verdicts = new Map(evaluation.items?.map(({ id, verdict }) => [id, verdict]));
  for (const { id, verdict } of session.entries) {
    fail(verdicts.get(id) === verdict, id + ': expected ' + verdict + ' verdict, got ' + verdicts.get(id));
  }
  const staleIds = session.entries.filter(({ verdict }) => verdict !== 'held').map(({ id }) => id);
  const probes = JSON.parse(await run(binary, ['--delivery-probe'], { ...options, input: JSON.stringify({
    ...request, entries: staleIds,
  }) }, 'Probe stale entry delivery'));
  fail(probes.ok && probes.results.length === staleIds.length, 'Missing stale delivery probes');

  const replies = [];
  const events = replayEvents(session.records, { ...session, log, checkout: checkout.root, session: 'saved-session' });
  fail(events.length <= 512, 'Too many replay events');
  for (const { event, input } of events) {
    const reply = JSON.parse(await run(binary, [session.agent, event], { ...options, input: JSON.stringify(input), timeoutMs: 10_000 }, 'Replay ' + event));
    fail(reply && typeof reply === 'object' && !Array.isArray(reply), 'Invalid hook reply');
    replies.push({ event, reply: canonicalReply(reply) });
  }
  const db = new DatabaseSync(join(home, 'hooks.db'), { readOnly: true });
  try {
    const receipts = db.prepare('SELECT entry_id, form, action FROM deliveries').all();
    return { replies, receipts, probes: probes.results };
  } finally { db.close(); }
}

// Remove only owned files. Directory symlinks and junctions are never walked.
function removeWork(path) {
  if (!lstatSync(path).isDirectory()) { unlinkSync(path); return; }
  for (const name of readdirSync(path)) removeWork(join(path, name));
  rmdirSync(path);
}

async function inspectReplay({ root: candidate, directory = corpusDir, refresh = false }) {
  const corpus = loadReplayCorpus(directory, { refresh });
  const cli = join(candidate, 'dist', 'cli.js');
  if (!existsSync(cli)) throw new ProcessFailure('Built MEX CLI is missing', 'tool-unavailable');
  const work = mkdtempSync(join(tmpdir(), 'mex-replay-'));
  try {
    const binary = join(work, process.platform === 'win32' ? 'hook.exe' : 'hook');
    const goEnv = { ...process.env, CGO_ENABLED: '0', GOFLAGS: '', GOPROXY: 'off', GOSUMDB: 'off', GOTOOLCHAIN: 'local' };
    const [GOCACHE, GOMODCACHE] = (await run('go', ['env', 'GOCACHE', 'GOMODCACHE'],
      { env: goEnv, timeoutMs: 10_000 }, 'Read Go cache locations')).trim().split(/\r?\n/);
    const env = { ...isolatedEnv(join(work, 'build')), CGO_ENABLED: '0', GOFLAGS: '', GOPROXY: 'off', GOSUMDB: 'off',
      GOTOOLCHAIN: 'local', GOCACHE, GOMODCACHE };
    await run('go', ['build', '-buildvcs=false', '-trimpath', '-p', '2', '-o', binary, './cmd/mex-hook'],
      { cwd: join(candidate, 'native'), env, timeoutMs: 180_000 }, 'Build the hook');
    const checks = [];
    for (const [index, session] of corpus.sessions.entries()) {
      const first = await runSession(corpus, session, join(work, index + '-a'), binary, cli);
      const second = await runSession(corpus, session, join(work, index + '-b'), binary, cli);
      for (const check of checkReplaySession(session, first, second, { refresh })) checks.push({ ...check, name: session.file + ': ' + check.name });
      if (refresh) corpus.manifest.sessions[index].expected = first.replies;
    }
    return { checks, manifest: corpus.manifest };
  } finally { removeWork(work); }
}

export async function replayGate({ root: candidate, directory = join(candidate, 'scripts', 'gates', 'replay-corpus'), diagnose = () => {} }) {
  try {
    const { checks } = await inspectReplay({ root: candidate, directory });
    for (const { name, failed } of checks) if (failed) diagnose(name + ': ' + failed);
    return replayEvidence(checks);
  } catch (error) {
    diagnose(error.message);
    const reason = error instanceof ProcessFailure ? error.reason : 'checks-failed';
    return { status: reason === 'tool-unavailable' ? 'unavailable' : 'fail', reason };
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length === 4 && process.argv[2] === '--refresh-expected') {
    try {
      const { checks, manifest } = await inspectReplay({ root, refresh: true });
      for (const { name, failed } of checks) if (failed) console.error(name + ': ' + failed);
      fail(checks.every(({ failed }) => !failed), 'Expected replies were not written');
      writeFileSync(resolve(process.argv[3]), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
      console.log('Wrote candidate replay manifest for review.');
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  } else if (process.argv.length === 2) {
    const evidence = await replayGate({ root, diagnose: console.error });
    process.stdout.write(JSON.stringify(evidence) + '\n');
    if (evidence.status !== 'pass') process.exitCode = 1;
  } else {
    console.error('Usage: node scripts/gates/replay.mjs [--refresh-expected <new-manifest>]');
    process.exitCode = 1;
  }
}
