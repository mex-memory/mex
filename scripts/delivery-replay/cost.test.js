import { expect, it } from 'vitest';
import { analyze, aggregate, parseSession, shellKind } from './cost.mjs';
const call = (id, name, input, context = 100) => ({ type: 'assistant', message: { id, model: 'offline-model', usage: { input_tokens: context, output_tokens: 10 }, content: [{ type: 'tool_use', id, name, input }] } });
const result = (id, text, error = false) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: error }] } });
const fixture = [call('a', 'Grep', { pattern: 'makeWidget' }), result('a', 'src/a.go:12:func makeWidget() {}'), call('b', 'Read', { file_path: 'src/a.go', offset: 10, limit: 5 }), result('b', 'body'), call('c', 'Edit', { file_path: 'src/a.go' }), result('c', 'ok')];
it('prices each response once and measures chains, solved proxy and calls before edit', () => {
    const r = analyze([...fixture.slice(0, 1), fixture[0], ...fixture.slice(1)]);
    expect(r.usage.input).toBe(300);
    expect(r.usage.output).toBe(30);
    expect(r.calls).toBe(3);
    expect(r.weightedTokens).toBe(450);
    expect(r.callsToFirstEdit).toBe(2);
    expect(r.chainedReads).toBe(1);
    expect(r.chainedCost).toBe(150);
    expect(r.explorationCost).toBe(300);
    expect(r.solved).toBe(true);
    expect(aggregate([r]).weightedTokensPerSolvedTask).toBe(450);
    expect(r.dollars).toBe(null);
    expect(r.unknownModels).toEqual(['offline-model']);
    expect(parseSession(fixture).events).toHaveLength(3);
});
it('uses exclusive range ends and never matches across compaction', () => {
    const f = structuredClone(fixture);
    f[2].message.content[0].input.limit = 2;
    expect(analyze(f).chainedReads).toBe(0);
    expect(analyze([fixture[0], fixture[1], { type: 'system', subtype: 'compact_boundary' }, ...fixture.slice(2)]).chainedReads).toBe(0);
});
it('keeps failures unsolved and reports cache TTL classes without double charging', () => {
    const f = structuredClone(fixture);
    f[5].message.content[0].is_error = true;
    expect(analyze(f).solved).toBe(false);
    f[0].message.usage = { input_tokens: 1, cache_creation_input_tokens: 30, cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 20 }, cache_read_input_tokens: 40, output_tokens: 2 };
    expect(parseSession(f).calls[0].weighted).toBe(67.5);
});
it('classifies shell prefixes without splitting quoted operators', () => {
    expect(shellKind('cd repo && rg "a|b" src')).toBe('search');
    expect(shellKind('git grep Widget')).toBe('search');
    expect(shellKind('npm test')).toBe('test');
});
it('preserves cross-model price differences in per-task weighted cost', () => {
    const records = structuredClone(fixture);
    for (const r of records)
        if (r.message?.model)
            r.message.model = 'claude-sonnet-5-5';
    const low = analyze(records);
    for (const r of records)
        if (r.message?.model)
            r.message.model = 'claude-opus-5-5';
    const high = analyze(records);
    expect(high.priceWeightedTokens).toBe(2 * low.priceWeightedTokens);
    expect(aggregate([low, high]).priceWeightedTokensPerSolvedTask).toBe((low.priceWeightedTokens + high.priceWeightedTokens) / 2);
});
it('uses an explicit task outcome before falling back to the edit proxy', () => {
    expect(analyze([...fixture, { type: 'task_outcome', outcome: 'unsolved' }]).solved).toBe(false);
    expect(analyze([], '', 'solved').solved).toBe(true);
});
it('does not chain unrelated files that share a basename', () => {
    const f = structuredClone(fixture);
    f[2].message.content[0].input.file_path = 'other/a.go';
    expect(analyze(f).chainedReads).toBe(0);
});
