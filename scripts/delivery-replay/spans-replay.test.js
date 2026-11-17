import { expect, it } from 'vitest';
import { spanCoverage } from './spans-replay.mjs';
it('distinguishes a covered read from a definition merely contained in a larger read', () => {
    expect(spanCoverage({ offset: 10, limit: 3 }, { start: 9, end: 13 })).toEqual({ requestedRangeCovered: true, definitionInsideRead: false, overlap: true });
    expect(spanCoverage({ offset: 1, limit: 100 }, { start: 9, end: 13 })).toEqual({ requestedRangeCovered: false, definitionInsideRead: true, overlap: true });
    expect(spanCoverage({ offset: 40, limit: 3 }, { start: 9, end: 13 }).overlap).toBe(false);
});
