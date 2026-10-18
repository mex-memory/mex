#!/usr/bin/env node
/** Offline pilot replay using production composers. No model, API, source checkout or index maintenance.
 * node scripts/context-graph-replay.mjs [--pilot DIR] [--suites DIR] [--scratch DIR]
 *   [--max-hits 60] [--max-files 5] [--read-candidate] [--label baseline]
 * Copies graph/index before opening. Detailed notes and coverage go to scratch, never pilot inputs.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { createServer } from 'vite';

const args = process.argv.slice(2);
const option = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
const pilot = option('--pilot', 'C:/mex-test-tmp/pilot-hooks');
const suites = option('--suites', 'C:/mex-test-tmp/wt-harness/evaluate/arm/suites');
const scratch = resolve(option('--scratch', join(tmpdir(), 'mex-graph-replay')));
const { buildPrompt } = await import(pathToFileURL(join(suites, '..', 'lib', 'session.mjs')).href);
const label = option('--label', args.includes('--read-candidate') ? 'read' : 'baseline');
if (!/^[\w-]+$/.test(label)) throw new Error('Invalid label');
const limits = { hits: Number(option('--max-hits', 60)), files: Number(option('--max-files', 5)) };
mkdirSync(scratch, { recursive: true });
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const server = await createServer({ root: repo, configFile: false, server: { middlewareMode: true }, appType: 'custom' });
const json = p => JSON.parse(readFileSync(p, 'utf8'));
const jsonl = p => existsSync(p) ? readFileSync(p, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse) : [];
const posix = p => p.replace(/\\/g, '/');
const tables = [], details = [], times = [], health = [], warmTimes = [];
try {
  const { openGraphReader } = await server.ssrLoadModule('/src/context/graph-reader.ts');
  const graph = await server.ssrLoadModule('/src/context/hook/graph.ts');
  const events = await server.ssrLoadModule('/src/context/hook/events.ts');
  const { runHook, grepToolHits, bashGrepHits, bashSearchPattern } = await server.ssrLoadModule('/src/context/hook/run.ts');
  const { composePrompt } = await server.ssrLoadModule('/src/context/compose.ts');
  const { liveStateFrom } = await server.ssrLoadModule('/src/context/packet.ts');
  const { decideBudget } = await server.ssrLoadModule('/src/context/hook/budget.ts');
  for (const project of ['hono', 'ts', 'dj']) {
    const suite = json(join(suites, `${project}-hooks.json`));
    for (const file of readdirSync(join(pilot, project, 'runs')).filter(f => f.endsWith('.json')).sort()) {
      const run = json(join(pilot, project, 'runs', file));
      const task = suite.tasks.find(t => t.id === run.taskId);
      if (!task) throw new Error(`No task for ${file}`);
      const prompt = buildPrompt(task, { appendPrompt: suite.appendPrompt ?? null });
      const artifact = join(pilot, project, 'artifacts', run.runId);
      const rows = jsonl(`${artifact}.jsonl`);
      const root = posix(rows.find(r => r.type === 'system' && r.cwd)?.cwd ?? '');
      if (!root) throw new Error(`No root for ${run.runId}`);
      const cache = join(pilot, project, 'index-cache', run.indexKey);
      const copy = join(scratch, 'cache', project, run.indexKey);
      mkdirSync(copy, { recursive: true });
      for (const name of ['graph.db', 'context-index.json', 'build-info.json', 'check-baseline.json']) {
        if (!existsSync(join(copy, name))) copyFileSync(join(cache, name), join(copy, name));
      }
      const index = json(join(copy, 'context-index.json'));
      const { reader, reason } = openGraphReader(copy);
      if (!reader) throw new Error(reason);
      try {
        const logs = jsonl(`${artifact}.context-log.jsonl`);
        const calls = [], pending = new Map();
        for (const row of rows) {
          const content = Array.isArray(row.message?.content) ? row.message.content : [];
          for (const c of content) {
            if (c.type === 'tool_use') { const call = { ...c, turn: calls.length + 1 }; calls.push(call); pending.set(c.id, call); }
            if (c.type === 'tool_result' && pending.has(c.tool_use_id)) {
              Object.assign(pending.get(c.tool_use_id), { response: c.content, result: row.tool_use_result, error: c.is_error === true });
            }
          }
        }
        const rel = path => { const p = posix(path ?? ''); return p.startsWith(root + '/') ? p.slice(root.length + 1) : p; };
        const hitCache = new Map();
        const hitsOf = call => {
          if (hitCache.has(call.id)) return hitCache.get(call.id);
          const payload = { tool_input: call.input, tool_response: call.result ?? call.response };
          let hits = call.name === 'Grep' ? grepToolHits(payload, root) : call.name === 'Bash' ? bashGrepHits(payload, root) : [];
          // Transcript structured results sometimes omit content while their tool_result carries it.
          if (!hits.length) {
            payload.tool_response = typeof call.response === 'string' ? call.response : JSON.stringify(call.response ?? '');
            hits = call.name === 'Grep' ? grepToolHits(payload, root) : call.name === 'Bash' ? bashGrepHits(payload, root) : [];
          }
          hitCache.set(call.id, hits); return hits;
        };
        const opened = new Map();
        const ranges = call => [Math.max(1, call.input.offset ?? 1), (call.input.offset ?? 1) + (call.input.limit ?? Infinity) - 1];
        const isOpened = node => (opened.get(node.file) ?? []).some(([a,b]) => a <= node.end && b >= node.start);
        const gold = task.gold?.code ?? [];
        const isGold = node => gold.some(g => g.path === node.file || g.symbol?.split(/\s+\(/)[0] === node.name);
        const laterUse = (node, turn) => calls.find(call => {
          if (call.turn <= turn || call.error) return false;
          if (call.name === 'Read' && rel(call.input.file_path) === node.file) {
            const [a,b] = ranges(call); return a <= node.end && b >= node.start;
          }
          if (call.name === 'Grep' || call.name === 'Bash') {
            const pattern = call.input.pattern ?? call.input.command ?? '';
            if (pattern.includes(node.name)) return true;
            return hitsOf(call).some(h => h.file === node.file && (h.line === null || (h.line >= node.start && h.line <= node.end)));
          }
          return false;
        });
        const ctx = { projectRoot: root, localDir: join(scratch, 'state', run.runId), index, reader, shown: new Set(), head: null };
        let used = 0, graphChars = 0, useful = 0, noise = 0, neutral = 0, lead = 0, notes = 0, knowledgeChars = 0;
        const coverage = { prompt: 1, read: 0, grep: 0, bash: 0, edit: 0, failed: 0, unmappedEdits: 0 };
        const deliver = (knowledge, note, turn, event) => {
          let out = graph.afterKnowledge(knowledge, note);
          if (!out) return;
          if (out.graphChars && used + out.text.length > 12000) out = knowledge;
          if (!out) return;
          const decision = decideBudget({ used, budget: 12000, text: out.text, pointers: out.pointers ?? [] });
          if (decision.kind !== 'full') {
            if (decision.kind === 'pointers') { used += decision.text.length; knowledgeChars += decision.text.length; }
            return;
          }
          used += out.text.length; graphChars += out.graphChars ?? 0; knowledgeChars += out.text.length - (out.graphChars ?? 0);
          for (const key of out.remember) ctx.shown.add(key);
          if (!out.graphNodes?.length) return;
          notes++;
          const nodes = [...reader.nodes(out.graphNodes).values()];
          const eligible = nodes.filter(n => !isOpened(n));
          const future = eligible.map(n => ({ node: n, later: laterUse(n, turn) })).filter(x => x.later);
          const usefulGold = future.some(x => isGold(x.node));
          // All rendered roots and callers are verified definition locations.
          const usefulDefinition = future.length > 0;
          const good = usefulGold || usefulDefinition;
          const bad = !nodes.some(isGold) && !nodes.some(n => laterUse(n, turn));
          if (good) { useful++; lead = Math.max(lead, Math.max(...future.map(x => x.later.turn - turn - 1))); }
          else if (bad) noise++; else neutral++;
          details.push({ run: run.runId, turn, event, chars: out.graphChars, usefulGold, usefulDefinition, noise: bad,
            nodes: nodes.map(n => ({ id: n.id, name: n.name, file: n.file, start: n.start, end: n.end, gold: isGold(n), opened: isOpened(n), later: laterUse(n, turn)?.turn ?? null })), text: note.text });
        };
        // Use observed prompt gates for existing arms (including semantic); files is a lexical counterfactual.
        let promptKnowledge = null;
        const recordedPrompt = logs.find(l => l.event === 'prompt');
        if (run.arm !== 'files' && recordedPrompt) {
          if (recordedPrompt.chars > 0) promptKnowledge = { text: (recordedPrompt.text ?? '').padEnd(recordedPrompt.chars, ' '), ids: recordedPrompt.ids ?? [], remember: recordedPrompt.ids ?? [] };
        } else {
          const { result } = await composePrompt(index, prompt, { scaffoldRoot: copy, shown: ctx.shown, liveState: entities => liveStateFrom(reader, entities) });
          if (result.packet) promptKnowledge = { text: result.packet, ids: result.injected.map(i => i.id), remember: result.injected.map(i => i.id), pointers: result.injected };
        }
        deliver(promptKnowledge, promptKnowledge ? null : graph.composeGraphPrompt(ctx, prompt), 0, 'prompt');
        for (const call of calls) {
          if (!['Read','Grep','Bash','Edit','Write','MultiEdit'].includes(call.name)) continue;
          const event = call.name === 'Read' ? 'read' : call.name === 'Grep' ? 'grep' : call.name === 'Bash' ? 'bash' : 'edit';
          coverage[event]++;
          if (call.error) { coverage.failed++; continue; }
          let knowledge = null, note = null;
          const t = performance.now();
          if (event === 'read') {
            const file = rel(call.input.file_path);
            const range = ranges(call);
            const old = opened.get(file) ?? []; old.push(range); opened.set(file, old);
            knowledge = events.composeRead(ctx, { ...call.input, file });
            if (args.includes('--read-candidate')) note = graph.composeGraphReadCandidate(ctx, file, call.input.offset, call.input.limit);
          } else if (event === 'grep' || event === 'bash') {
            const hits = hitsOf(call);
            knowledge = events.composeGrep(ctx, hits);
            note = graph.composeGraphSearch(ctx, hits, call.input.pattern ?? bashSearchPattern(call.input.command ?? ''), limits);
          } else {
            const result = call.result ?? {};
            const file = rel(call.input.file_path ?? result.filePath);
            const patches = result.structuredPatch ?? [];
            let diffs = new Map();
            if (patches.length) diffs.set(file, { signature: call.id, ranges: patches.map(p => [p.oldStart, p.oldStart + Math.max(1,p.oldLines) - 1]) });
            else if (result.originalFile && call.input.old_string) {
              const at = result.originalFile.indexOf(call.input.old_string);
              if (at >= 0) { const start = result.originalFile.slice(0, at).split('\n').length; diffs.set(file, { signature: call.id, ranges: [[start, start + call.input.old_string.split('\n').length - 1]] }); }
            }
            if (!diffs.size) coverage.unmappedEdits++;
            knowledge = events.composeEdit(ctx, { diffs });
            note = graph.composeGraphEdit(ctx, diffs);
          }
          times.push({ event, ms: performance.now() - t });
          deliver(knowledge, note, call.turn, event);
          if (args.includes('--warm-latency') && (event === 'read' || event === 'grep')) {
            const warmRoot = join(scratch, 'warm', project, run.indexKey);
            const scaffold = join(warmRoot, '.mex');
            const local = join(scaffold, 'local');
            mkdirSync(local, { recursive: true });
            if (!existsSync(join(scaffold, 'graph.db'))) copyFileSync(join(copy, 'graph.db'), join(scaffold, 'graph.db'));
            if (!existsSync(join(local, 'context-index.json'))) copyFileSync(join(copy, 'context-index.json'), join(local, 'context-index.json'));
            const input = { ...call.input };
            for (const field of ['file_path', 'path']) if (input[field]?.startsWith(root) || input[field]?.startsWith(root.replaceAll('/', '\\'))) input[field] = join(warmRoot, rel(input[field]));
            const response = call.result ?? call.response;
            const raw = JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: call.name, tool_input: input, tool_response: response, cwd: warmRoot });
            await runHook(raw, { cwd: warmRoot, lexical: true });
            for (let repeat = 0; repeat < 3; repeat++) {
              const began = performance.now();
              await runHook(raw, { cwd: warmRoot, lexical: true });
              warmTimes.push({ event, ms: performance.now() - began });
            }
          }
        }
        tables.push({ project, task: task.id, arm: run.arm, useful, noise, neutral, notes, graphChars, totalChars: used, lead, coverage });
        if (project === 'ts' && !health.some(h => h.key === run.indexKey)) {
          const live = liveStateFrom(reader, index.entities);
          const facts = index.entities.filter(e => e.type === 'fact');
          const states = Object.fromEntries(['fresh','changed','missing','unchecked','none'].map(s => [s, facts.filter(e => live(e).health === s).length]));
          const changed = facts.filter(e => live(e).health === 'changed').slice(0, 5).map(e => ({ title: e.title, groundings: e.groundings.map(g => ({ ...g, current: reader.nodes([g.node]).get(g.node)?.bodyHash })) }));
          health.push({ key: run.indexKey, build: json(join(copy,'build-info.json')), states, changed });
        }
      } finally { reader.close(); }
    }
  }
  const quantile = (a, p) => a.sort((x,y) => x-y)[Math.min(a.length-1, Math.floor(a.length*p))] ?? 0;
  const latency = Object.fromEntries(['read','grep','bash','edit'].map(event => { const a = times.filter(t => t.event === event).map(t=>t.ms); return [event, { n: a.length, p50: quantile(a,.5), p95: quantile(a,.95), max: quantile(a,1) }]; }));
  const warmLatency = Object.fromEntries(['read', 'grep'].map(event => { const a = warmTimes.filter(t => t.event === event).map(t=>t.ms); return [event, { n: a.length, p50: quantile(a,.5), p95: quantile(a,.95), max: quantile(a,1) }]; }));
  const result = { warmLatency, methodology: 'Observed knowledge prompt gates for MEX arms; files lexical counterfactual. Production tool composers on copied base snapshots. Read ranges track opened symbols. Lead=max intervening tool calls per session, not causal savings. Definition locations count if later used; noise has neither gold nor later use. No source checkout, API or model. Shell edits and unmapped edits reported, not fabricated.', limits, readCandidate: args.includes('--read-candidate'), sessions: tables, latency, health, notes: details };
  writeFileSync(join(scratch, `replay-${label}.json`), JSON.stringify(result, null, 2));
  let md = '| Task | Arm | Useful | Noise | Neutral | Graph chars | Total chars | Lead |\n|---|---|---:|---:|---:|---:|---:|---:|\n';
  for (const r of tables) md += `| ${r.task} | ${r.arm} | ${r.useful} | ${r.noise} | ${r.neutral} | ${r.graphChars} | ${r.totalChars} | ${r.lead} |\n`;
  writeFileSync(join(scratch, `replay-${label}.md`), md);
  console.log(md); console.log(JSON.stringify({ latency, warmLatency, coverage: tables.map(r=>({task:r.task,arm:r.arm,...r.coverage})) }));
} finally { await server.close(); }
