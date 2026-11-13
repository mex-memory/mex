import { runProcess } from './process.mjs';
import { join } from 'node:path';

export async function hookTiming({ root, run = runProcess }) {
  const result = await run('go', ['test', '-count=1', '-p', '1', '-json', '-run', '^TestNoOpTiming(WithCounters)?$', './cmd/mex-hook'], {
    cwd: join(root, 'native'), timeoutMs: 180_000,
    env: { ...process.env, CGO_ENABLED: '0', GOFLAGS: '', GOOS: { win32: 'windows', darwin: 'darwin', linux: 'linux' }[process.platform],
      GOARCH: { x64: 'amd64', arm64: 'arm64' }[process.arch], MEX_HOOK_BUDGET_MS: '', MEX_HOOK_TIMING_OUT: '', MEX_TELEMETRY: '0', DO_NOT_TRACK: '1', MEX_OFFLINE: '1' },
  });
  if (result.reason) return { status: result.reason === 'tool-unavailable' ? 'unavailable' : 'fail', reason: result.reason };
  if (result.code !== 0) return { status: 'fail', reason: 'checks-failed' };
  const expectedPackage = 'github.com/mex-memory/mex/native/cmd/mex-hook';
  const passes = new Set(), started = new Set();
  let packagePassed = false, invalid = false;
  const timings = {};
  try {
    for (const line of result.stdout.trim().split('\n')) {
      const event = JSON.parse(line);
      if (event.Package !== expectedPackage) { invalid = true; continue; }
      if (event.Test && !/^TestNoOpTiming(WithCounters)?$/.test(event.Test)) { invalid = true; continue; }
      if (event.Action === 'run' && event.Test) started.add(event.Test);
      if (['fail', 'skip'].includes(event.Action)) invalid = true;
      if (event.Action === 'pass') { if (event.Test) passes.add(event.Test); else packagePassed = true; }
      if (typeof event.Output === 'string') {
        const match = /runs=(\d+) p50=([\d.]+)ms p95=([\d.]+)ms max=([\d.]+)ms \| bare process p50=([\d.]+)ms p95=([\d.]+)ms/.exec(event.Output);
        if (match && event.Test) {
          const numbers = match.slice(1).map(Number);
          if (numbers.some((value) => !Number.isFinite(value) || value < 0) || numbers[0] !== 200) invalid = true;
          timings[event.Test] = { samples: numbers[0], p50_ms: numbers[1], p95_ms: numbers[2], max_ms: numbers[3], bare_p50_ms: numbers[4], bare_p95_ms: numbers[5] };
        }
      }
    }
  } catch { invalid = true; }
  if (invalid || !packagePassed || !started.has('TestNoOpTiming') || passes.size !== started.size
    || [...started].some((name) => !passes.has(name) || !timings[name])) return { status: 'fail', reason: 'invalid-evidence' };
  return { status: 'pass', reason: 'checked', checks: { total: passes.size, failed: 0, skipped: 0 }, timings };
}
