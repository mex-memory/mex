import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { codeTokens, proseTokens } from './tokens.js';

it('agrees with the native estimator for prose, code, boundaries and Unicode', () => {
 const texts = ['', 'abcdefghijklmnopqrstuvw', '你好 🧭', 'Use the shared pool.', 'func makeWidget() {\n return 1\n}', ...Array.from({length:100}, (_, i) => 'x'.repeat(i))];
 const peer = spawnSync('go', ['run', '-buildvcs=false', './internal/tokens/cmd'], {cwd:'native',input:JSON.stringify(texts), encoding:'utf8',windowsHide:true,timeout:120000});
 expect(peer.status, peer.stderr).toBe(0);
 expect(JSON.parse(peer.stdout)).toEqual(texts.map(s => [codeTokens(s), proseTokens(s)]));
}, 120000);
