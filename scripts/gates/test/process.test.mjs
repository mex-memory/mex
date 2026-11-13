import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { runProcess } from '../process.mjs';

test('process runner preserves UTF-8 output and distinguishes missing tools', async () => {
  const result = await runProcess(process.execPath, ['-e', "process.stdout.write('counts: 2–5')"]);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, 'counts: 2–5');
  assert.equal((await runProcess('mex-gate-nonexistent-command', [])).reason, 'tool-unavailable');
});

test('process runner bounds output and terminates a hanging process', async () => {
  const overflow = await runProcess(process.execPath, ['-e', "process.stdout.write('x'.repeat(4096));setInterval(()=>{},1000)"], { maxBytes: 128, timeoutMs: 5000 });
  assert.equal(overflow.reason, 'output-limit');
  assert.ok(overflow.stdout.length <= 128);
  const started = Date.now();
  const timeout = await runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 100 });
  assert.equal(timeout.reason, 'timeout');
  assert.ok(Date.now() - started < 4000);
});

test('deadline terminates descendants that inherit the output pipes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mex-gate-tree-'));
  const marker = join(root, 'escaped');
  try {
    const child = `setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'escaped'),1200);setInterval(()=>{},1000)`;
    const parent = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:['ignore','inherit','inherit']});setInterval(()=>{},1000)`;
    const result = await runProcess(process.execPath, ['-e', parent], { timeoutMs: 300 });
    assert.equal(result.reason, 'timeout');
    await delay(1400);
    assert.equal(existsSync(marker), false, 'a descendant survived termination');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('deadline also handles an exited parent with live descendants on POSIX', { skip: process.platform === 'win32' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'mex-gate-orphan-'));
  const marker = join(root, 'escaped');
  try {
    const child = `process.on('SIGTERM',()=>{});setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'escaped'),1200);setInterval(()=>{},1000)`;
    const parent = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:['ignore','inherit','inherit']});process.exit(0)`;
    assert.equal((await runProcess(process.execPath, ['-e', parent], { timeoutMs: 300 })).reason, 'timeout');
    await delay(1400);
    assert.equal(existsSync(marker), false, 'a descendant survived escalation');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
