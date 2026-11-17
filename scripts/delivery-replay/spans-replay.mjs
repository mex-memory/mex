// Offline opportunity census. Current indexed sources are a snapshot proxy,
// never a claim that a historical definition was identical at the search.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { filesUnder, parseSession, aggregate, analyze } from './cost.mjs';
import { convert } from './convert.mjs';
import { codeTokens } from '../../src/shared/tokens.js';
const norm = s => (s || '').replaceAll('\\', '/').toLowerCase();
export function spanCoverage(read, span) {
    const low = read.offset || 1, high = read.limit ? low + read.limit - 1 : Infinity;
    return { requestedRangeCovered: span.start <= low && span.end >= high,
        definitionInsideRead: low <= span.start && high >= span.end,
        overlap: span.start <= high && span.end >= low };
}
const arg = name => process.argv[process.argv.indexOf(name) + 1];
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const sessions = resolve(arg('--sessions')), binary = resolve(arg('--binary')), directory = resolve(arg('--index'));
    const root = resolve(arg('--source')), output = resolve(arg('--output')), project = arg('--project');
    const reports = [];
    for (const file of filesUnder(sessions).filter(f => /[\\/]replay-lane[12][\\/]/.test(f))) {
        const records = readFileSync(file, 'utf8').split('\n').flatMap(l => { try {
            return [JSON.parse(l)];
        }
        catch {
            return [];
        } });
        const parsed = parseSession(records), firstCwd = records.find(r => r.cwd)?.cwd || root;
        // One normalized result event per original result, so matching by tool input
        // below remains stable even when one assistant response issued parallel tools.
        const candidates = [];
        for (const e of parsed.events) {
            if (e.name !== 'Grep' && !/^(Bash|PowerShell)$/.test(e.name))
                continue;
            const synthetic = [{ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't', name: e.name, input: e.input }] } },
                { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: e.text, is_error: e.error }] } }];
            const ev = convert(synthetic, { session: 'study', project, checkout: root, oldRoot: firstCwd }).find(ev => ev.kind === 'post_tool_batch');
            if (ev)
                candidates.push({ e, ev });
        }
        const result = spawnSync(binary, ['--span-study'], { input: candidates.length ? candidates.map(c => JSON.stringify({ record_directory: directory, event: c.ev })).join('\n') + '\n' : '', encoding: 'utf8', windowsHide: true, timeout: 300000, maxBuffer: 16 << 20 });
        if (result.status !== 0)
            throw Error(result.stderr || 'span peer failed');
        const answers = result.stdout.trim() ? result.stdout.trim().split('\n').map(l => JSON.parse(l) || []) : [];
        const r = { file: file.slice(sessions.length + 1), calls: parsed.calls.filter(c => !c.synthetic).length, firings: 0, signatureOnly: 0, tokens: 0, carriedTokens: 0, carriedWeight: 0, chainReadsCovered: 0, requestedRangesCovered: 0, definitionsInsideRead: 0, chainedReads: analyze(records).chainedReads };
        const covered = new Set(), strict = new Set(), inside = new Set();
        answers.forEach((spans, i) => {
            const e = candidates[i].e;
            if (!Array.isArray(spans))
                throw Error('span peer returned an unsupported shape; build the current binary first');
            for (const span of spans) {
                r.firings++;
                r.signatureOnly += Number(span.signature_only);
                const tokens = codeTokens(span.text) + 8, carry = parsed.calls.slice(e.at).filter(c => !c.synthetic && c.epoch === e.epoch).length;
                r.tokens += tokens;
                r.carriedTokens += tokens * carry;
                r.carriedWeight += carry ? tokens * (2 + .1 * (carry - 1)) : 0;
                for (const [j, read] of parsed.events.entries()) {
                    if (read.name !== 'Read' || read.error || read.input.offset == null || read.epoch !== e.epoch || read.call <= e.call || read.call > e.call + 3)
                        continue;
                    const relative = norm(read.input.file_path).replace(norm(firstCwd).replace(/\/$/, '') + '/', '');
                    if (relative !== norm(span.path))
                        continue;
                    const lines = [...e.text.matchAll(/^(?:[A-Za-z]:)?[^\n]*?:(\d+)[:-]/gm)].map(m => +m[1]);
                    const coverage = spanCoverage(read.input, span);
                    if (coverage.requestedRangeCovered)
                        strict.add(j);
                    if (coverage.definitionInsideRead)
                        inside.add(j);
                    if (coverage.overlap && lines.some(n => n >= span.start && n <= span.end && n >= read.input.offset && n < read.input.offset + (read.input.limit || 2000)))
                        covered.add(j);
                }
            }
        });
        r.chainReadsCovered = covered.size;
        r.requestedRangesCovered = strict.size;
        r.definitionsInsideRead = inside.size;
        reports.push(r);
    }
    const total = key => reports.reduce((n, r) => n + r[key], 0);
    const report = { source: 'current indexed snapshot; historical body identity is unverified', sessions: reports.length, calls: total('calls'), firings: total('firings'), firingsPerSession: total('firings') / reports.length, signatureOnly: total('signatureOnly'), tokens: total('tokens'), carriedTokens: total('carriedTokens'), carriedWeight: total('carriedWeight'), chainedReads: total('chainedReads'), chainReadsCovered: total('chainReadsCovered'), chainCoverageShare: total('chainReadsCovered') / total('chainedReads'), requestedRangesCovered: total('requestedRangesCovered'), definitionsInsideRead: total('definitionsInsideRead'), perSession: reports };
    writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
}
