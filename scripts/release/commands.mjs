import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';

export const exec = promisify(execFile);
export async function run(file, args, options = {}) {
  const { stdout } = await exec(file, args, { encoding: 'utf8', windowsHide: true, timeout: 300_000, maxBuffer: 16 * 1024 * 1024, ...options });
  return stdout;
}
export function npmCli() {
  const candidates = [process.env.MEX_RELEASE_NPM_CLI, process.env.npm_execpath, process.env.RELEASE_NPM_CLI,
    join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), join(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')];
  const found = candidates.find((path) => path && existsSync(path));
  if (!found) throw new Error('npm CLI not found; install the pinned release CLI');
  return found;
}
export const npm = (args, options) => run(process.execPath, [npmCli(), ...args], options);

// Private npm configuration never reads a developer's credentials. Only the
// protected publishing step supplies NODE_AUTH_TOKEN; OIDC needs no token line.
export function npmEnvironment({ token = false } = {}) {
  const work = mkdtempSync(join(tmpdir(), 'mex-release-npm-'));
  const config = join(work, 'npmrc');
  writeFileSync(config, 'registry=https://registry.npmjs.org/\nupdate-notifier=false\n' + (token && process.env.NODE_AUTH_TOKEN ? '//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}\n' : ''));
  return { ...process.env, npm_config_userconfig: config, npm_config_globalconfig: join(work, 'global-npmrc'),
    ...(token ? {} : { NODE_AUTH_TOKEN: '', NPM_TOKEN: '' }) };
}

export async function installNpm(directory) {
  const integrity = '7iDSHDoup6uMQJ37yWrhfqcbMhF0UEfGRap6Nv+aKQcrIJXlCi2cKbj75WBmiHlcwsQCy/U0zEwDZdAx6H/Vaw==';
  const response = await fetch('https://registry.npmjs.org/npm/-/npm-11.6.1.tgz', { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error('Could not fetch pinned npm');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash('sha512').update(bytes).digest('base64') !== integrity) throw new Error('npm checksum mismatch');
  await mkdir(directory, { recursive: true });
  const archive = join(directory, 'npm.tgz'); await writeFile(archive, bytes);
  await run('tar', ['-xzf', 'npm.tgz'], { cwd: directory });
  return join(directory, 'package', 'bin', 'npm-cli.js');
}
