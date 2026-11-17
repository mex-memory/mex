import { spawn } from 'node:child_process';
import { join } from 'node:path';

// Children cannot leave the runner waiting forever on a grandchild's pipe.
// No shell, corpus-supplied command, or unbounded diagnostic output is used.
export function runProcess(command, args, { cwd, env = process.env, timeoutMs = 120_000, maxBytes = 2 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(command, args, { cwd, env, detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch { resolve({ reason: 'tool-unavailable', code: null, stdout: '' }); return; }
    const output = [];
    let bytes = 0, reason, settled = false, force, deadline, finishDeadline;
    const kill = (hard) => {
      if (!child.pid) return;
      if (process.platform === 'win32') {
        const taskkill = spawn(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        taskkill.on('error', () => { try { child.kill('SIGKILL'); } catch {} });
        taskkill.unref();
      } else {
        try { process.kill(-child.pid, hard ? 'SIGKILL' : 'SIGTERM'); } catch { /* Already gone. */ }
      }
    };
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      // Keep escalation alive after the parent's close: a descendant may have
      // closed its pipes and ignored SIGTERM while remaining in the group.
      if (!reason) clearTimeout(force);
      clearTimeout(finishDeadline);
      child.stdout.destroy(); child.stderr.destroy();
      resolve({ code, reason, stdout: Buffer.concat(output).toString('utf8') });
    };
    const stop = (why) => {
      if (reason || settled) return;
      reason = why; kill(false);
      force = setTimeout(() => kill(true), 250);
      finishDeadline = setTimeout(() => finish(null), 1500);
    };
    const consume = (chunk, keep) => {
      bytes += chunk.length;
      if (bytes > maxBytes) { stop('output-limit'); return; }
      if (keep) output.push(chunk);
    };
    child.stdout.on('data', (chunk) => consume(chunk, true));
    child.stderr.on('data', (chunk) => consume(chunk, false));
    child.on('error', () => { reason = 'tool-unavailable'; finish(null); });
    child.on('close', (code, signal) => { if (signal && !reason) { reason = 'interrupted'; kill(true); } finish(code); });
    deadline = setTimeout(() => stop('timeout'), timeoutMs);
  });
}
