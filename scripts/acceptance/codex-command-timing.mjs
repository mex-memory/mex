/** Free Windows acceptance measurement. Never launches a model or edits user settings. */
import { buildSync } from 'esbuild';
import crossSpawn from 'cross-spawn';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

export function statistics(values) {
  if (!values.length || values.some(value => !Number.isFinite(value) || value < 0)) throw new Error('Invalid timing samples.');
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return { samples: sorted.length, p50_ms: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
    p95_ms: sorted[Math.ceil(sorted.length * 0.95) - 1], max_ms: sorted.at(-1) };
}

function execute(command, args, options = {}) {
  const result = crossSpawn.sync(command, args, { encoding: 'utf8', timeout: 15_000, windowsHide: true, ...options });
  if (result.error || result.status !== 0) throw new Error(`Acceptance command failed: ${basename(command)}; raw output is not retained.`);
  return result.stdout;
}

export async function main(args = process.argv.slice(2)) {
  if (process.platform !== 'win32') throw new Error('Measure on Windows; no Windows result is inferred from another platform.');
  const [outputArg, shellArg] = args;
  if (args.length !== 2 || !outputArg || !shellArg) throw new Error('Usage: node codex-command-timing.mjs <fresh-output-directory> <PowerShell-executable>');
  const root = resolve(import.meta.dirname, '../..'), output = resolve(outputArg), shell = resolve(shellArg);
  if (existsSync(output)) throw new Error('Use a fresh output directory; evidence is never overwritten.');
  if (!existsSync(shell) || !/^(powershell|pwsh)\.exe$/i.test(basename(shell))) throw new Error('Select an existing PowerShell executable.');
  const revision = execute('git', ['rev-parse', 'HEAD'], { cwd: root }).trim();
  const implementationRevision = process.env.MEX_ACCEPTANCE_BASE || revision;
  if (!/^[a-f0-9]{40}$/.test(implementationRevision)) throw new Error('Invalid implementation revision.');
  execute('git', ['diff', '--quiet', implementationRevision, revision, '--', 'native', 'src/install/settings.ts', 'src/record'], { cwd: root });
  const versions = { node: process.version, go: execute('go', ['version']).trim(), codex: execute('codex', ['--version']).trim() };
  mkdirSync(output, { recursive: true });
  const workspace = join(output, 'workspace'), mexBase = join(output, 'user-data'), home = join(mexBase, '.mex');
  mkdirSync(workspace); mkdirSync(home, { recursive: true });
  execute('git', ['init', '-q', workspace], { cwd: root });
  const binary = join(output, 'mex-hook.exe');
  execute('go', ['build', '-o', binary, './cmd/mex-hook'], { cwd: join(root, 'native'), timeout: 180_000 });
  // Load the real settings writer and record registration without exporting a
  // new product API or importing credentials from the engineer's user directory.
  const source = join(output, 'fixture-entry.mjs'), moduleFile = join(output, 'fixture.mjs');
  writeFileSync(join(output, 'package.json'), JSON.stringify({ type: 'module', version: JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version }));
  writeFileSync(source, `export {installSettings} from ${JSON.stringify(join(root, 'src/install/settings.ts'))};\nexport {openRecord,projectIdentity} from ${JSON.stringify(join(root, 'src/record/index.ts'))};\n`);
  buildSync({ entryPoints: [source], outfile: moduleFile, bundle: true, packages: 'external', platform: 'node', format: 'esm', target: 'node22', logLevel: 'silent' });
  const { installSettings, openRecord, projectIdentity } = await import(pathToFileURL(moduleFile).href);
  const writer = openRecord({ home, projectPath: workspace });
  try { writer.register(projectIdentity(workspace)); } finally { writer.close(); }
  const settings = JSON.parse(installSettings(null, 'codex', { path: binary, args: [] }, 'win32').toString());
  writeFileSync(join(output, 'generated-settings.json'), JSON.stringify(settings, null, 2) + '\n');
  const env = { ...process.env, MEX_HOME: mexBase, MEX_BACKGROUND: '0', MEX_OFF: '0', MEX_TELEMETRY: '0' };
  delete env.OSS61_MANIFEST;
  const raw = [], summary = {}, samples = 200, warmups = 5;
  for (const event of ['SessionStart', 'UserPromptSubmit']) {
    const command = settings.hooks[event][0].hooks[0].commandWindows;
    const payload = JSON.stringify({ session_id: 'codex-command-timing', cwd: workspace, source: 'startup', prompt: 'Synthetic timing prompt' });
    for (const boundary of ['native', 'configured_shell_command']) {
      const executable = boundary === 'native' ? binary : shell;
      const argv = boundary === 'native' ? ['codex', event] : ['-NoProfile', '-NonInteractive', '-Command', command];
      const values = [];
      for (let index = 0; index < samples + warmups; index++) {
        const started = performance.now();
        const stdout = execute(executable, argv, { cwd: workspace, env, input: payload });
        const ms = performance.now() - started;
        const reply = JSON.parse(stdout.replace(/^\uFEFF/, ''));
        if (!reply || Array.isArray(reply) || typeof reply !== 'object' || Object.keys(reply).length) throw new Error('Expected an inert registered-fixture hook reply.');
        if (index >= warmups) { values.push(ms); raw.push({ event, boundary, sample: index - warmups, ms }); }
      }
      summary[`${event}/${boundary}`] = statistics(values);
    }
  }
  const report = { revision, implementationRevision, platform: process.platform, architecture: process.arch,
    os: execute('cmd.exe', ['/d', '/c', 'ver']).trim(), shell, shellVersion: execute(shell, ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()']).trim(), versions,
    native_sha256: createHash('sha256').update(readFileSync(binary)).digest('hex'), telemetry: 'off', samples, warmups,
    measurement: 'Fresh process per sample. Configured command includes PowerShell startup and hook execution; excludes Codex dispatch and generation.',
    environment: process.env.GITHUB_ACTIONS === 'true' ? 'GitHub-hosted Windows runner' : 'operator Windows machine', modelCalls: 0, summary, raw };
  const reportPath = join(output, 'timing.json');
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ report: reportPath, summary, modelCalls: 0 }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
