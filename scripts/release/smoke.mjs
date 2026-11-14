import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { createRequire } from 'node:module';
import { verifyBundle } from './bundle.mjs';
import { localRegistry } from './registry.mjs';
import { npm, run, npmEnvironment } from './commands.mjs';
import { TARGETS } from './plan.mjs';
import { resolveHookRunner } from '../../src/hooks/shim/binary.ts';

export async function smokeBundle(directory, plan) {
  await verifyBundle(directory, plan);
  const work = mkdtempSync(join(tmpdir(), 'mex-release-smoke-')), project = join(work, 'project');
  mkdirSync(project); writeFileSync(join(project, 'package.json'), '{"private":true}\n');
  const env = { ...npmEnvironment(), MEX_HOME: join(work, 'home'), MEX_TELEMETRY: '0', MEX_BACKGROUND: '1', NODE_PATH: '' };
  const registry = await localRegistry(directory, plan);
  try {
    await npm(['install', `mex-agent@${plan.version}`, '--omit=dev', '--prefer-offline', '--no-audit', '--no-fund', '--registry', registry.origin], { cwd: project, env });
    const installed = join(project, 'node_modules/mex-agent/package.json');
    const require = createRequire(installed), host = `${process.platform}-${process.arch}`;
    if (!TARGETS.includes(host)) throw new Error('Unsupported smoke host');
    const selected = [];
    for (const target of TARGETS) {
      let path;
      try { path = require.resolve(`mex-agent-hook-${target}/package.json`); } catch (error) { if (error.code === 'MODULE_NOT_FOUND') continue; throw error; }
      const rel = relative(realpathSync(project), realpathSync(path));
      if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Resolved package outside clean consumer');
      if (JSON.parse(readFileSync(path)).version !== plan.version) throw new Error('Installed platform version mismatch');
      selected.push(target);
    }
    if (selected.length !== 1 || selected[0] !== host) throw new Error(`npm selected wrong platforms: ${selected}`);
    const runner = resolveHookRunner({ resolve: require.resolve });
    if (runner.kind !== 'native' || runner.version !== plan.version) throw new Error('Installed resolver selected the Node fallback');
    const self = JSON.parse(await run(runner.path, ['--self-test'], { env }));
    if (!self.ok || self.version !== plan.version || self.os !== (process.platform === 'win32' ? 'windows' : process.platform) || self.arch !== (process.arch === 'x64' ? 'amd64' : process.arch)) throw new Error('Native self-test failed');
    const cliVersion = (process.platform === 'win32'
      ? await run('cmd.exe', ['/d', '/c', 'node_modules\\.bin\\mex.cmd', '--version'], { cwd: project, env })
      : await run(join(project, 'node_modules/.bin/mex'), ['--version'], { cwd: project, env })).trim();
    if (cliVersion !== plan.version) throw new Error(`CLI version mismatch: ${cliVersion}`);
    console.log(`Registry install selected only mex-agent-hook-${host}; native resolver, self-test and mex --version ${plan.version} passed.`);
    console.log(`Retained isolated consumer: ${work}`);
  } finally { await registry.close(); }
}
