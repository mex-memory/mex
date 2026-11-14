import { readFileSync, writeFileSync, mkdirSync, lstatSync, readdirSync, mkdtempSync, cpSync, existsSync } from 'node:fs';
import { resolve, join, basename, dirname, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { npm, run, npmEnvironment } from './commands.mjs';
import { optionalFor, TARGETS } from './plan.mjs';

export async function packedManifest(file) {
  return JSON.parse(await run('tar', ['-xOf', basename(file), 'package/package.json'], { cwd: dirname(resolve(file)) }));
}
export function checkManifest(manifest, entry, plan) {
  if (manifest.name !== entry.name || manifest.version !== plan.version) throw new Error('Packed name/version mismatch');
  if (entry.target) {
    const [os, cpu] = entry.target.split('-');
    if (JSON.stringify(manifest.os) !== JSON.stringify([os]) || JSON.stringify(manifest.cpu) !== JSON.stringify([cpu])) throw new Error('Packed platform constraints mismatch');
  } else {
    const expected = optionalFor(plan.version);
    if (JSON.stringify(Object.entries(manifest.optionalDependencies || {}).sort()) !== JSON.stringify(Object.entries(expected).sort())) throw new Error('Packed root must contain exactly six optional packages at its own version');
  }
}
export async function packBundle(root, directory, plan) {
  mkdirSync(directory, { recursive: true });
  // Stage the shipped root files so packing never dirties the tested checkout
  // or makes ordinary npm ci resolve platform names that are not published yet.
  const stage = mkdtempSync(join(tmpdir(), 'mex-release-stage-'));
  const manifest = JSON.parse(readFileSync(join(root, 'package.json')));
  manifest.optionalDependencies = optionalFor(plan.version);
  for (const file of new Set([...manifest.files, '.npmignore', 'npm-shrinkwrap.json', ...readdirSync(root).filter((name) => /^(?:readme|licen[cs]e|copying)(?:\..*)?$/i.test(name))])) {
    if (isAbsolute(file) || file.split(/[\\/]/).includes('..')) throw new Error('Invalid package files entry');
    if (existsSync(join(root, file))) cpSync(join(root, file), join(stage, file), { recursive: true, dereference: false });
  }
  for (const workspace of manifest.workspaces || []) {
    mkdirSync(join(stage, workspace), { recursive: true });
    cpSync(join(root, workspace, 'package.json'), join(stage, workspace, 'package.json'));
  }
  writeFileSync(join(stage, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  for (const entry of plan.packages) {
    if (entry.target) {
      const binary = join(root, entry.directory, 'bin', entry.target.startsWith('win32-') ? 'mex-hook.exe' : 'mex-hook');
      if (!lstatSync(binary).isFile()) throw new Error(`Missing binary: ${entry.target}`);
    }
    // Production build is explicit and already completed before this pack step.
    const result = JSON.parse(await npm(['pack', '--ignore-scripts', '--json', '--pack-destination', directory], { cwd: entry.target ? join(root, entry.directory) : stage, env: npmEnvironment() }));
    if (result.length !== 1 || result[0].filename !== entry.file) throw new Error('Unexpected packed filename');
    checkManifest(await packedManifest(join(directory, entry.file)), entry, plan);
    if (!entry.target) {
      const source = JSON.parse(await npm(['pack', '--dry-run', '--ignore-scripts', '--json'], { cwd: root, env: npmEnvironment() }));
      const paths = (pack) => pack.files.map((file) => file.path).sort();
      if (JSON.stringify(paths(source[0])) !== JSON.stringify(paths(result[0]))) throw new Error('Staging changed the shipped root file list');
    }
  }
  const checksums = plan.packages.map(({ file }) => `${createHash('sha256').update(readFileSync(join(directory, file))).digest('hex')}  ${file}`).join('\n') + '\n';
  writeFileSync(join(directory, 'SHA256SUMS'), checksums);
  writeFileSync(join(directory, 'release-plan.json'), JSON.stringify(plan, null, 2) + '\n');
  await verifyBundle(directory, plan);
}
export async function verifyBundle(directory, plan) {
  if (JSON.stringify(JSON.parse(readFileSync(join(directory, 'release-plan.json')))) !== JSON.stringify(plan)) throw new Error('Artifact plan does not match this release');
  const expectedFiles = [...plan.packages.map((entry) => entry.file), 'release-plan.json', 'SHA256SUMS'].sort();
  if (JSON.stringify(readdirSync(directory).sort()) !== JSON.stringify(expectedFiles)) throw new Error('Unexpected release bundle contents');
  const lines = readFileSync(join(directory, 'SHA256SUMS'), 'utf8').trim().split('\n');
  if (lines.length !== 7) throw new Error('Expected seven checksums');
  for (const [index, entry] of plan.packages.entries()) {
    const path = resolve(directory, entry.file), st = lstatSync(path);
    if (!st.isFile() || st.isSymbolicLink() || st.size > 100 * 1024 * 1024) throw new Error('Invalid tarball');
    const digest = createHash('sha256').update(readFileSync(path)).digest('hex');
    if (lines[index] !== `${digest}  ${entry.file}`) throw new Error('Tarball checksum mismatch');
    checkManifest(await packedManifest(path), entry, plan);
    if (entry.target) {
      const members = (await run('tar', ['-tzf', basename(path)], { cwd: dirname(path) })).trim().split(/\r?\n/);
      const executable = entry.target.startsWith('win32-') ? 'mex-hook.exe' : 'mex-hook';
      if (!members.includes('package/bin/' + executable) || !members.includes('package/bin/THIRD-PARTY-NOTICES.txt')) throw new Error('Packed platform binary or license inventory missing');
    }
  }
  return TARGETS.length + 1;
}
