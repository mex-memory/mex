import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { createRequire } from 'node:module';
import { verifyBundle } from './bundle.mjs';
import { localRegistry } from './registry.mjs';
import { npm, run, npmEnvironment } from './commands.mjs';
import { TARGETS } from './plan.mjs';
import { resolveHookRunner } from '../../src/hooks/shim/binary.ts';
import { installUninstallSmoke } from './install-smoke.mjs';

export async function smokeBundle(directory, plan) {
  await verifyBundle(directory, plan);
  const work = mkdtempSync(join(tmpdir(), 'mex-release-smoke-')), project = join(work, 'project');
  mkdirSync(project); writeFileSync(join(project, 'package.json'), '{"private":true}\n');
  const env = { ...npmEnvironment(), MEX_HOME: join(work, 'home'), MEX_TELEMETRY: '0', MEX_BACKGROUND: '1', NODE_PATH: '' };
  const registry = await localRegistry(directory, plan);
  try {
    await npm(['install', 'mex-agent@next', '--omit=dev', '--prefer-offline', '--no-audit', '--no-fund', '--registry', registry.origin, '--replace-registry-host=never'], { cwd: project, env });
    const installed = join(project, 'node_modules/mex-agent/package.json');
    const require = createRequire(installed), host = `${process.platform}-${process.arch}`;
    if (!TARGETS.includes(host)) throw new Error('Unsupported smoke host');
    const selected = [];
    const optional = plan.packages.filter((entry) => entry.target);
    for (const entry of optional) {
      let path;
      try { path = require.resolve(`${entry.name}/package.json`); } catch (error) { if (error.code === 'MODULE_NOT_FOUND') continue; throw error; }
      const rel = relative(realpathSync(project), realpathSync(path));
      if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Resolved package outside clean consumer');
      if (JSON.parse(readFileSync(path)).version !== plan.version) throw new Error('Installed platform version mismatch');
      selected.push(entry.name);
    }
    const expected = optional.filter((entry) => entry.target === host).map((entry) => entry.name);
    if (selected.join() !== expected.join()) throw new Error(`npm selected wrong platforms: ${selected}`);
    const runner = resolveHookRunner({ resolve: require.resolve });
    if (runner.kind !== 'native' || runner.version !== plan.version) throw new Error('Installed resolver selected the Node fallback');
    const self = JSON.parse(await run(runner.path, ['--self-test'], { env }));
    if (!self.ok || self.version !== plan.version || self.os !== (process.platform === 'win32' ? 'windows' : process.platform) || self.arch !== (process.arch === 'x64' ? 'amd64' : process.arch)) throw new Error('Native self-test failed');
    const cliVersion = (process.platform === 'win32'
      ? await run('cmd.exe', ['/d', '/c', 'node_modules\\.bin\\mex.cmd', '--version'], { cwd: project, env })
      : await run(join(project, 'node_modules/.bin/mex'), ['--version'], { cwd: project, env })).trim();
    if (cliVersion !== plan.version) throw new Error(`CLI version mismatch: ${cliVersion}`);
    const cli = join(project, 'node_modules/mex-agent/dist/cli.js');
    const source = join(work, 'graph-project');
    mkdirSync(source);
    writeFileSync(join(source, 'app.py'), 'def helper():\n    return 42\n\ndef caller():\n    return helper()\n');
    const engines = optional.some((entry) => entry.target === host && entry.executable === 'mex-graph') ? ['native', 'wasi'] : ['wasi'];
    for (const runtime of engines) {
      const graphEnv = { ...env, MEX_HOME: join(work, `home-${runtime}`) };
      delete graphEnv.MEX_GRAPH_ENGINE_LANGUAGES;
      delete graphEnv.MEX_GRAPH_STORAGE;
      delete graphEnv.MEX_GRAPH_ENGINE;
      if (runtime === 'wasi') graphEnv.MEX_GRAPH_ENGINE = join(work, 'missing-mex-graph');
      const graph = async (...args) => JSON.parse(await run(process.execPath, [cli, 'graph', ...args, '--root', source, '--json'], { cwd: project, env: graphEnv }));
      const built = await graph('rebuild');
      const status = await graph('status');
      if (built.engine?.runtime !== runtime || status.engineRuntime !== runtime || status.schemaVersion !== 5
          || built.nodesCreated !== 3 || (runtime === 'wasi' && !status.diagnostics.some((diagnostic) => diagnostic.code === 'GRAPH_ENGINE_WASI'))) {
        throw new Error(`Installed graph did not build and report schema v5 with ${runtime}`);
      }
    }
    const checks = await installUninstallSmoke({ cli, project, work, env });
    console.log(`Registry install selected ${selected.join(', ')}. Graph builds (${engines.join(', ')}), the hook self-test and mex --version ${plan.version} passed.`);
    console.log(`Candidate next-tag install/uninstall: ${checks} restoration checks passed across empty and existing profiles.`);
    console.log(`Retained isolated consumer: ${work}`);
  } finally { await registry.close(); }
}
