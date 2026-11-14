import { readFileSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { makePlan, packagesFor, authorize } from './plan.mjs';
import { installNpm, run } from './commands.mjs';
import { packBundle } from './bundle.mjs';
import { smokeBundle } from './smoke.mjs';
import { publishBundle, githubRelease } from './publish.mjs';

const root = process.cwd(), action = process.argv[2];
const summary = (text) => { console.log(text); if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + '\n'); };
const output = (key, value) => { if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`); };
const git = (args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
try {
  if (action === 'npm') {
    const cli = await installNpm(resolve(process.argv[3]));
    if (process.env.GITHUB_ENV) appendFileSync(process.env.GITHUB_ENV, `MEX_RELEASE_NPM_CLI=${cli}\n`);
    console.log(`Verified npm 11.6.1: ${cli}`);
  } else if (action === 'plan') {
    const { version } = JSON.parse(readFileSync('package.json'));
    const commit = git(['rev-parse', 'HEAD']);
    if (process.env.GITHUB_SHA && commit !== process.env.GITHUB_SHA) throw new Error('Checkout does not match the release commit');
    const plan = makePlan({ event: process.env.GITHUB_EVENT_NAME, refType: process.env.GITHUB_REF_TYPE, refName: process.env.GITHUB_REF_NAME,
      dryRun: process.env.RELEASE_DRY_RUN !== 'false', requireGates: process.env.RELEASE_REQUIRE_GATES !== 'false', version, commit,
      platformVersions: packagesFor(version).slice(0, 6).map((entry) => JSON.parse(readFileSync(resolve(root, entry.directory, 'package.json'))).version) });
    if (!plan.dryRun && git(['rev-parse', `refs/tags/${plan.tag}^{commit}`]) !== commit) throw new Error('Real releases require an existing version tag on this commit');
    output('json', JSON.stringify(plan)); output('dry_run', plan.dryRun); output('require_gates', plan.requireGates); output('release', plan.release);
    summary(`${plan.dryRun ? 'DRY RUN' : 'REAL RELEASE'} ${plan.version} at ${commit} to npmjs.org, dist-tag ${plan.distTag}.\nPublish order:\n` + plan.packages.map((entry, i) => `${i + 1}. ${entry.name}@${plan.version}`).join('\n'));
  } else {
    const plan = JSON.parse(process.env.RELEASE_PLAN);
    // Bind the trusted job plan to this checkout; bundle validation matches it exactly.
    if (plan.version !== JSON.parse(readFileSync('package.json')).version || plan.commit !== git(['rev-parse', 'HEAD'])) throw new Error('Plan does not describe this checkout');
    const evidence = { result: process.env.RELEASE_GATE_RESULT, commit: process.env.RELEASE_GATE_COMMIT };
    const verdict = authorize(plan, evidence);
    if (action === 'authorize') {
      summary(verdict); output('gate_result', evidence.result || 'skipped'); output('gate_commit', evidence.commit || '');
    } else {
      const directory = resolve(process.argv[3] || 'test-results/release');
      if (action === 'pack') {
        const binary = resolve('npm', `hook-${process.platform}-${process.arch}`, 'bin', process.platform === 'win32' ? 'mex-hook.exe' : 'mex-hook');
        const self = JSON.parse(await run(binary, ['--self-test']));
        if (self.ok !== true || self.version !== plan.version) throw new Error('Host hook binary failed its versioned self-test');
        await packBundle(root, directory, plan);
      }
      else if (action === 'smoke') await smokeBundle(directory, plan);
      else if (action === 'dry-publish') {
        if (!plan.dryRun) throw new Error('Expected a dry run');
        await publishBundle(directory, plan, evidence); await githubRelease(directory, plan, evidence);
        summary(verdict + '\nDry run completed. Nothing was published to npm or GitHub.\n' + plan.packages.map((entry) => `${entry.name}@${plan.version} -> https://registry.npmjs.org/ (tag ${plan.distTag})`).join('\n'));
      } else if (action === 'publish') {
        if (plan.dryRun) throw new Error('Real publish step cannot accept a rehearsal plan');
        await publishBundle(directory, plan, evidence);
      } else if (action === 'github') {
        if (plan.dryRun) throw new Error('Real GitHub release step cannot accept a rehearsal plan');
        await githubRelease(directory, plan, evidence);
      } else throw new Error('Unknown release action');
    }
  }
} catch (error) { console.error(error.message); if (error.stderr) console.error(String(error.stderr)); process.exitCode = 1; }
