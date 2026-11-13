import { execFileSync } from 'node:child_process';
import { GATES, REASONS, RELEASES, required } from './catalog.mjs';
import { hookTiming } from './hook-timing.mjs';

export const PLATFORMS = ['linux', 'darwin', 'win32'];
export function sourceState(root) {
  const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  return { commit: git(['rev-parse', 'HEAD']), dirty: git(['status', '--porcelain', '--untracked-files=normal']) !== '' };
}

const exactKeys = (object, keys) => object && typeof object === 'object' && !Array.isArray(object)
  && Object.keys(object).every((key) => keys.includes(key));
const count = (value) => Number.isSafeInteger(value) && value >= 0;
export function validEvidence(value) {
  if (!exactKeys(value, ['status', 'reason', 'checks', 'timings']) || !['pass', 'fail', 'not-built', 'unavailable'].includes(value.status) || !Object.hasOwn(REASONS, value.reason)) return false;
  if (value.status === 'not-built') return value.reason === 'adapter-not-built' && value.checks === undefined && value.timings === undefined;
  if (value.status === 'unavailable') return value.reason === 'tool-unavailable' && value.checks === undefined && value.timings === undefined;
  if (value.status === 'fail') return !['checked', 'adapter-not-built', 'tool-unavailable'].includes(value.reason) && value.checks === undefined && value.timings === undefined;
  if (value.reason !== 'checked' || !exactKeys(value.checks, ['total', 'failed', 'skipped']) || !count(value.checks.total)
    || value.checks.total === 0 || value.checks.failed !== 0 || value.checks.skipped !== 0) return false;
  if (value.timings !== undefined) {
    if (!exactKeys(value.timings, ['TestNoOpTiming', 'TestNoOpTimingWithCounters']) || !Object.hasOwn(value.timings, 'TestNoOpTiming')) return false;
    for (const timing of Object.values(value.timings)) {
      if (!exactKeys(timing, ['samples', 'p50_ms', 'p95_ms', 'max_ms', 'bare_p50_ms', 'bare_p95_ms']) || timing.samples !== 200
        || ['p50_ms', 'p95_ms', 'max_ms', 'bare_p50_ms', 'bare_p95_ms'].some((key) => !Number.isFinite(timing[key]) || timing[key] < 0)
        || timing.p50_ms > timing.p95_ms || timing.p95_ms > timing.max_ms || timing.bare_p50_ms > timing.bare_p95_ms) return false;
      // The Go test enforces the unrounded deadline. At this report boundary,
      // allow only the 0.01 ms precision lost by its two-decimal rendering.
      if (timing.p95_ms > 17 && timing.p95_ms > timing.bare_p95_ms + 3.01) return false;
    }
  }
  return true;
}

export function releaseReady(report) {
  return !report.dirty && report.gates.every((gate) => gate.status !== 'fail' && (!gate.required || gate.status === 'pass'));
}

function validGateEvidence(id, evidence) {
  return validEvidence(evidence) && (id === 'hook-timing'
    ? evidence.status !== 'pass' || (evidence.timings !== undefined && evidence.checks.total === Object.keys(evidence.timings).length)
    : evidence.timings === undefined);
}

export async function runGates({ root, release = 'beta.1', platform = process.platform, source = sourceState, adapters = { 'hook-timing': hookTiming } }) {
  if (!RELEASES.includes(release) || !PLATFORMS.includes(platform)) throw new Error('Unsupported release or platform');
  const before = source(root);
  const gates = [];
  for (const gate of GATES) {
    let evidence = { status: 'not-built', reason: 'adapter-not-built' };
    if (adapters[gate.id]) {
      try { evidence = await adapters[gate.id]({ root, release, platform }); }
      catch { evidence = { status: 'fail', reason: 'checks-failed' }; }
    }
    if (!validGateEvidence(gate.id, evidence)) evidence = { status: 'fail', reason: 'invalid-evidence' };
    gates.push({ id: gate.id, required: required(gate, release), ...evidence });
  }
  const after = source(root);
  if (before.commit !== after.commit) throw new Error('Checkout changed during gates');
  const report = { schema_version: 1, commit: before.commit, dirty: before.dirty || after.dirty,
    release, platform, generated_at: new Date().toISOString(), gates };
  if (!validReport(report)) throw new Error('Invalid gate report');
  return report;
}

export function validReport(report) {
  if (!exactKeys(report, ['schema_version', 'commit', 'dirty', 'release', 'platform', 'generated_at', 'gates']) || report.schema_version !== 1
    || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(report.commit) || typeof report.dirty !== 'boolean' || !RELEASES.includes(report.release)
    || !PLATFORMS.includes(report.platform) || typeof report.generated_at !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(report.generated_at)
    || !Number.isFinite(Date.parse(report.generated_at)) || !Array.isArray(report.gates) || report.gates.length !== GATES.length) return false;
  return report.gates.every((entry, index) => {
    if (!exactKeys(entry, ['id', 'required', 'status', 'reason', 'checks', 'timings']) || entry.id !== GATES[index].id || entry.required !== required(GATES[index], report.release)) return false;
    const { id, required: isRequired, ...evidence } = entry;
    return validGateEvidence(id, evidence);
  });
}

export function table(report) {
  const lines = [`Release gates: ${report.release} | ${report.platform} | ${report.commit.slice(0, 12)}${report.dirty ? ' (dirty checkout)' : ''}`, '', 'Gate                     Required  Result       Detail'];
  for (const gate of report.gates) {
    lines.push(`${GATES.find((item) => item.id === gate.id).label.padEnd(25)}${(gate.required ? 'yes' : 'later').padEnd(10)}${gate.status.replace('-', ' ').padEnd(13)}${REASONS[gate.reason]}`);
  }
  lines.push('', releaseReady(report) ? 'Release checks passed on this OS; all three OS reports are required in CI.' : 'Release blocked: required checks must pass, failures must be fixed, and the checkout must be clean.');
  return lines.join('\n');
}
