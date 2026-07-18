# Vendored Tree-sitter grammars

The code graph loads these precompiled WebAssembly grammars at runtime. Keep
the source artifact, grammar revision, license, and checksum recorded whenever
a grammar is added or replaced.

## Python

- File: `tree-sitter-python.wasm`
- Binary source: [`tree-sitter-wasms@0.1.12`](https://www.npmjs.com/package/tree-sitter-wasms/v/0.1.12),
  source commit [`df1bed5`](https://github.com/Gregoor/tree-sitter-wasms/commit/df1bed5f46a27c4cb7e707a2c9d15d6979fa48bb)
- Upstream grammar: [`tree-sitter-python` v0.21.0](https://github.com/tree-sitter/tree-sitter-python/tree/v0.21.0),
  commit [`0f9047c`](https://github.com/tree-sitter/tree-sitter-python/commit/0f9047c857ed0990931b1f899c7d3bf403703147)
- Licenses: the prebuilt `tree-sitter-wasms` distribution is
  [Unlicense](https://github.com/Gregoor/tree-sitter-wasms/blob/df1bed5f46a27c4cb7e707a2c9d15d6979fa48bb/LICENSE);
  the Python grammar is [MIT](https://github.com/tree-sitter/tree-sitter-python/blob/v0.21.0/LICENSE)
- SHA-256: `9056d0fb0c337810d019fae350e8167786119da98f0f282aceae7ab89ee8253b`

The checksum matches `out/tree-sitter-python.wasm` in the published
`tree-sitter-wasms@0.1.12` package.
