// Offline, read-only session accounting. No transcript text is emitted.
import fs from 'node:fs';
import { CODE_CHARS_PER_TOKEN, codeTokens } from '../../src/shared/tokens.js';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
export const prices = JSON.parse(fs.readFileSync(new URL('../../src/shared/delivery-prices.json', import.meta.url), 'utf8'));
export const TOOL_CHARS_PER_TOKEN = CODE_CHARS_PER_TOKEN;
// Offline reference rates for Codex models, shared with the budget profile
// (a unit test keeps the two equal). Codex counts cache writes and reads
// inside input when a rollout reports them.
const tier = ({ input, write, read, output }) => [input, write, read, output];
const codexRates = Object.fromEntries(Object.entries(prices.codex.models)
    .map(([model, rates]) => [model, [tier(rates.short), tier(rates.long)]]));
const costClasses = ['input', 'cache_write', 'cache_read', 'output'];
const validCount = (count) => Number.isSafeInteger(count) && count >= 0;

function callDollars(agent, model, counts, longWrite) {
    const [input, write, read, output] = counts;
    if (![...counts, longWrite, write - longWrite].every(validCount)) throw new Error('Invalid token usage');
    if (agent === 'codex' && Object.hasOwn(codexRates, model)) {
        const rates = codexRates[model][Number(input + write + read > prices.codex.longAbove)];
        return counts.map((count, index) => count * rates[index] / 1e6);
    }
    if (agent === 'claude-code' && Object.hasOwn(prices.models, model)) {
        const rate = prices.models[model];
        return [input * rate.input, (write - longWrite) * rate.write5m + longWrite * rate.write1h,
            read * rate.read, output * rate.output].map(value => value / 1e6);
    }
    return null;
}

// Local-record rows already split the input classes. They do not carry cache TTL
// or individual request sizes, so apply the aggregate context and 5-minute rates.
export function priceModelCall({ agent, model, input, cacheWrite, cacheRead, output }) {
    const dollars = callDollars(agent === 'claude' ? 'claude-code' : agent, model, [input, cacheWrite, cacheRead, output], 0);
    return dollars && sum(dollars);
}

export function priceSession(records, agent, { allowUnpriced = false, fallbackModel } = {}) {
    const usage = [0, 0, 0, 0], dollars = [0, 0, 0, 0];
    const unpriced = new Set();
    let reasoning = 0;
    const add = (counts, model = 'unknown', longWrite = 0) => {
        const cost = callDollars(agent, model, counts, longWrite);
        if (!counts.some(Boolean)) return;
        if (!cost) {
            if (!allowUnpriced) throw new Error(`Unknown ${agent === 'codex' ? 'Codex' : 'Claude Code'} price for ${model}`);
            unpriced.add(model);
        }
        for (const [index, count] of counts.entries()) {
            usage[index] += count;
            dollars[index] += cost?.[index] ?? 0;
        }
    };
    if (agent === 'claude-code') {
        for (const { model, synthetic, tokens } of parseSession(records, { validateUsage: true }).calls) {
            if (!synthetic) add([tokens.input, tokens.write1h + tokens.write5m, tokens.read, tokens.output], model, tokens.write1h);
        }
    } else if (agent === 'codex') {
        let model = fallbackModel, previous = [0, 0, 0, 0, 0];
        for (const { type, payload } of records.filter(Boolean)) {
            if (type === 'turn_context' && payload?.model) model = payload.model;
            const snapshot = type === 'event_msg' && payload?.type === 'token_count' && payload.info?.total_token_usage;
            if (!snapshot) continue;
            const total = [snapshot.input_tokens, snapshot.cache_write_input_tokens ?? 0, snapshot.cached_input_tokens,
                snapshot.output_tokens, snapshot.reasoning_output_tokens ?? 0];
            if (!total.every(validCount)) throw new Error('Invalid Codex usage snapshot');
            const delta = total.map((count, index) => count - previous[index]);
            if (!delta.every(validCount)) throw new Error('Codex usage went backwards');
            previous = total;
            const [input, write, read, output, thought] = delta;
            if (thought > output) throw new Error('Codex reasoning exceeds output');
            reasoning += thought;
            add([input - write - read, write, read, output], model);
        }
    } else {
        throw new Error('Unsupported replay agent');
    }
    if (!usage.every(validCount) || !usage.some(Boolean) || !dollars.every(Number.isFinite)) throw new Error('Missing priced usage');
    const classes = Object.fromEntries(costClasses.map((name, index) => [name,
        { tokens: usage[index], dollars: unpriced.size ? null : dollars[index] }]));
    return allowUnpriced ? { classes, reasoning, unpricedModels: [...unpriced].sort() } : classes;
}
const weights = prices.unknown;
export const median = values => values.length ? [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] : null;
const sum = values => values.reduce((a, b) => a + b, 0);
const textOf = c => typeof c === 'string' ? c : Array.isArray(c) ? c.map(x => x.text || '').join('\n') : '';
const norm = s => (s || '').replaceAll('\\', '/').toLowerCase();
const base = s => norm(s).split('/').pop();
const sameFile = (a, b) => a === b || a.endsWith('/' + b) || b.endsWith('/' + a);
export function filesUnder(root) {
    return fs.readdirSync(root, { withFileTypes: true }).flatMap(e => {
        const p = path.join(root, e.name);
        if (e.isSymbolicLink())
            return [];
        return e.isDirectory() ? ['tool-results', 'memory'].includes(e.name) ? [] : filesUnder(p) : e.name.endsWith('.jsonl') ? [p] : [];
    }).sort();
}
// A small shell lexer keeps quoted pipes and semicolons inside their argument.
export function segments(command) {
    return command.match(/(?:[^;&|\n"']|"[^"]*"|'[^']*')+/g) || [];
}
export function shellKind(command) {
    for (const segment of segments(command)) {
        const a = (segment.match(/"[^"]*"|'[^']*'|\S+/g) || []).map(w => w.replace(/^["']|["']$/g, ''));
        while (/^[\w]+=/.test(a[0] || ''))
            a.shift();
        const c = base(a[0]);
        if (!c || /^(cd|set-location|pushd|export|echo|source|\.|timeout|time|env|true|set|sleep|clear)$/.test(c) || c.startsWith('$env:'))
            continue;
        if (/^(cat|head|tail|nl|less|more|bat|type|get-content|gc|awk)$/.test(c) || c === 'sed' && !a.some(w => /^-i/.test(w)))
            return 'read';
        if (/^(grep|egrep|fgrep|rg|ag|ack|findstr|select-string|sls)$/.test(c) || c === 'git' && a[1] === 'grep')
            return 'search';
        if (/^(find|fd|ls|dir|tree|get-childitem|gci|du|wc)$/.test(c))
            return 'list';
        if (c === 'git')
            return /^(log|shortlog|blame)$/.test(a[1]) ? 'git-log' : /^(diff|show)$/.test(a[1]) ? 'git-diff' : 'git-other';
        const s = a.join(' ').toLowerCase();
        if (/\b(go test|npm (run )?test|npx (vitest|jest|mocha)|vitest|jest|pytest|cargo test|hereby test|node --test|dotnet test|bun test|pnpm test|yarn test)\b/.test(s))
            return 'test';
        if (/\b(go (build|vet|run|generate)|tsc|npm run (build|lint|typecheck|format)|hereby (build|lint|format|generate)|eslint|prettier|gofmt|make|cargo (build|check|clippy)|tsgo)\b/.test(s))
            return 'build';
        if (/\b(npm (install|ci|i)|pnpm install|go mod|pip install)\b/.test(s))
            return 'install';
        if (/^mex(\.cmd)?$/.test(c) || c === 'node' && /dist[\\/]cli\.js/.test(s))
            return 'mex';
        return /^(node|python3?|npx|powershell|pwsh)$/.test(c) ? 'script' : 'other';
    }
    return 'other';
}
function claudeTokens(usage, validate) {
    const cc = usage.cache_creation ?? {};
    const write1h = cc.ephemeral_1h_input_tokens ?? 0;
    const write5m = cc.ephemeral_5m_input_tokens ?? ((usage.cache_creation_input_tokens ?? write1h) - write1h);
    const tokens = { input: usage.input_tokens ?? 0, write1h, write5m,
        read: usage.cache_read_input_tokens ?? 0, output: usage.output_tokens ?? 0 };
    if (validate && (!validCount(usage.input_tokens) || !validCount(usage.output_tokens)
        || !Object.values(tokens).every(validCount)
        || (usage.cache_creation_input_tokens != null && usage.cache_creation_input_tokens !== write1h + write5m))) {
        throw new Error('Invalid Claude usage snapshot');
    }
    return tokens;
}

export function parseSession(records, { validateUsage = false } = {}) {
    const calls = [], ids = new Map(), uses = new Map(), events = [], prompts = [];
    let epoch = 0;
    for (const r of records) {
        if (!r) continue;
        if (r.type === 'system' && r.subtype === 'compact_boundary') {
            epoch++;
            continue;
        }
        if (r.isCompactSummary)
            continue;
        const m = r.message;
        if (r.type === 'assistant' && m) {
            const synthetic = m.model === '<synthetic>' || r.isApiErrorMessage === true;
            if (validateUsage && (synthetic || !m.usage)) continue;
            if (validateUsage && (typeof m.id !== 'string' || !m.id)) throw new Error('Claude usage has no message ID');
            const request = r.requestId ?? r.request_id ?? m.request_id ?? '';
            const id = JSON.stringify([m.id || r.uuid, request]);
            if (!ids.has(id)) ids.set(id, calls.length);
            const index = ids.get(id), prior = calls[index];
            if (!prior || m.usage) {
                const tokens = claudeTokens(m.usage ?? {}, validateUsage);
                // Repeated content blocks carry cumulative usage for one response.
                // Prefer the complete snapshot if a lower-output copy appears later.
                if (!prior || tokens.output >= prior.tokens.output) {
                    const price = Object.hasOwn(prices.models, m.model) ? prices.models[m.model] : null;
                    const dollars = price ? sum(Object.keys(weights).map(k => tokens[k] * price[k])) / 1e6 : null;
                    calls[index] = { epoch: prior?.epoch ?? epoch, model: m.model, synthetic, tokens,
                        weighted: sum(Object.keys(weights).map(k => tokens[k] * weights[k])),
                        priceWeighted: dollars === null ? null : dollars * 1e6 / prices.referenceInputUSDPerMillion,
                        dollars, context: tokens.input + tokens.write5m + tokens.write1h + tokens.read };
                }
            }
            for (const b of m.content || [])
                if (b.type === 'tool_use' && !uses.has(b.id))
                    uses.set(b.id, { name: b.name, input: b.input || {}, call: index, epoch });
        }
        else if (r.type === 'user' && m) {
            const content = m.content;
            if (typeof content === 'string' || Array.isArray(content) && !content.some(x => x.type === 'tool_result')) {
                const text = textOf(content);
                if (!r.isMeta && text && !text.startsWith('<'))
                    prompts.push({ text, call: calls.length, epoch });
            }
            else if (Array.isArray(content))
                for (const b of content) {
                    if (b.type !== 'tool_result' || !uses.has(b.tool_use_id))
                        continue;
                    events.push({ ...uses.get(b.tool_use_id), at: calls.length, text: textOf(b.content), error: !!b.is_error });
                }
        }
    }
    return { calls, events, prompts };
}
export function classifySession(folder, session) {
    if (/^replay-lane[12]$/.test(folder))
        return 'coding';
    if (/^setup-scratch|^arm-dj-dj-mex$/.test(folder) || /\b(set up|setup|install|onboard)\b/i.test(session.prompts[0]?.text || ''))
        return 'setup';
    if (session.events.some(e => /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(e.name) && !e.error))
        return 'coding';
    return 'other';
}
export function analyze(records, folder = '', outcome) {
    outcome ??= records.find(r => r.type === 'task_outcome' && ['solved', 'unsolved', 'failed'].includes(r.outcome))?.outcome;
    const session = parseSession(records), { calls, events } = session;
    const real = calls.filter(c => !c.synthetic), byCall = calls.map((_, i) => events.filter(e => e.call === i));
    const firstEdit = events.find(e => /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(e.name) && !e.error)?.call;
    const solved = outcome == null ? firstEdit != null : outcome === 'solved';
    const tools = {}, calibration = [], calibration5k = [], chainCalls = new Set();
    const hits = [];
    let chainedCostPerRead = 0, explorationPriceWeightedCost = 0;
    let chainedReads = 0, rangedReads = 0, floods50 = 0, floods8k = 0, explorationCost = 0;
    const explore = e => /^(Read|Grep|Glob)$/.test(e.name) || /^(Bash|PowerShell)$/.test(e.name) && /^(read|search|list)$/.test(shellKind(e.input.command || ''));
    calls.forEach((c, i) => {
        if (!c.synthetic && byCall[i].length && byCall[i].every(explore)) {
            explorationCost += c.weighted;
            explorationPriceWeightedCost += c.priceWeighted || 0;
        }
        const next = calls[i + 1];
        if (!next || c.synthetic || next.synthetic || c.epoch !== next.epoch)
            return;
        const chars = sum(byCall[i].map(e => e.text.length)), delta = next.context - c.context - c.tokens.output;
        if (delta > 0 && chars > 5000)
            calibration5k.push(chars / delta);
        if (delta > 0 && chars > 20000)
            calibration.push(chars / delta);
    });
    for (const e of events) {
        const kind = /^(Bash|PowerShell)$/.test(e.name) ? `Shell:${shellKind(e.input.command || '')}` : e.name;
        const bucket = tools[kind] ||= { count: 0, callWeight: 0, priceWeightedCallWeight: 0, estimatedTokens: 0, carriedWeight: 0 };
        const tokens = codeTokens(e.text);
        const carry = calls.slice(e.at).filter(c => c.epoch === e.epoch && !c.synthetic).length;
        bucket.count++;
        bucket.estimatedTokens += tokens;
        // Parallel tool calls divide the call cost equally; no double counting.
        bucket.callWeight += calls[e.call].synthetic ? 0 : calls[e.call].weighted / byCall[e.call].length;
        bucket.priceWeightedCallWeight += calls[e.call].synthetic ? 0 : (calls[e.call].priceWeighted || 0) / byCall[e.call].length;
        bucket.carriedWeight += carry ? tokens * (2 + .1 * (carry - 1)) : 0;
        if (e.name === 'Grep' || kind === 'Shell:search') {
            if (e.text.split('\n').length >= 50)
                floods50++;
            if (e.text.length >= 8000)
                floods8k++;
            for (const m of e.text.matchAll(/^((?:[A-Za-z]:)?[^\s:][^:\n]*\.[A-Za-z0-9]+):(\d+)[:-]/gm))
                hits.push({ call: e.call, file: norm(m[1]), line: +m[2], epoch: e.epoch });
        }
        if (e.name === 'Read' && !e.error && e.input.offset != null) {
            rangedReads++;
            const lo = e.input.offset, hi = lo + (e.input.limit || 2000) - 1;
            if (hits.some(h => h.epoch === e.epoch && sameFile(h.file, norm(e.input.file_path)) && h.call < e.call && h.call >= e.call - 3 && h.line >= lo && h.line <= hi)) {
                chainedReads++;
                chainCalls.add(e.call);
                chainedCostPerRead += calls[e.call].weighted;
            }
        }
    }
    return { usage: Object.fromEntries(Object.keys(weights).map(k => [k, sum(real.map(c => c.tokens[k]))])), classification: classifySession(folder, session), solved, calls: real.length, weightedTokens: sum(real.map(c => c.weighted)),
        priceWeightedTokens: real.every(c => c.priceWeighted != null) ? sum(real.map(c => c.priceWeighted)) : null,
        dollars: real.every(c => c.dollars != null) ? sum(real.map(c => c.dollars)) : null,
        unknownModels: [...new Set(real.filter(c => c.dollars == null).map(c => c.model))],
        callsToFirstEdit: firstEdit == null ? null : calls.slice(0, firstEdit).filter(c => !c.synthetic).length,
        explorationCost, explorationPriceWeightedCost, chainedPriceWeightedCost: sum([...chainCalls].map(i => calls[i].priceWeighted || 0)), chainedCostPerRead, chainedCost: sum([...chainCalls].map(i => calls[i].weighted)), chainedReads, rangedReads,
        floods50, floods8k, calibration, calibration5k, tools, typedPrompts: session.prompts.length };
}
export function aggregate(sessions) {
    const total = key => sum(sessions.map(s => s[key]));
    const weightedTokens = total('weightedTokens'), solved = sessions.filter(s => s.solved).length;
    const tools = {};
    for (const s of sessions)
        for (const [key, value] of Object.entries(s.tools)) {
            const bucket = tools[key] ||= { count: 0, callWeight: 0, priceWeightedCallWeight: 0, estimatedTokens: 0, carriedWeight: 0 };
            for (const k of Object.keys(bucket))
                bucket[k] += value[k];
        }
    for (const bucket of Object.values(tools)) {
        bucket.callCostShare = weightedTokens ? bucket.callWeight / weightedTokens : 0;
        bucket.priceWeightedCostShare = sessions.every(s => s.priceWeightedTokens != null) && total("priceWeightedTokens") > 0 ? bucket.priceWeightedCallWeight / total("priceWeightedTokens") : null;
    }
    return { usage: Object.fromEntries(Object.keys(weights).map(k => [k, sum(sessions.map(s => s.usage[k]))])), sessions: sessions.length, calls: total('calls'), solved, weightedTokens,
        priceWeightedTokens: sessions.every(s => s.priceWeightedTokens != null) ? total("priceWeightedTokens") : null,
        priceWeightedTokensPerSession: sessions.length && sessions.every(s => s.priceWeightedTokens != null) ? total("priceWeightedTokens") / sessions.length : null,
        priceWeightedTokensPerSolvedTask: solved && sessions.every(s => s.priceWeightedTokens != null) ? total("priceWeightedTokens") / solved : null,
        priceReference: "price-weighted tokens use the price-table reference dollar rate; weightedTokens are model-normalized input-token equivalents for research parity",
        dollars: sessions.every(s => s.dollars != null) ? total("dollars") : null,
        weightedTokensPerSession: sessions.length ? weightedTokens / sessions.length : null,
        // Unsolved attempts remain in the numerator; success labels can override the edit proxy.
        weightedTokensPerSolvedTask: solved ? weightedTokens / solved : null,
        callsToFirstEditMedian: median(sessions.map(s => s.callsToFirstEdit).filter(n => n != null)),
        explorationCostShare: total('explorationCost') / weightedTokens,
        explorationPriceWeightedShare: sessions.every(s => s.priceWeightedTokens != null) && total('priceWeightedTokens') > 0 ? total('explorationPriceWeightedCost') / total('priceWeightedTokens') : null,
        chainedPriceWeightedShare: sessions.every(s => s.priceWeightedTokens != null) && total('priceWeightedTokens') > 0 ? total('chainedPriceWeightedCost') / total('priceWeightedTokens') : null, chainedCostShare: total('chainedCost') / weightedTokens,
        researchChainCostShare: total('chainedCostPerRead') / weightedTokens,
        chainedReads: total('chainedReads'), rangedReads: total('rangedReads'), chainRate: total('chainedReads') / total('rangedReads'),
        floods50: total('floods50'), floods8k: total('floods8k'),
        calibration: { n: sessions.flatMap(s => s.calibration).length, charsPerTokenMedian: median(sessions.flatMap(s => s.calibration)) },
        calibration5k: { n: sessions.flatMap(s => s.calibration5k).length, charsPerTokenMedian: median(sessions.flatMap(s => s.calibration5k)) }, tools };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    const root = process.argv[2];
    if (!root)
        throw new Error('Usage: node cost.mjs <sessions-root> [output.json]');
    const sessions = filesUnder(root).map(file => ({ file: path.relative(root, file), ...analyze(fs.readFileSync(file, 'utf8').split('\n').flatMap(line => { try {
            return [JSON.parse(line)];
        }
        catch {
            return [];
        } }), path.relative(root, file).split(path.sep)[0]) }));
    const report = { profile: prices.profile, tokenEstimate: TOOL_CHARS_PER_TOKEN, all: aggregate(sessions),
        groups: Object.fromEntries(['coding', 'setup', 'other'].map(k => [k, aggregate(sessions.filter(s => s.classification === k))])),
        researchCoding: aggregate(sessions.filter(s => /^replay-lane[12][\\/]/.test(s.file))), sessions };
    const json = JSON.stringify(report, null, 2) + '\n';
    if (process.argv[3])
        fs.writeFileSync(process.argv[3], json);
    else
        process.stdout.write(json);
}
