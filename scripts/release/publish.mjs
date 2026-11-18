import { join } from 'node:path';
import { verifyBundle } from './bundle.mjs';
import { authorize } from './plan.mjs';
import { npm, npmEnvironment, run } from './commands.mjs';

export async function publishBundle(directory, plan, evidence, { invoke = npm, verify = verifyBundle, env = process.env, log = console.log } = {}) {
  authorize(plan, evidence);
  if (!plan.dryRun && (env.GITHUB_ACTIONS !== 'true' || !['push', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME) || env.GITHUB_SHA !== plan.commit)) throw new Error('Real publishing is allowed only in the protected release workflow');
  await verify(directory, plan);
  const npmEnv = npmEnvironment({ token: !plan.dryRun });
  for (const entry of plan.packages) {
    if (!plan.dryRun) {
      try {
        const existing = JSON.parse(await invoke(['view', `${entry.name}@${plan.version}`, 'version', '--json', '--registry=https://registry.npmjs.org/'], { env: npmEnv }));
        if (existing !== plan.version) throw new Error('Unexpected registry version');
        log(`Already published: ${entry.name}@${plan.version}; skipping.`); continue;
      } catch (error) {
        // Network/authentication/registry errors must not masquerade as absence.
        if (!/E404/.test(String(error.stderr || error.message))) throw error;
      }
    }
    const args = ['publish', join(directory, entry.file), '--tag', plan.distTag, '--provenance', '--access', 'public', '--registry=https://registry.npmjs.org/', '--ignore-scripts'];
    if (plan.dryRun) args.push('--dry-run');
    log(`${plan.dryRun ? 'Would publish' : 'Publishing'} ${entry.name}@${plan.version} to npmjs.org with tag ${plan.distTag}`);
    log(await invoke(args, { env: npmEnv }));
  }
}

export function githubReleaseArgs(directory, plan) {
  return ['release', 'create', plan.tag, '--verify-tag', '--target', plan.commit, '--title', plan.tag,
    '--notes', `Release ${plan.version}. Packages were built from ${plan.commit}.`, ...(plan.prerelease ? ['--prerelease'] : []),
    ...plan.packages.map((entry) => join(directory, entry.file)), join(directory, 'SHA256SUMS')];
}
export async function githubRelease(directory, plan, evidence) {
  authorize(plan, evidence); await verifyBundle(directory, plan);
  const args = githubReleaseArgs(directory, plan);
  if (plan.dryRun) { console.log('Would run: gh ' + args.map((arg) => "'" + arg.replaceAll("'", "'\"'\"'") + "'").join(' ')); return; }
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_SHA !== plan.commit) throw new Error('GitHub releases run only in the release workflow');
  let exists = false;
  try { await run('gh', ['release', 'view', plan.tag, '--json', 'tagName']); exists = true; }
  catch (error) { if (!/not found|HTTP 404/i.test(String(error.stderr || error.message))) throw error; }
  if (exists) await run('gh', ['release', 'upload', plan.tag, ...plan.packages.map((entry) => join(directory, entry.file)), join(directory, 'SHA256SUMS'), '--clobber']);
  else await run('gh', args);
}
