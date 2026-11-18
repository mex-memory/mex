/** Budget estimates, not measured tokenizer counts; UTF-8 on both runtimes. */
export const CODE_CHARS_PER_TOKEN = 2.3;
export const PROSE_CHARS_PER_TOKEN = 4;
/** @param {string} text */
export function codeTokens(text) { return Math.ceil(Buffer.byteLength(text, "utf8") * 10 / (CODE_CHARS_PER_TOKEN * 10)); }
/** @param {string} text */
export function proseTokens(text) { return Math.ceil(Buffer.byteLength(text, "utf8") / PROSE_CHARS_PER_TOKEN); }
