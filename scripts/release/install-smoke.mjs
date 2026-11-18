import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { run } from './commands.mjs';

// Exercise the installed CLI in isolated profiles. Presence-only agent stubs
// make install discover both integrations without launching an agent session.
export async function installUninstallSmoke({ cli, project, work, env }) {
  const base = join(realpathSync(work), 'install-restoration');
  const bin = join(base, 'agent-bin');
  mkdirSync(bin, { recursive: true });
  for (const agent of ['claude', 'codex']) {
    const path = join(bin, agent + (process.platform === 'win32' ? '.cmd' : ''));
    writeFileSync(path, process.platform === 'win32' ? '@exit /b 0\r\n' : '#!/bin/sh\nexit 0\n');
    chmodSync(path, 0o700);
  }
  const snapshot = path => existsSync(path) ? { bytes: readFileSync(path), mode: lstatSync(path).mode & 0o777 } : null;
  let checks = 0;
  for (const populated of [false, true]) {
    // MEX_HOME stands in for the user's home: MEX keeps its files in <home>/.mex.
    const user = join(base, populated ? 'existing' : 'empty');
    const home = join(user, '.mex'), claude = join(user, '.claude', 'settings.json'), codex = join(user, '.codex', 'hooks.json');
    const native = join(home, 'bin', process.platform === 'win32' ? 'mex-hook.exe' : 'mex-hook');
    const launcher = join(home, 'bin', 'launcher.json'), fallback = join(home, 'bin', 'mex-hook.cjs');
    const paths = [claude, codex, native, launcher, fallback];
    if (populated) {
      const originals = [Buffer.from('\uFEFF{\r\n  "env": {"RESTORE": "keep"}, "hooks": {}\r\n}'),
        Buffer.from('{ "hooks": {}, "description": "keep" }   \n'), Buffer.from('previous runtime\n'),
        Buffer.from('{ "version": 1, "node": "previous", "entry": "previous.js" }\r\n'), Buffer.from('// previous fallback\r\n')];
      paths.forEach((path, index) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, originals[index]); chmodSync(path, 0o640); });
    }
    const before = paths.map(snapshot);
    const childEnv = { ...env, HOME: user, USERPROFILE: user, MEX_HOME: user, CLAUDE_CONFIG_DIR: dirname(claude), CODEX_HOME: dirname(codex), MEX_INSTALL_AUTO: '0',
      PATH: bin + delimiter + (env.PATH || env.Path || ''), MEX_BACKGROUND: '1', MEX_TELEMETRY: '0', DO_NOT_TRACK: '1' };
    // Windows keys are case-insensitive: a second `Path` would shadow the stubs.
    if (childEnv.Path !== undefined) delete childEnv.Path;
    const invoke = async (...args) => JSON.parse(await run(process.execPath, [cli, ...args, '--json'], { cwd: project, env: childEnv }));
    const preview = await invoke('install', '--dry-run');
    assert.deepEqual([...preview.agents].sort(), ['claude-code', 'codex']);
    assert.deepEqual(paths.map(snapshot), before, 'install preview changed a reviewed file');
    assert.equal(existsSync(join(home, 'record.db')), false, 'install preview initialized the record');
    const installed = await invoke('install');
    assert.deepEqual([...installed.agents].sort(), ['claude-code', 'codex']);
    assert.deepEqual(installed.changes.map(change => resolve(change.path)).sort(), [...paths].sort(), 'unexpected or missing installed file');
    const handler = JSON.parse(readFileSync(claude, 'utf8')).hooks.SessionStart[0].hooks[0];
    assert.equal(handler.command, native, 'installed hooks did not select the packaged native runner');
    const once = paths.map(snapshot);
    assert.deepEqual((await invoke('install')).changes, [], 'repeated install rewrote files');
    assert.deepEqual(paths.map(snapshot), once);
    const removed = await invoke('uninstall');
    assert.deepEqual(removed.conflicts, []);
    assert.deepEqual(paths.map(snapshot), before, 'uninstall failed to restore exact bytes, modes or absence');
    assert.equal(existsSync(join(home, 'record.db')), true, 'default uninstall removed retained user data');
    assert.deepEqual((await invoke('uninstall')).conflicts, [], 'repeated uninstall failed');
    checks += 12;
  }
  return checks;
}
