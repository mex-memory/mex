// Paired cold-process timings. Fixture source and consent mirrors are synthetic.
import { mkdirSync, writeFileSync, realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
const arg = (name, fallback) => { const at = process.argv.indexOf(name); return at < 0 ? fallback : process.argv[at + 1]; };
const base = resolve(arg('--base')), current = resolve(arg('--current')), out = resolve(arg('--output'));
const pairs = Number(arg('--pairs', '200')), counts = arg('--entries', '50,500').split(',').map(Number);
if (!Number.isInteger(pairs) || pairs < 30)
    throw Error('use at least 30 paired samples');
const work = join(out, 'work-' + Date.now());
mkdirSync(work, { recursive: true });
const hash = s => createHash('sha256').update(s).digest('hex').slice(0, 24);
const canonical = p => { const s = realpathSync.native(p); return process.platform === 'win32' ? s.replace(/[A-Z]/g, c => c.toLowerCase()) : s; };
const project = 'g-0123456789abcdef01234567';
const distribution = xs => { const s = [...xs].sort((a, b) => a - b); return { p50: s[Math.floor(s.length * .5)], p95: s[Math.min(s.length - 1, Math.floor(s.length * .95))], n: s.length }; };
const tables = 'CREATE TABLE records(hash TEXT,lang TEXT,data TEXT,PRIMARY KEY(hash,lang)); CREATE TABLE symbols(name TEXT,hash TEXT,lang TEXT,ord INTEGER,kind TEXT,start INTEGER,end INTEGER,PRIMARY KEY(name,hash,lang,ord)); CREATE TABLE counts(hash TEXT,lang TEXT,pattern TEXT,count INTEGER,PRIMARY KEY(hash,lang,pattern)); CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT);';
function setup(count, name, exe, root) {
    const home = join(work, count + '-' + name), mex = join(home, '.mex');
    mkdirSync(join(mex, 'hook-checkouts'), { recursive: true });
    writeFileSync(join(mex, 'controls.json'), JSON.stringify({ version: 1, off: false, capture: false }));
    writeFileSync(join(mex, 'hook-checkouts', hash(root) + '.json'), JSON.stringify({ version: 1, project_id: project, root, state: 'on', off_until: '', provisional: false }));
    const index = join(mex, 'projects', project, 'index');
    mkdirSync(join(index, 'checkouts'), { recursive: true });
    for (const file of ['base.db', 'snapshot.db']) {
        const db = new DatabaseSync(join(index, file));
        db.exec(tables);
        if (file === 'snapshot.db') {
            db.exec('CREATE TABLE paths(path TEXT PRIMARY KEY,hash TEXT,lang TEXT,is_test INTEGER,size INTEGER,mtime_ns TEXT,reason TEXT,name TEXT); CREATE INDEX paths_record ON paths(hash,lang);');
            const source = join(root, 'src', 'widget.ts'), stat = statSync(source, { bigint: true });
            db.prepare('INSERT INTO paths VALUES(?,?,?,0,?,?,NULL,?)').run('src/widget.ts', 'source', 'ts', Number(stat.size), String(stat.mtimeNs), 'widget.ts');
            db.prepare('INSERT INTO records VALUES(?,?,?)').run('source', 'ts', JSON.stringify({ outline: [], tokens: 30, lines: 3 }));
            db.prepare('INSERT INTO symbols VALUES(?,?,?,?,?,?,?)').run('resolveUniqueWidget', 'source', 'ts', 0, 'function', 1, 3);
        }
        db.close();
    }
    writeFileSync(join(index, 'checkouts', hash(root) + '.json'), JSON.stringify({ version: 1, root, snapshot: 'snapshot.db', base: 'base.db', as_of: '2026-11-16T00:00:00Z' }));
    const env = { ...process.env, MEX_HOME: home, MEX_TELEMETRY: '0', MEX_BACKGROUND: '0', MEX_DELIVERY_SURFACES: 'on' };
    const stage = spawnSync(exe, ['--check-run'], { input: JSON.stringify({ action: 'evaluate', checkout: root, project_id: project, mex_home: mex, record_directory: mex, store: true }), encoding: 'utf8', env, windowsHide: true, timeout: 120000 });
    if (stage.status !== 0 || !JSON.parse(stage.stdout).ok)
        throw Error('fixture checks failed: ' + stage.stderr);
    return { exe, env };
}
function invoke(lane, root, kind, id) {
    const event = kind === 'prompt' ? 'UserPromptSubmit' : kind === 'noop' ? 'PreToolUse' : 'PostToolBatch';
    const payload = { session_id: id, cwd: root, hook_event_name: event };
    if (kind === 'prompt')
        payload.prompt = 'Fix resolveUniqueWidget in src/widget.ts';
    else if (kind === 'noop') {
        payload.tool_name = 'Bash';
        payload.tool_input = { command: 'true' };
    }
    else if (kind === 'base-delivery')
        payload.tool_calls = [{ tool_name: 'Read', tool_input: { file_path: join(root, 'src', 'pitfall.ts') }, tool_response: 'export const pool = 1;' }];
    else if (kind === 'anchor-touch')
        payload.tool_calls = [{ tool_name: 'Read', tool_input: { file_path: join(root, 'src', 'widget.ts') }, tool_response: 'function resolveUniqueWidget() {\n return sharedPool;\n}' }];
    else
        payload.tool_calls = [{ tool_name: 'Grep', tool_input: { pattern: kind === 'span' ? 'resolveUniqueWidget' : 'unrelated.*regex', path: root, output_mode: 'content' }, tool_response: kind === 'span' ? 'src/widget.ts:1:function resolveUniqueWidget() {' : 'No matches found' }];
    const preparation = kind === 'anchor-touch' ? invoke(lane, root, 'prompt', id) : null;
    const before = performance.now(), child = spawnSync(lane.exe, ['claude-code', event, '--delivery-trace'], { input: JSON.stringify(payload), encoding: 'utf8', env: lane.env, windowsHide: true, timeout: 10000 });
    const elapsed = performance.now() - before;
    if (child.status !== 0)
        throw Error('hook process failed: ' + child.stderr);
    const phases = {};
    for (const m of child.stderr.matchAll(/delivery phase ([\w-]+) (\d+)/g))
        phases[m[1]] = (phases[m[1]] || 0) + Number(m[2]) / 1e6;
    const reply = JSON.parse(child.stdout);
    return { elapsed, phases, sent: JSON.stringify(reply).includes(kind === 'anchor-touch' || kind === 'base-delivery' ? 'shared pool' : 'src/widget.ts:'), failed: Boolean(preparation?.failed) || /delivery failed:/.test(child.stderr), preparationFailed: Boolean(preparation?.failed), diagnostic: /delivery failed:/.test(child.stderr) ? child.stderr.replace(/delivery phase [\w-]+ \d+\s*/g, '').trim().slice(0, 600) : preparation?.diagnostic };
}
const results = [];
for (const count of counts) {
    const raw = join(work, 'repo-' + count);
    mkdirSync(join(raw, '.git'), { recursive: true });
    mkdirSync(join(raw, '.mex', 'learned'), { recursive: true });
    mkdirSync(join(raw, 'src'), { recursive: true });
    writeFileSync(join(raw, 'src', 'pitfall.ts'), 'export const pool = 1;\n');
    writeFileSync(join(raw, 'src', 'widget.ts'), 'function resolveUniqueWidget() {\n return sharedPool;\n}\n');
    for (let i = 0; i < count; i++) {
        const id = 'mx_timing' + String(i).padStart(4, '0');
        writeFileSync(join(raw, '.mex', 'learned', id + '.md'), `---\nmex:\n  id: ${id}\n  kind: ${i === 0 ? 'rule' : 'pitfall'}\n  scope: ["${i === 0 ? 'src/**' : i === 1 ? 'src/pitfall.ts' : `unused/${i}/**`}"]\n  source: {type: docs, ref: README.md}\n  evidence: docs\n  one_line: Keep the shared pool open.\n  checks: []\n  status: active\n  created: 2026-11-03\n---\nKeep the shared pool open because every request reuses it.\n`);
    }
    const root = canonical(raw), lanes = { base: setup(count, 'base', base, root), current: setup(count, 'current', current, root) };
    for (const kind of arg('--cases', 'prompt,span,silent,noop').split(',')) {
        for (let i = 0; i < 3; i++)
            for (const lane of Object.values(lanes))
                invoke(lane, root, kind, 'warm-' + kind + '-' + i);
        const times = { base: [], current: [] }, deltas = [], sent = { base: 0, current: 0 }, failures = [], phaseSamples = { base: [], current: [] };
        for (let i = 0; i < pairs; i++) {
            const pair = {};
            for (const name of i % 2 ? ['base', 'current'] : ['current', 'base']) {
                const r = invoke(lanes[name], root, kind, kind + '-' + i);
                times[name].push(r.elapsed);
                phaseSamples[name].push(r.phases);
                pair[name] = r.elapsed;
                sent[name] += Number(r.sent);
                if (r.failed)
                    failures.push({ name, pair: i, preparation: r.preparationFailed, reason: r.diagnostic });
            }
            deltas.push(pair.current - pair.base);
        }
        const r = { entries: count, kind, base: distribution(times.base), current: distribution(times.current), added: distribution(deltas), sent, failures, phases: Object.fromEntries(Object.entries(phaseSamples).map(([name, rows]) => [name, Object.fromEntries([...new Set(rows.flatMap(r => Object.keys(r)))].map(key => [key, distribution(rows.map(r => r[key] || 0))]))])) };
        results.push(r);
        console.log(JSON.stringify(r));
    }
}
writeFileSync(join(out, 'answer-timing.json'), JSON.stringify({ definition: 'Alternating cold-process pairs; same synthetic sources, independent homes; failed-open samples retained; surface on forced for measuring actual delivery, not efficacy', results }, null, 2) + '\n');
if (results.some(r => r.failures.length || (['prompt', 'span', 'anchor-touch', 'base-delivery'].includes(r.kind) && r.sent.current !== pairs || r.kind === 'base-delivery' && r.sent.base !== pairs) || (['silent', 'noop'].includes(r.kind) && r.sent.current !== 0)))
    process.exitCode = 1;
