import { expect, it } from 'vitest';
import { shortcutHits } from './leftovers.mjs';
it('counts complete intent shortcut words rather than substrings', () => {
    expect(shortcutHits('Investigate migration and reprojection')).toEqual({ changing: false, reproducing: false, either: false });
    expect(shortcutHits('Rename this and reproduce the failing test')).toEqual({ changing: true, reproducing: true, either: true });
});
