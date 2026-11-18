// Release scope is explicit: a later feature is visible without blocking beta.1.
export const RELEASES = Object.freeze(['beta.1', 'beta.2', 'final']);
export const GATES = Object.freeze([
  { id: 'knowledge', label: 'Knowledge bench', from: 'beta.1' },
  { id: 'graph-quality', label: 'Graph quality', from: 'beta.2' },
  { id: 'call-graph', label: 'Compiler call graph', from: 'beta.2' },
  { id: 'replay', label: 'Saved-session replay', from: 'beta.2' },
  { id: 'overlay', label: 'Overlay equals fresh', from: 'beta.2' },
  { id: 'hook-timing', label: 'Hook timing', from: 'beta.1' },
  { id: 'upgrade', label: 'Three-repo upgrade', from: 'beta.1' },
].map(Object.freeze));

export const REASONS = Object.freeze({
  checked: 'checks passed',
  'adapter-not-built': 'benchmark adapter is not built',
  'tool-unavailable': 'required local tool is unavailable',
  'checks-failed': 'checks failed',
  'invalid-evidence': 'adapter produced invalid or empty evidence',
  timeout: 'check exceeded its deadline',
  'output-limit': 'check exceeded its output limit',
  interrupted: 'check process was interrupted',
});

export function required(gate, release) {
  if (!RELEASES.includes(release)) throw new Error('Unknown release profile');
  return RELEASES.indexOf(release) >= RELEASES.indexOf(gate.from);
}

export function releaseForTag(tag) {
  if (/^v?0\.9\.0-beta\.1$/.test(tag)) return 'beta.1';
  if (/^v?0\.9\.0-beta\.2$/.test(tag)) return 'beta.2';
  if (/^v?0\.9\.0(?:-rc\.\d+)?$/.test(tag)) return 'final';
  throw new Error('Unsupported release tag');
}

export function selectRelease(option, env, version) {
  const selected = option || env.MEX_GATE_RELEASE || 'beta.1';
  if (!RELEASES.includes(selected)) throw new Error('Unknown release profile');
  if (env.GITHUB_REF_TYPE !== 'tag') return selected;
  const tag = env.GITHUB_REF_NAME;
  const tagged = releaseForTag(tag ?? '');
  if (version !== tag.replace(/^v/, '')) throw new Error('Package version must match the release tag');
  if ((option || env.MEX_GATE_RELEASE) && selected !== tagged) throw new Error('Release profile does not match tag');
  return tagged;
}
