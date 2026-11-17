#!/usr/bin/env node
// The delivery demo, through the real hook binary and Claude Code's own
// payloads, in a throwaway repo and MEX home:
//   node scripts/delivery-demo.mjs [--binary <mex-hook>]
// Read a file that has a pitfall, run a command that has a recipe, fail a
// command that has a recorded fix: three deliveries. Then the same three
// again: nothing, because each went out once this epoch.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = name => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
let binary = arg('--binary');
const work = mkdtempSync(join(tmpdir(), 'mex-delivery-demo-'));
if (!binary) {
  binary = join(work, process.platform === 'win32' ? 'mex-hook.exe' : 'mex-hook');
  execFileSync('go', ['build', '-o', binary, './cmd/mex-hook'], { cwd: join(root, 'native'), stdio: 'inherit', env: { ...process.env, CGO_ENABLED: '0' } });
}
const repo = join(work, 'repo');
const home = join(work, 'home');
const write = (rel, text) => { const p = join(repo, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text); return p; };
write('package.json', JSON.stringify({ name: 'demo', scripts: { 'test:unit': 'node --test' } }, null, 2) + '\n');
const pool = write('src/db/pool.ts', 'export const pool = createPool()\n');
execFileSync('git', ['init', '-q'], { cwd: repo });
mkdirSync(home, { recursive: true });
const env = { ...process.env, MEX_HOME: home, MEX_TELEMETRY: '0' };
execFileSync(process.execPath, [join(root, 'dist', 'cli.js'), 'index', '--json'], { cwd: repo, env, stdio: 'ignore' });

const recordDirectory = join(home, '.mex');
const mirror = JSON.parse(readFileSync(join(recordDirectory, 'hook-checkouts', readdirSync(join(recordDirectory, 'hook-checkouts'))[0]), 'utf8'));
const record = target => {
  const r = spawnSync(binary, ['--check-run'], { input: JSON.stringify({ action: 'record', checkout: mirror.root, project_id: mirror.project_id, mex_home: home, record_directory: recordDirectory, ...target }), encoding: 'utf8', env: { ...env, MEX_BACKGROUND: '1' } });
  const out = JSON.parse(r.stdout.trim().split('\n').at(-1));
  if (!out.ok) throw new Error(out.error);
  return out.check;
};
const entry = (id, mex, text) => {
  const p = write(`.mex/learned/${id}.md`, `---\nmex: ${JSON.stringify({ id, scope: ['**'], source: { type: 'docs', ref: 'CONTRIBUTING.md' }, evidence: 'docs', checks: [], status: 'active', created: '2026-11-14', ...mex })}\n---\n${text}\n`);
  const past = new Date(Date.now() - 10_000);
  utimesSync(p, past, past);
};
entry('mx_demopool', { kind: 'pitfall', scope: ['src/db/**'], one_line: 'The database pool is shared by every request; never close it in a handler.' },
  'The database pool is shared by every request, so closing it in a handler breaks the next request.');
entry('mx_demotest', { kind: 'recipe', one_line: 'Unit tests: `npm run test:unit`; they need TZ=UTC.', checks: [record({ kind: 'command', role: 'complete', target: { run: 'npm run test:unit', file: 'package.json', pointer: '/scripts/test:unit' } })] },
  'Run the unit tests with `npm run test:unit`. Date tests assume TZ=UTC.');
entry('mx_demofix1', { kind: 'hint', one_line: 'ECONNREFUSED on 5432 means the test database is down: run `docker compose up -d db`.', when: [{ type: 'anti', match: 'literal', pattern: 'connect ECONNREFUSED 127.0.0.1:5432' }] },
  'The integration tests need Postgres on 5432; start it with `docker compose up -d db`.');

const call = (event, body) => {
  const r = spawnSync(binary, ['claude-code', event], { input: JSON.stringify({ session_id: 'demo', cwd: repo, hook_event_name: event, ...body }), encoding: 'utf8', env });
  const out = r.stdout.trim();
  try { return JSON.parse(out)?.hookSpecificOutput?.additionalContext ?? ''; } catch { return out; }
};
const steps = [
  ['read src/db/pool.ts', 'PostToolBatch', { tool_calls: [{ tool_name: 'Read', tool_input: { file_path: pool }, tool_use_id: '1', tool_response: '1\texport const pool = createPool()\n' }] }],
  ['npm run test:unit', 'PostToolBatch', { tool_calls: [{ tool_name: 'Bash', tool_input: { command: 'npm run test:unit' }, tool_use_id: '2', tool_response: 'ok 1 - dates' }] }],
  ['a failing integration test', 'PostToolUseFailure', { tool_name: 'Bash', tool_input: { command: 'npm run test:int' }, error: 'Exit code 1\nError: connect ECONNREFUSED 127.0.0.1:5432' }],
];
call('SessionStart', { source: 'startup' });
let delivered = 0;
for (const round of ['first time', 'again']) {
  console.log(`\n== ${round}`);
  for (const [label, event, body] of steps) {
    const context = call(event, body);
    if (context) delivered++;
    console.log(`-- ${label}: ${context ? '\n' + context : '(nothing)'}`);
  }
}
console.log(`\n${delivered} deliveries (expected 3). Work folder: ${work}`);
process.exitCode = delivered === 3 ? 0 : 1;
