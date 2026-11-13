import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectRelease } from './catalog.mjs';
import { PLATFORMS, sourceState, validReport, releaseReady } from './runner.mjs';

export function validateMatrix(reports, { commit, release }) {
  return Array.isArray(reports) && reports.length === PLATFORMS.length && reports.every(validReport)
    && new Set(reports.map((report) => report.platform)).size === PLATFORMS.length
    && reports.every((report) => report.commit === commit && report.release === release && releaseReady(report));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const directory = resolve(process.argv[2] || 'test-results/gates/matrix');
    const { version } = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
    const release = selectRelease(undefined, process.env, version);
    const files = readdirSync(directory);
    if (files.length !== 3) throw new Error('Expected exactly three reports');
    const reports = files.map((file) => {
      const path = resolve(directory, file), st = lstatSync(path);
      if (!st.isFile() || st.isSymbolicLink() || st.size > 32 * 1024) throw new Error('Invalid report file');
      return JSON.parse(readFileSync(path, 'utf8'));
    });
    if (process.env.GITHUB_ACTIONS === 'true' && process.env.MEX_GATE_JOB_RESULT !== 'success') throw new Error('Producer jobs did not succeed');
    if (!validateMatrix(reports, { ...sourceState(root), release })) throw new Error('Matrix did not pass');
    console.log(`Release gates passed for ${release} on Linux, macOS and Windows at ${sourceState(root).commit}.`);
  } catch {
    console.error('Release blocked: require passing reports from all three OSes for this exact commit and release profile.');
    process.exitCode = 1;
  }
}
