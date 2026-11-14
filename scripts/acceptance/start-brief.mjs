/** Live acceptance is opt-in. --prepare runs no models and changes no user settings.
 * --run starts two short sessions per selected CLI using the existing login.
 * Keep its generated transcripts in ignored/local output, never in Git. */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const cli = join(source, 'dist/cli.js');
const binary = join(source, 'test-results', process.platform === 'win32' ? 'mex-hook.exe' : 'mex-hook');
const run = (command, args, options = {}) => {
  const { evidence, ...spawnOptions } = options;
  const child = spawnSync(command, args, { encoding: 'utf8', timeout: 120_000, maxBuffer: 8 << 20, windowsHide: true, ...spawnOptions });
  if (evidence) {
    writeFileSync(`${evidence}.jsonl`, child.stdout ?? '', { mode: 0o600 });
    writeFileSync(`${evidence}.stderr`, child.stderr ?? String(child.error ?? ''), { mode: 0o600 });
  }
  if (child.error || child.status !== 0) throw new Error(`Acceptance command failed: ${command} (exit ${child.status})`);
  return child.stdout;
};

function prepare() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'mex-start-brief-')));
  const fixtures = [];
  for (const agent of ['claude-code', 'codex']) {
    const root = join(base, agent), mexBase = join(base, `${agent}-mex`);
    mkdirSync(join(root, 'apps/api'), { recursive: true });
    mkdirSync(join(root, '.claude'), { recursive: true });
    mkdirSync(join(root, '.codex'), { recursive: true });
    mkdirSync(join(root, '.mex/learned'), { recursive: true });
    run('git', ['init', '-q', root]);
    writeFileSync(join(root, 'AGENTS.md'), '# Acceptance fixture\n');
    writeFileSync(join(root, 'README.md'), '# API fixture\n');
    writeFileSync(join(root, 'apps/api/main.ts'), 'export const ready = true;\n');
    const native = 'The API release codeword is MANGO-7421.';
    writeFileSync(join(root, '.mex/learned/mx_release.md'), `---\nmex:\n  id: mx_release\n  kind: rule\n  scope: ["apps/api/**"]\n  source: {type: docs, ref: README.md}\n  evidence: docs\n  one_line: "${native}"\n  checks: []\n  status: active\n  created: 2026-11-15\n---\n${native}\n`);
    const env = { ...process.env, MEX_HOME: mexBase, MEX_BACKGROUND: '0', MEX_TELEMETRY: '0', MEX_HOOK_BINARY: binary };
    run(process.execPath, [cli, 'rules', '--write', '--now'], { cwd: root, env });
    const wrapper = join(base, `${agent}-hook.cjs`);
    const replies = join(base, `${agent}-replies.jsonl`);
    writeFileSync(wrapper, `const {spawnSync}=require('node:child_process');const fs=require('node:fs');const input=fs.readFileSync(0);const r=spawnSync(${JSON.stringify(binary)},process.argv.slice(2),{input,env:{...process.env,MEX_HOME:${JSON.stringify(mexBase)},MEX_BACKGROUND:'0',MEX_TELEMETRY:'0'}});fs.appendFileSync(${JSON.stringify(replies)},JSON.stringify({event:process.argv[3],reply:r.stdout?.toString()})+'\\n');process.stdout.write(r.stdout||'{}\\n');`);
    const events = ['SessionStart', 'InstructionsLoaded'];
    const settings = { hooks: Object.fromEntries(events.filter(e => agent === 'claude-code' || e !== 'InstructionsLoaded').map(event => [event, [{ hooks: [agent === 'claude-code'
      ? { type: 'command', command: process.execPath, args: [wrapper, agent, event], timeout: 10, onFailure: 'continue' }
      : { type: 'command', command: [process.execPath, wrapper, agent, event].map(s => `'${s.replace(/'/g, "'\\''")}'`).join(' '), timeout: 10 }] }]])) };
    const settingsFile = join(root, agent === 'claude-code' ? '.claude/acceptance.json' : '.codex/hooks.json');
    writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
    const preview = JSON.parse(run(process.execPath, [cli, 'brief', '--agent', agent, '--path', 'apps/api/main.ts', '--json'], { cwd: root, env }));
    if (!preview.coverage.files.some(f => f.ids.includes('mx_release') && f.agents.includes(agent))) throw new Error('The generated rule is missing from coverage.');
    const generated = preview.coverage.files.filter(f => f.ids.includes('mx_release'));
    const nativeBytes = generated.reduce((n, f) => n + Buffer.byteLength(readFileSync(join(root, f.path))), 0);
    fixtures.push({ agent, root, mexBase, settingsFile, replies, nativeBytes });
  }
  const file = join(base, 'acceptance.json');
  writeFileSync(file, JSON.stringify({ version: 1, binary, fixtures }, null, 2));
  console.log(`Prepared ${file}`);
  console.log('Pass rule: both CLIs report the generated native codeword on a matching read, then report a new mex note in the next session without reading it. Receipts and fixture transcripts are retained. MEX standing text must have a conservative UTF-8-byte token bound below 1000.');
  console.log(`Run only after explicit live-test approval: node scripts/acceptance/start-brief.mjs --run ${file}`);
}

function finalText(output, agent) {
  const events = output.trim().split("\n").map(line => JSON.parse(line));
  return events.flatMap(e => agent === 'claude-code'
    ? e.type === 'result' ? [e.result ?? ''] : []
    : e.type === 'item.completed' && e.item?.type === 'agent_message' ? [e.item.text] : []).join('\n');
}

function live(file, resume = false, verifyOnly = false) {
  const plan = JSON.parse(readFileSync(file, 'utf8'));
  const results = [];
  for (const f of plan.fixtures) {
    const env = { ...process.env, MEX_HOME: f.mexBase, MEX_BACKGROUND: '0', MEX_TELEMETRY: '0', MEX_HOOK_BINARY: plan.binary };
    delete env.CLAUDECODE;
    const area = f.agent === 'codex' ? join(f.root, 'apps/api') : f.root;
    const session = (prompt, name) => {
      // Inline configuration registers only the vetted fixture hook. Project
      // .codex layers may be untrusted; user settings stay untouched.
      const hook = JSON.parse(readFileSync(f.settingsFile, 'utf8')).hooks.SessionStart[0].hooks[0];
      const inline = `hooks.SessionStart=[{hooks=[{type="command",command=${JSON.stringify(hook.command)},timeout=10}]}]`;
      const args = f.agent === 'claude-code'
        ? ['--print', '--verbose', '--output-format', 'stream-json', '--include-hook-events', '--setting-sources', 'project,local', '--settings', f.settingsFile, '--strict-mcp-config', '--tools', 'Read', '--allowedTools', 'Read']
        : ['exec', '--json', '--ignore-user-config', '--ignore-rules', '--enable', 'hooks', '--config', inline, '--sandbox', 'read-only', '--dangerously-bypass-hook-trust', '--cd', area, prompt];
      return run(f.agent === 'claude-code' ? 'claude' : 'codex', args, { cwd: area, env, ...(f.agent === 'claude-code' ? { input: prompt } : {}), evidence: join(dirname(file), `${f.agent}-${name}`) });
    };
    const artifact = name => join(dirname(file), `${f.agent}-${name}.jsonl`);
    const readArtifact = name => { try { return readFileSync(artifact(name), 'utf8'); } catch { return ''; } };
    const valid = (output, words) => output && words.every(word => finalText(output, f.agent).includes(word));
    const matching = f.agent === 'codex' ? 'main.ts' : 'apps/api/main.ts';
    const nativePrompt = `Read ${matching} using the file-reading tool. Report the API release codeword. Do not open any instruction files yourself.`;
    let nativeOutput = readArtifact('native');
    if (!resume) {
      nativeOutput = session(nativePrompt, 'native');
      if (!valid(nativeOutput, ['MANGO-7421'])) throw new Error(`${f.agent}: native rule was not loaded`);
    }
    const existing = JSON.parse(run(process.execPath, [cli, 'recall', 'CHECK-PLUM-6241', '--json'], { cwd: f.root, env })).entries?.find(e => e.one_line?.includes('CHECK-PLUM-6241'));
    if (verifyOnly && !existing) throw new Error(`${f.agent}: no existing note to verify`);
    const saved = existing ? {entry:{mex:{id:existing.id}}} : JSON.parse(run(process.execPath, [cli, 'note', 'My review habit is CHECK-PLUM-6241, because it keeps reviews small.', '--json'], { cwd: f.root, env }));
    let second = readArtifact('note');
    let secondName = 'note';
    if (resume) {
      secondName = 'native-and-note-after-fix';
      second = readArtifact(secondName);
      if (!valid(second, ['MANGO-7421', 'CHECK-PLUM-6241']) && !verifyOnly) second = session(`${nativePrompt} Also report my saved personal review habit without opening any other files. Do not open note files yourself.`, secondName);
      nativeOutput = second;
    } else second = session('Without reading files or using tools, report my saved review habit.', secondName);
    if (!valid(nativeOutput, ['MANGO-7421'])) throw new Error(`${f.agent}: native rule was not loaded`);
    if (!valid(second, ['CHECK-PLUM-6241'])) throw new Error(`${f.agent}: note did not reach the next session`);
    const preview = JSON.parse(run(process.execPath, [cli, 'brief', '--agent', f.agent, '--json'], { cwd: f.root, env }));
    const db = new DatabaseSync(join(f.mexBase, '.mex/hooks.db'), { readOnly: true });
    const receipts = db.prepare("SELECT session_id,entry_id,block_id,moment,tokens FROM deliveries WHERE moment='start-brief' ORDER BY ts,id").all();
    db.close();
    if (!receipts.some(r => r.entry_id === saved.entry.mex.id)) throw new Error(`${f.agent}: no delivery receipt for the note`);
    const areaPreview = JSON.parse(run(process.execPath, [cli, 'brief', '--agent', f.agent, '--path', 'apps/api/main.ts', '--json'], { cwd: f.root, env }));
    const nativePaths = [...new Set(areaPreview.coverage.files.filter(rule => rule.agents.includes(f.agent)).map(rule => rule.path))];
    // Include every generated MEX native file in this fixture's matching area,
    // including root personal files. Authored instructions are not MEX text.
    const nativeBytes = nativePaths.reduce((n, path) => { const body = readFileSync(join(f.root, path)); return n + (body.includes('<!-- mex:generated') ? body.byteLength : 0); }, 0);
    const bound = nativeBytes + preview.token_bound;
    if (bound >= 1000) throw new Error(`${f.agent}: standing footprint exceeds its conservative bound`);
    results.push({ agent: f.agent, native: true, nextSessionNote: true, standingTokenUpperBound: bound, nativeArtifact: artifact(resume ? secondName : 'native'), noteArtifact: artifact(secondName), receipts });
    writeFileSync(join(dirname(file), 'results.json'), JSON.stringify({ results }, null, 2));
    console.log(`${f.agent}: native rule, next-session note, and footprint checks pass.`);
  }
}

if (process.argv[2] === '--prepare') prepare();
else if (process.argv[2] === '--run' && process.argv[3]) live(resolve(process.argv[3]));
else if (process.argv[2] === '--resume' && process.argv[3]) live(resolve(process.argv[3]), true);
else if (process.argv[2] === '--verify' && process.argv[3]) live(resolve(process.argv[3]), true, true);
else throw new Error('Use --prepare, or --run <prepared acceptance.json> only after live-test approval.');
