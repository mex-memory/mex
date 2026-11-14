export const TARGETS = Object.freeze(['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64', 'win32-x64', 'win32-arm64']);
export const packagesFor = (version) => [...TARGETS.map((target) => ({ name: `mex-agent-hook-${target}`, directory: `npm/hook-${target}`, file: `mex-agent-hook-${target}-${version}.tgz`, target })), { name: 'mex-agent', directory: '.', file: `mex-agent-${version}.tgz` }];
export const optionalFor = (version) => Object.fromEntries(TARGETS.map((target) => [`mex-agent-hook-${target}`, version]));

export function makePlan({ event, refType, refName, dryRun = true, requireGates = true, version, platformVersions, commit }) {
  if (!['push', 'pull_request', 'workflow_dispatch'].includes(event)) throw new Error('Unsupported release event');
  if (!/^0\.9\.0(?:-(?:beta|rc)\.(?:0|[1-9]\d*))?$/.test(version)) throw new Error('Unsupported release version');
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Invalid release commit');
  if (typeof dryRun !== 'boolean' || typeof requireGates !== 'boolean') throw new Error('Release switches must be booleans');
  if (platformVersions.length !== 6 || platformVersions.some((value) => value !== version)) throw new Error('Platform package versions must equal the root version');
  if (refType === 'tag' && refName !== `v${version}`) throw new Error('Tag must equal the root and platform package versions');
  if (event === 'push' && refType !== 'tag') throw new Error('A release push must be a version tag');
  const dry = event === 'pull_request' || (event === 'workflow_dispatch' && dryRun);
  const required = event === 'pull_request' ? false : event === 'push' ? true : requireGates;
  if (!dry && !required) throw new Error('A real publish cannot bypass gates');
  const beta = /^0\.9\.0-beta\.(\d+)$/.exec(version);
  return { version, commit, dryRun: dry, requireGates: required, distTag: version.includes('-') ? 'next' : 'latest',
    prerelease: version.includes('-'), release: beta ? (+beta[1] <= 1 ? 'beta.1' : 'beta.2') : 'final', tag: `v${version}`, packages: packagesFor(version) };
}

export function requireEvidence(plan, evidence = {}) {
  if (evidence.result !== 'success' || evidence.commit !== plan.commit) throw new Error('Release refused: passing release-gates on this exact commit are required');
}

export function authorize(plan, evidence) {
  if (!plan.dryRun && !plan.requireGates) throw new Error('A real publish cannot bypass gates');
  if (plan.requireGates) { requireEvidence(plan, evidence); return 'Same-commit release-gates passed.'; }
  // A rehearsal must exercise the real refusal, not fabricate passing evidence.
  let refused = false;
  try { requireEvidence(plan, evidence); } catch { refused = true; }
  if (!refused) throw new Error('Expected absent gate evidence for the bypass rehearsal');
  return `Gates were skipped for this dry run. Refusal proof passed for ${plan.commit}: a real release would need passing same-commit gates.`;
}
